/**
 * TYPE CONTRACTS — SCRAPED PROFILE DATA
 * ──────────────────────────────────────
 * Shapes for a recruiter profile and the hiring posts extracted from it.
 * Mirrors the data produced by content/content-profile.js + content-jobs.js
 * in v0.19.0, now expressed as typed contracts.
 */

/**
 * Where a hiring post was detected. The content extractors tag each post with
 * the method that found it (see content/content-jobs.js + content-profile.js).
 */
export type HiringPostSource =
  | 'voyager_json'
  | 'voyager_urn_scan'
  | 'hiring_badge'
  | 'inline'
  | 'activity_post'
  | 'recent_activity_fetch'
  | 'urn_scan'
  | 'job_board';

/** A single hiring signal found on a recruiter's profile. */
export interface HiringPost {
  title: string;
  /** LinkedIn numeric job id (or a `text:<title>` dedup key for link-less cards). */
  jobId?: string;
  jobUrl?: string | null;
  postUrl?: string | null;
  location?: string | null;
  /** Canonical company name (voyager / job-scraper). */
  companyName?: string;
  /** Raw company name as scraped from the DOM card (alias of companyName). */
  company?: string | null;
  companyLinkedinUrl?: string | null;
  /** Relative posted-at label ("2 months ago") or epoch from voyager. */
  postedAt?: string | number | null;
  applicants?: number | string | null;
  /** Where this post was detected. */
  source: HiringPostSource;
  /** AI-ranked as the most relevant job for this profile. */
  isTopJob?: boolean;
  /** Detected as a closed/expired listing (filtered out when AI filterClosed is on). */
  isClosed?: boolean;
}

/** A scraped LinkedIn recruiter profile plus its hiring posts. */
export interface RecruiterProfile {
  profileUrl: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  currentCompany?: string;
  followers?: string;
  connections?: string;
  hiringPosts: HiringPost[];
  hiringPostsCount: number;
  /** ISO 8601 timestamp set when the profile was scraped. */
  scrapedAt: string;
  /** True once AI ranking/filtering has run over the hiring posts. */
  enriched?: boolean;
  /** Convenience pointer to the post flagged isTopJob. */
  topJob?: HiringPost;
  /** Team member (n8nSettings.owner) this result is tagged to. */
  owner?: string;
  status?: 'complete' | 'complete_no_jobs' | 'error';
}
