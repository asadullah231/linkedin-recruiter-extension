/**
 * BACKGROUND — SHARED STATE
 * ──────────────────────────
 * Typed port of background/bg-state.js. The in-memory bulk-scrape state is a
 * single mutable object shared by every background module.
 *
 * NOTE: unlike the old service worker (which reassigned the global `bulkState`
 * wholesale), ES module imports are read-only bindings. So instead of swapping
 * the object, `resetBulkState()` mutates it in place — every importer keeps
 * pointing at the same live reference.
 */

import type { BulkState } from '../types/state';
import type { StartBulkOptions } from '../types/messages';

/** Live bulk-scrape state. Resets (in place) on each new run. */
export const bulkState: BulkState = {
  isRunning: false,
  queue: [],
  totalUrls: 0,
  currentIndex: 0,
  delay: 7,
  enrichJobs: true,
  activeTabId: null,
  pendingProfileResolve: null,
  pendingJobResolve: null,
  consecutiveErrors: 0,
  log: [],
};

/** Reset the shared state in place for a fresh bulk run. */
export function resetBulkState(urls: string[], options: StartBulkOptions): void {
  bulkState.isRunning = true;
  bulkState.queue = urls;
  bulkState.totalUrls = urls.length;
  bulkState.currentIndex = 0;
  bulkState.delay = options.delay ?? 10; // 10s default — safer against LinkedIn detection
  bulkState.enrichJobs = options.enrichJobs !== false;
  bulkState.activeTabId = null;
  bulkState.pendingProfileResolve = null;
  bulkState.pendingJobResolve = null;
  bulkState.consecutiveErrors = 0;
  bulkState.log = [];
}
