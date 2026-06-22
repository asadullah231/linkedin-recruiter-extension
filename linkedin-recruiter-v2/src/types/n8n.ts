/**
 * TYPE CONTRACTS — n8n WEBHOOK PAYLOADS
 * ──────────────────────────────────────
 * Request/response shapes for the n8n integration, mirroring background/
 * bg-n8n.js (streamProfileToN8n / sendBulkResultsToN8n) and the pull-URL
 * parser in popup.js (extractUrlsFromN8nPayload).
 */

import type { RecruiterProfile } from './profile';

/** POSTed to N8N_PROFILE_DONE_URL once per scraped profile (live NocoDB update). */
export interface ProfileDonePayload {
  source: 'linkedin-recruiter-extension';
  version: string;
  /** Team member who scraped this, for result tagging. */
  owner: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  profile: RecruiterProfile;
}

/** Run metadata included with a bulk results upload. */
export interface BulkResultMeta {
  source: 'linkedin-recruiter-extension';
  version: string;
  timestamp: string;
  saved: number;
  skipped: number;
  total: number;
  profileUrls: string[];
}

/** JSON body sent to the callback URL when no XLSX blob could be built. */
export interface BulkResultJsonPayload extends BulkResultMeta {
  run: {
    saved: number;
    skipped: number;
    total: number;
  };
  profiles: RecruiterProfile[];
}

/**
 * One item in a pull-URL response. The parser accepts bare strings or objects
 * with the profile URL under any of several known keys (or any string field
 * containing a linkedin.com/in/ URL as a fallback).
 */
export type PullUrlItem =
  | string
  | ({
      'Profile URL'?: string;
      profileUrl?: string;
      url?: string;
      'LinkedIn-Profile'?: string;
      linkedinUrl?: string;
      profile_url?: string;
    } & Record<string, unknown>);

/**
 * Shape of a pull-URL webhook response. May be a bare array or an object
 * wrapping the items under `urls`, `data`, or `items`.
 */
export type PullUrlResponse =
  | PullUrlItem[]
  | { urls?: PullUrlItem[]; data?: PullUrlItem[]; items?: PullUrlItem[] };
