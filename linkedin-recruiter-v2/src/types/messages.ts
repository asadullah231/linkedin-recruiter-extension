/**
 * TYPE CONTRACTS — RUNTIME MESSAGES
 * ──────────────────────────────────
 * Discriminated union for chrome.runtime messages exchanged between the
 * content scripts / popup and the background service worker. Mirrors the
 * `message.action` switch in the v0.19.0 background.js.
 */

import type { RecruiterProfile } from './profile';
import type { JobDetails } from './extraction';
import type { BulkLogEntry } from './state';

/** Options accepted when kicking off a bulk scrape. */
export interface StartBulkOptions {
  /** Base delay (seconds) between profiles. */
  delay?: number;
  /** Open each job in a tab and enrich it. */
  enrichJobs?: boolean;
}

/** Messages the background worker handles. */
export type RuntimeMessage =
  | { action: 'saveProfile'; data: RecruiterProfile }
  | { action: 'jobScraped'; data?: JobDetails | null }
  | { action: 'getProfiles' }
  | { action: 'deleteProfile'; profileUrl: string }
  | { action: 'clearAll' }
  | { action: 'startBulk'; urls: string[]; options?: StartBulkOptions }
  | { action: 'stopBulk' }
  | { action: 'getBulkState' }
  | { action: 'setAutoPull'; enabled: boolean };

/** Snapshot of bulk progress returned by the `getBulkState` message. */
export interface BulkStateSnapshot {
  isRunning: boolean;
  currentIndex: number;
  totalUrls: number;
  log: BulkLogEntry[];
}

/** Live progress message broadcast to the popup during a bulk run. */
export interface BulkProgressMessage {
  action: 'bulkProgress';
  currentIndex: number;
  totalUrls: number;
  isRunning: boolean;
  latestLog: BulkLogEntry;
}
