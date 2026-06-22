/**
 * TYPE CONTRACTS — SCRAPED PROFILE DATA
 * ──────────────────────────────────────
 * Shapes for a recruiter profile and the hiring posts extracted from it.
 * Mirrors the data produced by content/content-profile.js + content-jobs.js
 * in v0.19.0, now expressed as typed contracts.
 */

/** A single hiring signal found on a recruiter's profile. */
export interface HiringPost {
  title: string;
  jobUrl?: string;
  postUrl?: string;
  location?: string;
  companyName?: string;
  /** Where this post was detected. */
  source: 'hiring_badge' | 'activity_post' | 'job_board';
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
