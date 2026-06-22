/**
 * TYPE CONTRACTS — CONTENT-SCRIPT EXTRACTION
 * ────────────────────────────────────────────
 * Shapes produced by the content scripts before they become the canonical
 * stored RecruiterProfile. `ScrapedProfile` is the raw object built by
 * extractProfileData() (a superset of RecruiterProfile), and `JobDetails` is
 * the enrichment payload from the job-page scraper.
 */

import type { RecruiterProfile, HiringPost } from './profile';

/** Voyager `<code>`-tag JSON, narrowed to the fields the extractor reads. */
export interface VoyagerProfile {
  firstName?: string;
  lastName?: string;
  headline?: string;
  locationName?: string;
  geoLocationName?: string;
  publicIdentifier?: string | null;
  summary?: string;
  profilePicture?: string | null;
}

export interface VoyagerData {
  profile: VoyagerProfile | null;
  currentCompany: {
    name?: string;
    url?: string;
    industry?: string;
    employeeCountRange?: unknown;
  } | null;
  currentPosition: { title?: string; companyName?: string } | null;
  hiringPosts: HiringPost[];
}

/** Intermediate DOM-scraped identity fields (all best-effort / optional). */
export interface DomData {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  location?: string | null;
  about?: string | null;
  currentCompany?: string | null;
  currentCompanyUrl?: string | null;
  profilePic?: string | null;
  followers?: string | null;
  connections?: string | null;
  hasHiringBadge?: boolean;
  isOpenToWork?: boolean;
  isVerified?: boolean;
}

/**
 * Raw object returned by extractProfileData(). Extends the canonical profile
 * with the extra identity/debug fields the content script captures.
 */
export interface ScrapedProfile extends RecruiterProfile {
  publicIdentifier?: string | null;
  location?: string | null;
  about?: string | null;
  profilePic?: string | null;
  currentCompanyUrl?: string | null;
  currentJobTitle?: string | null;
  hasHiringBadge?: boolean;
  isOpenToWork?: boolean;
  isVerified?: boolean;
  /** Debug: whether voyager JSON contributed to the result. */
  _voyagerExtracted?: boolean;
  _extractionMethod?: 'voyager+dom' | 'dom-only';
}

/** Enrichment payload from the job-page scraper (job-scraper entrypoint). */
export interface JobDetails {
  jobId: string | null;
  jobUrl: string;
  scrapedAt: string;
  title?: string | null;
  companyName?: string | null;
  companyLinkedinUrl?: string;
  location?: string | null;
  applicantsCount?: string;
  postedAt?: string;
  seniorityLevel?: string;
  employmentType?: string;
  jobFunction?: string;
  industries?: string;
  jobDescription?: string | null;
  salary?: string;
  companyDescription?: string | null;
  companySize?: string;
  companyWebsite?: string;
}
