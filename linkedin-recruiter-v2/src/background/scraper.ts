/**
 * BACKGROUND — TAB MANAGEMENT / SCRAPING
 * ───────────────────────────────────────
 * Typed port of background/bg-scrape.js. Opens (and reuses) background tabs,
 * waits for them to load, triggers the content script's save flow, and waits
 * for the resulting message via bulkState.pendingProfileResolve /
 * pendingJobResolve (fired by the message handler in the background entrypoint).
 */

import { bulkState } from './state';
import { sleep } from './utils';
import type { RecruiterProfile } from '../types/profile';
import type { JobDetails } from '../types/extraction';

/** Filename of the built job-scraper script, injected for job enrichment (see M4 entrypoint). */
const JOB_SCRAPER_FILE = 'job-scraper.js';

export async function scrapeProfileInTab(
  url: string,
): Promise<RecruiterProfile | null> {
  return new Promise((resolve) => {
    // ── TAB REUSE: don't close tab on resolve — we navigate it to the next URL ──
    const timeout = setTimeout(() => {
      bulkState.pendingProfileResolve = null;
      resolve(null);
    }, 60000); // 60s max

    bulkState.pendingProfileResolve = (data) => {
      clearTimeout(timeout);
      // NOTE: we do NOT remove the tab here — it gets reused for next profile
      resolve(data);
    };

    void (async () => {
      try {
        // ── Reuse existing tab if still alive, else create a fresh one ──
        let tabId = bulkState.activeTabId;
        if (tabId) {
          try {
            await chrome.tabs.get(tabId); // throws if tab was closed
            await chrome.tabs.update(tabId, { url }); // navigate instead of new tab
          } catch {
            tabId = null; // tab gone — fall through to create
          }
        }
        if (!tabId) {
          const tab = await chrome.tabs.create({ url, active: false });
          tabId = tab.id ?? null;
          bulkState.activeTabId = tabId;
        }
        if (!tabId) {
          clearTimeout(timeout);
          bulkState.pendingProfileResolve = null;
          resolve(null);
          return;
        }

        // Wait for page to load + content script to inject
        await waitForTabComplete(tabId, 30000);
        await sleep(2000); // SPA + voyager data loads faster than the old 4s

        // Trigger save — wait for button to actually appear (up to 5s extra)
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            return new Promise<string>((res) => {
              const tryClick = (attempts: number) => {
                const btn = document.getElementById('lri-save-button');
                if (btn) {
                  btn.click();
                  return res('clicked');
                }
                if (attempts <= 0) return res('timeout');
                setTimeout(() => tryClick(attempts - 1), 300);
              };
              tryClick(16); // up to 4.8s extra wait
            });
          },
        });

        // Wait for pendingProfileResolve to be called by the saveProfile message
      } catch {
        clearTimeout(timeout);
        bulkState.pendingProfileResolve = null;
        resolve(null);
      }
    })();
  });
}

export async function scrapeJobInTab(
  jobUrl: string,
): Promise<JobDetails | null> {
  return new Promise((resolve) => {
    let tabId: number | null = null;
    const timeout = setTimeout(() => {
      if (tabId) chrome.tabs.remove(tabId).catch(() => {});
      bulkState.pendingJobResolve = null;
      resolve(null);
    }, 30000);

    bulkState.pendingJobResolve = (data) => {
      clearTimeout(timeout);
      if (tabId) {
        const id = tabId;
        setTimeout(() => chrome.tabs.remove(id).catch(() => {}), 500);
      }
      resolve(data);
    };

    void (async () => {
      try {
        const tab = await chrome.tabs.create({ url: jobUrl, active: false });
        tabId = tab.id ?? null;
        if (!tabId) throw new Error('no tab id');

        await waitForTabComplete(tabId, 20000);
        await sleep(2000);

        // Inject job-scraper (which auto-extracts and posts a `jobScraped` message)
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [JOB_SCRAPER_FILE],
        });
      } catch {
        clearTimeout(timeout);
        bulkState.pendingJobResolve = null;
        if (tabId) chrome.tabs.remove(tabId).catch(() => {});
        resolve(null);
      }
    })();
  });
}

export async function waitForTabComplete(
  tabId: number,
  timeoutMs = 20000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
