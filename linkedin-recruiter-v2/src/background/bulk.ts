/**
 * BACKGROUND — BULK SCRAPE ORCHESTRATOR
 * ──────────────────────────────────────
 * Typed port of background/bg-bulk.js. startBulkScrape() seeds the shared
 * state and kicks off runBulkQueue(), which walks the URL queue: scrape each
 * profile, (optionally) enrich jobs, stream the result to n8n, then
 * post-process (closed-job filter + AI ranking) at the end.
 *
 * Anti-detection (pacing, circuit breaker, session cap) lives in anti-detect.ts;
 * this file just calls into it.
 */

import { bulkState, resetBulkState } from './state';
import { bulkLog, shortUrl, sleep, updateBadge } from './utils';
import { scrapeProfileInTab, scrapeJobInTab } from './scraper';
import { streamProfileToN8n } from './n8n';
import { filterClosedJobs, rankTopJobsWithAI } from './ai';
import { computeDelay, maybeCircuitBreak, sessionGuard } from './anti-detect';
import { saveProfile, deleteProfile } from '../utils/storage';
import { getAiSettings, getN8nSettings, updateN8nSettings } from '../utils/settings';
import type { StartBulkOptions } from '../types/messages';

export interface StartBulkResult {
  started?: boolean;
  totalUrls?: number;
  error?: string;
}

export async function startBulkScrape(
  urls: string[],
  options: StartBulkOptions,
): Promise<StartBulkResult> {
  if (bulkState.isRunning) {
    return { error: 'Bulk scrape already in progress' };
  }

  resetBulkState(urls, options);

  bulkLog(`🚀 Starting bulk scrape: ${urls.length} profiles (delay: ${bulkState.delay}s)`, 'info');

  // Run async (don't await — caller should not block)
  void runBulkQueue().catch((err) => {
    bulkLog(`💥 Fatal error: ${(err as Error).message}`, 'error');
    bulkState.isRunning = false;
  });

  return { started: true, totalUrls: urls.length };
}

