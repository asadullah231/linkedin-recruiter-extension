/**
 * POPUP — CSV builders (job-centric + profile-centric) and email guesser.
 * Typed port of the buildJobsCsv / buildProfilesCsv / guessEmail helpers from
 * popup.js. Reuses pickTopJob from the background exporter (no duplication).
 */
import { pickTopJob } from '@/background/exporter';
import type { RecruiterProfile, HiringPost } from '@/types/profile';
import type { JobDetails } from '@/types/extraction';

/** A stored job may carry enrichment fields merged in from the job-scraper. */
type StoredJob = HiringPost & Partial<JobDetails>;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return `"${s}"`;
}

export function guessEmail(profile: RecruiterProfile, job: StoredJob): string {
  if (!profile.firstName || !profile.lastName) return '';
  const company = job.companyName || job.company || profile.currentCompany || '';
  if (!company && !job.companyLinkedinUrl) return '';

  let domain: string | null = null;

  if (job.companyWebsite) {
    const m = job.companyWebsite.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)/i);
    if (m) domain = m[1].toLowerCase();
  }
  if (!domain && job.companyLinkedinUrl) {
    const m = job.companyLinkedinUrl.match(/\/company\/([^/?#]+)/);
    if (m) domain = m[1].toLowerCase().replace(/[^a-z0-9-]/g, '') + '.com';
  }
  if (!domain && company) {
    const cleaned = company
      .toLowerCase()
      .replace(/\s+(europe|emea|gmbh|inc|ltd|llc|corp|company|co\.|sa|ag|se|kg|group)$/i, '')
      .replace(/[^a-z0-9]/g, '');
    if (cleaned) domain = cleaned + '.com';
  }
  if (!domain) return '';

  const first = profile.firstName.toLowerCase().replace(/[^a-z]/g, '');
  const last = profile.lastName.toLowerCase().replace(/[^a-z]/g, '');
  return `${first}.${last}@${domain}`;
}

/** One row per profile — the minimal job-centric format. */
export function buildJobsCsv(profiles: RecruiterProfile[]): string {
  const headers = [
    'Job URL', 'Email (guessed)', 'Company LinkedIn URL', 'Company Name',
    'Job Poster Name', 'First Name', 'Last Name', 'Job Poster Profile URL',
    'Job Title', 'Job Location', 'Source', 'Post URL', 'Total Jobs',
  ];
  const rows = [headers.map(csvEscape).join(',')];

  for (const profile of profiles) {
    const posts = (profile.hiringPosts || []) as StoredJob[];
    if (posts.length === 0) continue;

    const job = (pickTopJob(posts) || posts[0]) as StoredJob;
    const email = guessEmail(profile, job);
    const row = [
      job.jobUrl || '',
      email || '',
      job.companyLinkedinUrl || '',
      job.companyName || job.company || profile.currentCompany || '',
      profile.fullName || '',
      profile.firstName || '',
      profile.lastName || '',
      profile.profileUrl || '',
      job.title || '',
      job.location || '',
      job.source || 'hiring_badge',
      job.postUrl || '',
      posts.length,
    ];
    rows.push(row.map(csvEscape).join(','));
  }
  return rows.join('\n');
}

/** One row per recruiter. */
export function buildProfilesCsv(profiles: RecruiterProfile[]): string {
  const headers = [
    'fullName', 'firstName', 'lastName', 'headline', 'location',
    'currentCompany', 'profileUrl', 'followers', 'connections', 'hasHiringBadge',
    'hiringPostsCount', 'profilePic', 'about', 'isVerified', 'enriched',
    'hiringJobsList', 'scrapedAt',
  ] as const;

  const rows = [headers.map(csvEscape).join(',')];

  for (const p of profiles) {
    const record = p as RecruiterProfile & Record<string, unknown>;
    const hiringList = (p.hiringPosts || [])
      .map((j) => `${j.title || ''} (${j.location || 'N/A'})`)
      .join(' | ');

    const row = headers.map((h) => (h === 'hiringJobsList' ? hiringList : record[h] ?? ''));
    rows.push(row.map(csvEscape).join(','));
  }
  return rows.join('\n');
}
