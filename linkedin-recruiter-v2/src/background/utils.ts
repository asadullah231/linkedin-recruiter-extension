/**
 * BACKGROUND — HELPERS, LOGGING, BADGE, URL EXTRACTION
 * ─────────────────────────────────────────────────────
 * Typed port of background/bg-utils.js.
 */

import { bulkState } from './state';
import { getN8nSettings } from '../utils/settings';
import type { BulkLogLevel } from '../types/state';
import type { PullUrlResponse } from '../types/n8n';
import type { BulkProgressMessage } from '../types/messages';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function shortUrl(url: string): string {
  const m = url.match(/\/in\/([^/?]+)/);
  return m ? '/in/' + m[1] : url.substring(0, 60);
}

/**
 * Parse a variety of n8n payload shapes down to a clean, de-duplicated list of
 * LinkedIn profile URLs (used by the auto-pull alarm).
 */
export function extractUrls(data: PullUrlResponse): string[] {
  let items: unknown[] = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.urls)) items = data.urls;
  else if (Array.isArray(data?.data)) items = data.data;
  else if (Array.isArray(data?.items)) items = data.items;

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let url: string | null = null;
    if (typeof item === 'string') {
      url = item;
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      // Try every common variant — case-insensitive last-resort
      const candidate =
        rec['Profile URL'] ?? rec.profileUrl ?? rec.url ??
        rec['LinkedIn-Profile'] ?? rec.linkedinUrl ??
        rec.ProfileURL ?? rec.ProfileUrl ?? rec['Profile Url'] ??
        rec.profile_url ?? rec['profile-url'];
      if (typeof candidate === 'string') url = candidate;
      if (!url) {
        // Fallback: scan ALL string fields for a LinkedIn URL
        for (const k of Object.keys(rec)) {
          const v = rec[k];
          if (typeof v === 'string' && /linkedin\.com\/in\//i.test(v)) {
            url = v;
            break;
          }
        }
      }
    }
    if (!url) continue;
    const m = String(url).match(/https?:\/\/[\w.]*linkedin\.com\/in\/[^\s,"'<>]+/i);
    if (m) {
      const clean = m[0].replace(/\/$/, '');
      if (!seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    }
  }
  return urls;
}

// ═══════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════

export function bulkLog(message: string, type: BulkLogLevel = 'info'): void {
  const entry = { time: new Date().toISOString(), message, type };
  bulkState.log.push(entry);
  if (bulkState.log.length > 200) bulkState.log = bulkState.log.slice(-100);
  console.log(`[BULK] ${message}`);

  // Update extension icon badge with progress
  void updateBadge();

  // Notify popup if open
  const progress: BulkProgressMessage = {
    action: 'bulkProgress',
    currentIndex: bulkState.currentIndex,
    totalUrls: bulkState.totalUrls,
    isRunning: bulkState.isRunning,
    latestLog: entry,
  };
  chrome.runtime.sendMessage(progress).catch(() => {}); // Popup may not be open
}

export async function updateBadge(): Promise<void> {
  try {
    if (bulkState.isRunning) {
      // Show "X/Y" or just current index
      const txt = `${bulkState.currentIndex + 1}/${bulkState.totalUrls}`;
      chrome.action.setBadgeText({
        text: txt.length > 4 ? `${bulkState.currentIndex + 1}` : txt,
      });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // orange = scraping
      chrome.action.setTitle({
        title: `🔄 Scraping ${bulkState.currentIndex + 1} of ${bulkState.totalUrls}...`,
      });
    } else {
      const n8nSettings = await getN8nSettings();
      if (n8nSettings.autoPull) {
        chrome.action.setBadgeText({ text: 'ON' });
        chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green = auto-pull armed
        chrome.action.setTitle({ title: '🤖 Auto-pull ON — checking n8n every 30s' });
      } else {
        chrome.action.setBadgeText({ text: '' });
        chrome.action.setTitle({ title: 'LinkedIn Recruiter Intelligence' });
      }
    }
  } catch (err) {
    console.error('Badge update error:', err);
  }
}
