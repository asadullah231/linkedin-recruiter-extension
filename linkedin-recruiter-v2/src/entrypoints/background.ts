/**
 * BACKGROUND SERVICE WORKER — ENTRY POINT
 * ────────────────────────────────────────
 * Typed WXT port of background.js. All real logic lives in ../background/*.ts
 * modules (proper ES imports — no more importScripts shared-global scope).
 *
 * Responsibilities kept here: register the chrome.* event listeners
 * (messages, alarms, install/startup) and wire them to the modules.
 */

import { bulkState } from '../background/state';
import { bulkLog, updateBadge, extractUrls } from '../background/utils';
import { saveProfile, getAllProfiles, deleteProfile, profileStore } from '../utils/storage';
import { startBulkScrape } from '../background/bulk';
import { sessionGuard } from '../background/anti-detect';
import {
  getN8nSettings,
  updateN8nSettings,
  getAiSettings,
  updateAiSettings,
  N8N_PULL_URL,
} from '../utils/settings';
import type { RuntimeMessage, BulkStateSnapshot } from '../types/messages';

export default defineBackground(() => {
  console.log('🟢 LRI Background v0.20.0 (WXT) loaded');

  // ═══════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER
  // ═══════════════════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    switch (message.action) {
      case 'saveProfile':
        saveProfile(message.data)
          .then((result) => {
            // If bulk mode is running, also resolve the pending promise
            if (bulkState.isRunning && bulkState.pendingProfileResolve) {
              bulkState.pendingProfileResolve(message.data);
              bulkState.pendingProfileResolve = null;
            }
            sendResponse({ success: true, result });
          })
          .catch((err) => sendResponse({ success: false, error: (err as Error).message }));
        return true;

      case 'jobScraped':
        // Job page extracted data — used during bulk enrichment
        if (bulkState.pendingJobResolve) {
          bulkState.pendingJobResolve(message.data ?? null);
          bulkState.pendingJobResolve = null;
        }
        sendResponse({ success: true });
        return true;

      case 'getProfiles':
        getAllProfiles()
          .then((profiles) => sendResponse({ success: true, profiles }))
          .catch((err) => sendResponse({ success: false, error: (err as Error).message }));
        return true;

      case 'deleteProfile':
        deleteProfile(message.profileUrl)
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: (err as Error).message }));
        return true;

      case 'clearAll':
        profileStore.setValue({}).then(() => {
          chrome.action.setBadgeText({ text: '' });
          sendResponse({ success: true });
        });
        return true;

      case 'startBulk':
        startBulkScrape(message.urls, message.options || {})
          .then((result) => sendResponse({ success: true, ...result }))
          .catch((err) => sendResponse({ success: false, error: (err as Error).message }));
        return true;

      case 'stopBulk':
        bulkState.isRunning = false;
        bulkLog('⏹ Stopped by user', 'error');
        sendResponse({ success: true });
        return true;

      case 'getBulkState': {
        const state: BulkStateSnapshot = {
          isRunning: bulkState.isRunning,
          currentIndex: bulkState.currentIndex,
          totalUrls: bulkState.totalUrls,
          log: bulkState.log.slice(-30),
        };
        sendResponse({ success: true, state });
        return true;
      }

      case 'setAutoPull':
        if (message.enabled) {
          chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
          console.log('🤖 Auto-pull ENABLED (every 30s)');
        } else {
          chrome.alarms.clear('auto-pull');
          console.log('🛑 Auto-pull DISABLED');
        }
        void updateBadge();
        sendResponse({ success: true });
        return true;

      default:
        return false;
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO-PULL — periodic check for new URLs from n8n
  // ═══════════════════════════════════════════════════════════════════════
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    // ── SW KEEPALIVE: waking up prevents the worker sleeping mid-batch ──
    if (alarm.name === 'sw-keepalive') {
      console.log('💓 SW keepalive tick');
      return;
    }

    if (alarm.name !== 'auto-pull') return;
    if (bulkState.isRunning) {
      console.log('🤖 Auto-pull skipped: scrape already running');
      return;
    }

    try {
      const n8nSettings = await getN8nSettings();
      if (!n8nSettings.autoPull) return;
      if (!n8nSettings.owner) {
        console.warn('🤖 Auto-pull skipped: Team ID (owner) not set');
        return;
      }

      // ── SESSION GUARD: don't start a new batch if the rolling cap is hit ──
      // (enforce() disarms auto-pull + logs a warning when it returns false.)
      if (!(await sessionGuard.enforce())) {
        console.warn('🤖 Auto-pull halted: session profile cap reached');
        return;
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (n8nSettings.apiKey) headers['Authorization'] = `Bearer ${n8nSettings.apiKey}`;

      // ── Scope the pull to THIS teammate only (multi-tenant) ──
      const pullUrl = `${N8N_PULL_URL}?owner=${encodeURIComponent(n8nSettings.owner)}`;
      const res = await fetch(pullUrl, { method: 'GET', headers });
      if (!res.ok) {
        console.log(`🤖 Auto-pull HTTP ${res.status}`);
        return;
      }

      const data = await res.json();
      const urls = extractUrls(data);

      if (urls.length === 0) {
        console.log('🤖 Auto-pull: no pending URLs');
        return;
      }

      console.log(`🤖 Auto-pull: ${urls.length} valid URLs → starting scrape`);
      await startBulkScrape(urls, { delay: 7, enrichJobs: false });
    } catch (err) {
      console.error('🤖 Auto-pull error:', err);
    }
  });

  // Re-arm alarm on service worker startup — only if user has Auto Mode ON
  chrome.runtime.onStartup.addListener(async () => {
    const n8nSettings = await getN8nSettings();
    if (n8nSettings.autoPull) {
      chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
      console.log('🤖 Auto-pull re-armed on startup');
    } else {
      console.log('⏸ Auto-pull paused on startup (user OFF)');
    }
  });

  // ── Install: seed default settings + badge ──
  chrome.runtime.onInstalled.addListener(async () => {
    const n8nSettings = await getN8nSettings();
    // Behaviour flags are fixed; autoPull stays user-controlled (default OFF first install).
    await updateN8nSettings({
      stopAfterBatch: true,
      autoPull: n8nSettings.autoPull ?? false,
    });

    const aiSettings = await getAiSettings();
    await updateAiSettings({ filterClosed: aiSettings.filterClosed ?? true });

    if ((await getN8nSettings()).autoPull) {
      chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
      console.log('🤖 Auto-pull re-armed (user had it ON)');
    } else {
      chrome.alarms.clear('auto-pull');
      console.log('⏸ Auto-pull paused (default / user OFF)');
    }

    // Init badge from saved profile count
    const profiles = await getAllProfiles();
    if (profiles.length > 0) {
      chrome.action.setBadgeText({
        text: profiles.length > 99 ? '99+' : String(profiles.length),
      });
      chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
    }
  });
});
