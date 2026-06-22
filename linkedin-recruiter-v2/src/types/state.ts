/**
 * TYPE CONTRACTS — BULK SCRAPE STATE
 * ───────────────────────────────────
 * In-memory state for the bulk scrape queue, mirroring `bulkState` from
 * background/bg-state.js (resets on service worker restart). Includes the
 * circuit-breaker counter (`consecutiveErrors`) added in v0.19.0.
 */

import type { RecruiterProfile } from './profile';
import type { JobDetails } from './extraction';

/** Severity of a bulk log line, used for popup colour coding. */
export type BulkLogLevel = 'info' | 'success' | 'error';

/** A single entry in the live bulk-scrape log feed (shape matches bg-utils.js bulkLog). */
export interface BulkLogEntry {
  /** ISO 8601 timestamp of when the line was emitted. */
  time: string;
  message: string;
  type: BulkLogLevel;
}

/** In-memory state machine for the bulk scrape run. */
export interface BulkState {
  isRunning: boolean;
  /** LinkedIn profile URLs still to process. */
  queue: string[];
  totalUrls: number;
  currentIndex: number;
  /** Base delay (seconds) between profiles. */
  delay: number;
  /** Whether to open each job in a tab and enrich it. */
  enrichJobs: boolean;
  /** Tab currently driving the scrape, or null when idle. */
  activeTabId: number | null;
  /** Resolver for the in-flight profile scrape promise. */
  pendingProfileResolve: ((profile: RecruiterProfile) => void) | null;
  /** Resolver for the in-flight job scrape promise. */
  pendingJobResolve: ((job: JobDetails | null) => void) | null;
  /** Consecutive failures — drives the anti-detection circuit breaker. */
  consecutiveErrors: number;
  log: BulkLogEntry[];
}