export async function runBulkQueue(): Promise<void> {
  let savedCount = 0;
  let skippedCount = 0;

  // ── SW KEEPALIVE: ping every 25s so service worker never sleeps mid-batch ──
  chrome.alarms.create('sw-keepalive', { periodInMinutes: 25 / 60 });

  for (let i = 0; i < bulkState.queue.length; i++) {
    if (!bulkState.isRunning) {
      bulkLog(`⏹ Stopped at ${i}/${bulkState.queue.length}`, 'error');
      break;
    }

    // ── SESSION GUARD: stop cleanly if we've hit the per-window profile cap ──
    if (!(await sessionGuard.enforce())) {
      bulkLog(`⏹ Session cap reached — stopping at ${i}/${bulkState.queue.length}`, 'error');
      bulkState.isRunning = false;
      break;
    }

    bulkState.currentIndex = i;
    const url = bulkState.queue[i];
    bulkLog(`[${i + 1}/${bulkState.queue.length}] ${shortUrl(url)}`, 'info');
    // Count this profile view against the rolling session window.
    await sessionGuard.record();

    let hadJobs = false;
    try {
      const profileData = await scrapeProfileInTab(url);

      if (!profileData) {
        bulkLog(`  ⚠️ No data — likely auth/private`, 'error');
        skippedCount++;
        bulkState.consecutiveErrors++;
      } else {
        const name = profileData.fullName || 'Unknown';
        const jobsCount = profileData.hiringPosts?.length || 0;

        // ── SKIP profiles with 0 hiring jobs (don't save, no delay) ──
        if (jobsCount === 0) {
          bulkLog(`  ⏭ ${name} — 0 jobs, skipping`, 'info');
          // Delete the auto-save (saveProfile triggered when content.js posted)
          await deleteProfile(url);
          skippedCount++;
          bulkState.consecutiveErrors = 0; // data returned = LinkedIn not blocking us
          // 🔁 Stream: tell n8n this URL is done with no jobs (mark complete in NocoDB)
          streamProfileToN8n({
            profileUrl: url,
            status: 'complete_no_jobs',
            scrapedAt: new Date().toISOString(),
          }).catch(() => {});
        } else {
          bulkLog(`  ✅ ${name} — ${jobsCount} hiring jobs`, 'success');
          hadJobs = true;
          savedCount++;
          bulkState.consecutiveErrors = 0; // success → reset circuit breaker

          // Optional enrichment (off by default for speed)
          if (bulkState.enrichJobs && profileData.hiringPosts) {
            for (let j = 0; j < profileData.hiringPosts.length; j++) {
              if (!bulkState.isRunning) break;
              const job = profileData.hiringPosts[j];
              if (!job.jobUrl) continue;
              bulkLog(`    → Enrich ${j + 1}/${profileData.hiringPosts.length}`, 'info');
              try {
                const jobDetails = await scrapeJobInTab(job.jobUrl);
                if (jobDetails) Object.assign(job, jobDetails);
              } catch {
                /* keep going */
              }
              if (bulkState.isRunning) await sleep(2000 + Math.random() * 1500);
            }
            profileData.enriched = true;
            await saveProfile(profileData);
          }

          // 🔁 Stream: push this single profile's result to n8n NOW
          try {
            await streamProfileToN8n(profileData);
            bulkLog(`    📤 Pushed to NocoDB`, 'success');
          } catch (err) {
            bulkLog(`    ⚠️ Push failed: ${(err as Error).message.substring(0, 60)}`, 'error');
          }
        }
      }
    } catch (err) {
      bulkLog(`  ❌ ${(err as Error).message.substring(0, 60)}`, 'error');
      skippedCount++;
      bulkState.consecutiveErrors++;
    }

    // ── CIRCUIT BREAKER: LinkedIn rate-limit / block detection (see anti-detect.ts) ──
    if (await maybeCircuitBreak(bulkState.consecutiveErrors)) {
      bulkState.consecutiveErrors = 0;
    }

    // ── SMART DELAY (see anti-detect.ts) ──
    // Heavy path (had jobs) honours the user's base delay floored at the safe
    // minimum; light path (empty profile) gets a short random pause.
    if (i < bulkState.queue.length - 1 && bulkState.isRunning) {
      const wait = computeDelay(hadJobs, bulkState.delay * 1000);
      if (hadJobs) {
        bulkLog(`  ⏱ Waiting ${Math.round(wait / 1000)}s...`, 'info');
      }
      await sleep(wait);
    }
  }

  // ── Close the reused tab when batch is fully done ──
  if (bulkState.activeTabId) {
    chrome.tabs.remove(bulkState.activeTabId).catch(() => {});
    bulkState.activeTabId = null;
  }

  // ── Stop keepalive alarm ──
  chrome.alarms.clear('sw-keepalive');

  bulkState.isRunning = false;
  bulkLog(`✅ Done! Saved ${savedCount}, skipped ${skippedCount} of ${bulkState.totalUrls}`, 'success');

  try {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Bulk Scrape Complete',
      message: `Saved ${savedCount} profiles with hiring jobs (${skippedCount} skipped)`,
    });
  } catch {
    /* notifications optional */
  }

  // ── Filter closed jobs (before AI ranking) ──
  try {
    const aiSettings = await getAiSettings();
    if (aiSettings.filterClosed) {
      bulkLog('🚫 Filtering out closed jobs...', 'info');
      const stats = await filterClosedJobs();
      bulkLog(`🚫 Removed ${stats.removed} closed jobs (kept ${stats.kept})`, 'success');
    }
  } catch (err) {
    bulkLog(`⚠️ Closed-job filter error: ${(err as Error).message}`, 'error');
  }

  // ── AI top-job ranking (before n8n send) ──
  try {
    const aiSettings = await getAiSettings();
    if (aiSettings.enabled && aiSettings.apiKey) {
      bulkLog('🤖 AI ranking top jobs per profile...', 'info');
      await rankTopJobsWithAI(aiSettings);
      bulkLog('✅ AI ranking complete.', 'success');
    }
  } catch (err) {
    bulkLog(`⚠️ AI ranking error: ${(err as Error).message}`, 'error');
  }

  // ── BATCH XLSX FLOW DISABLED ──
  // Profiles are now pushed live to /webhook/profile-done as they finish.
  bulkLog(`📊 Streaming mode: ${savedCount} profile(s) pushed live to NocoDB.`, 'info');

  try {
    const n8nSettings = await getN8nSettings();
    // ── stop-after-batch: disable auto-pull when batch completes ──
    if (n8nSettings.autoPull && n8nSettings.stopAfterBatch !== false) {
      chrome.alarms.clear('auto-pull');
      await updateN8nSettings({ autoPull: false });
      bulkLog('⏹ Stop-after-batch triggered — auto-pull DISABLED.', 'info');
      void updateBadge();
    }
  } catch (err) {
    bulkLog(`⚠️ n8n callback error: ${(err as Error).message}`, 'error');
  }
}
