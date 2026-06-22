/**
 * CONTENT SCRIPT — HIRING POSTS / JOBS EXTRACTION
 * ────────────────────────────────────────────────
 * Typed port of content/content-jobs.js. Entry point is
 * extractHiringPosts(voyagerData), called from extractProfileData().
 * Finds a recruiter's open roles via: voyager seed → hiring banner + modal →
 * inline links → activity posts → background URL fetch → raw-HTML URN sweep.
 */

import { q, qq, sleep, extractPublicIdentifier } from '../utils/content-utils';
import type { HiringPost } from '../types/profile';
import type { VoyagerData } from '../types/extraction';

// ═══════════════════════════════════════════════════════════════════════
// HIRING POSTS EXTRACTOR
// ═══════════════════════════════════════════════════════════════════════

export async function extractHiringPosts(voyagerData: VoyagerData): Promise<HiringPost[]> {
  const posts: HiringPost[] = [];

  // Method 1: voyager <code>-tag seed (don't return — later methods enrich it).
  if (voyagerData?.hiringPosts?.length > 0) {
    console.log('🟢 LRI: Voyager seeded', voyagerData.hiringPosts.length, 'job(s) — enriching');
    const seen = new Set<string>();
    for (const j of voyagerData.hiringPosts) {
      if (j.jobId && !seen.has(j.jobId)) {
        seen.add(j.jobId);
        posts.push(j);
      }
    }
  }

  // Method 2: hiring banner & "Show N jobs" modal
  console.log('🟢 LRI: Looking for hiring banner...');
  const hiringBanner = findHiringBanner();

  if (hiringBanner) {
    console.log('🟢 LRI: Found hiring banner. text(0..120):', (hiringBanner.innerText || '').substring(0, 120));

    // Quick win: direct /jobs/view/<id> links in the banner
    const directJobLinks = hiringBanner.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]');
    if (directJobLinks.length > 0) {
      console.log(`🟢 LRI: Banner has ${directJobLinks.length} direct job link(s) — extracting without modal`);
      const seen = new Set<string>();
      for (const link of directJobLinks) {
        const idMatch = link.href.match(/\/jobs\/view\/(\d+)/);
        const jobId = idMatch?.[1];
        if (!jobId || seen.has(jobId)) continue;
        seen.add(jobId);
        const card = link.closest<HTMLElement>('li, article, div') || hiringBanner;
        const titleEl = card.querySelector<HTMLElement>('h3, h4, [class*="title"], strong') || link;
        const title = (titleEl.innerText || link.innerText || '').trim().split('\n')[0];
        if (title && title.length > 3) {
          posts.push({
            jobId,
            title: title.substring(0, 200),
            company: card.querySelector<HTMLElement>('[class*="company"], [class*="subtitle"]')?.innerText?.trim().split('\n')[0] || null,
            location: null,
            postedAt: null,
            jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
            source: 'hiring_badge',
          });
        }
      }
    }

    if (posts.length > 0) {
      console.log(`🟢 LRI: Got ${posts.length} job(s) directly from banner — skipping modal`);
    }

    const showJobsLink = posts.length === 0 ? findShowJobsLink(hiringBanner) : null;

    if (showJobsLink) {
      console.log('🟢 LRI: Clicking show jobs link...');
      // React-friendly click: dispatch a real MouseEvent chain
      try {
        (['mousedown', 'mouseup', 'click'] as const).forEach((type) => {
          showJobsLink.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }),
          );
        });
      } catch (e) {
        console.warn('🟡 LRI: MouseEvent dispatch failed, falling back to .click()', e);
        showJobsLink.click();
      }

      const modal = await waitForModal();
      if (modal) {
        console.log('🟢 LRI: Modal appeared, waiting for jobs to load...');
        await waitForModalContent(modal);
        const extracted = extractJobsFromModal(modal);
        console.log(`🟢 LRI: Extracted ${extracted.length} jobs from modal`);
        posts.push(...extracted);
        closeModal(modal);
      } else {
        console.warn('⚠️ LRI: Modal did not appear after click');
      }
    }
  }

  // Method 3: inline job links on profile (no modal needed)
  if (posts.length === 0) {
    console.log('🟢 LRI: Trying inline job links fallback...');
    const allJobLinks = qq<HTMLAnchorElement>('a[href*="/jobs/view/"]');
    const seen = new Set<string>();
    for (const link of allJobLinks) {
      const idMatch = link.href.match(/\/jobs\/view\/(\d+)/);
      const jobId = idMatch ? idMatch[1] : null;
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const card = link.closest<HTMLElement>('li, article, div');
      const title = link.innerText?.trim() || card?.querySelector<HTMLElement>('h3, h4')?.innerText?.trim();
      if (title && title.length > 3) {
        posts.push({
          jobId,
          title: title.replace(/\s+/g, ' ').trim(),
          company: card?.querySelector<HTMLElement>('[class*="company"]')?.innerText?.trim() || null,
          location: card?.querySelector<HTMLElement>('[class*="location"]')?.innerText?.trim() || null,
          postedAt: card?.querySelector<HTMLElement>('time, [class*="date"]')?.innerText?.trim() || null,
          jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
          source: 'inline',
        });
      }
    }
  }

  // Backfill source for any post that slipped through without one
  for (const p of posts) {
    if (!p.source) p.source = 'hiring_badge';
  }

  // Method 4: recent activity posts (last 15)
  try {
    const activityJobs = await extractFromActivityPosts();
    if (activityJobs.length > 0) {
      const existingIds = new Set(posts.map((p) => p.jobId));
      const newJobs = activityJobs.filter((j) => !existingIds.has(j.jobId));
      posts.push(...newJobs);
      console.log(`🟢 LRI: Added ${newJobs.length} jobs from activity posts (after dedup)`);
    }
  } catch (err) {
    console.warn('⚠️ LRI: Activity posts scan failed:', (err as Error).message);
  }

  // Method 5.5: background fetch of the recruiter's hiring-posts URLs
  if (hiringBanner || posts.length === 0) {
    const slug = extractPublicIdentifier(window.location.href);
    console.log('🟢 LRI: Running URL fallbacks — current posts:', posts.length, 'slug:', slug);

    if (slug) {
      const showLink =
        q<HTMLAnchorElement>('a[href*="recent-activity"], a[href*="hiring"]') ||
        qq('a, button').find((el) => /show\s+\d*\s*jobs?|see\s+\d*\s*jobs?/i.test(el.innerText || ''));

      const candidateUrls = [
        `https://www.linkedin.com/in/${slug}/recent-activity/jobs/`,
        `https://www.linkedin.com/in/${slug}/recent-activity/all/`,
        showLink?.getAttribute('href')
          ? new URL(showLink.getAttribute('href')!, window.location.origin).href
          : null,
      ].filter(Boolean) as string[];

      const seen = new Set<string>();
      const patterns = [
        /urn:li:(?:fsd_)?(?:jobPosting|jobs):(\d{6,})/g,
        /\/jobs\/view\/(\d{6,})/g,
        /["']jobPostingId["']\s*:\s*["']?(\d{6,})/g,
      ];

      for (const url of candidateUrls) {
        try {
          console.log('🟢 LRI: Trying fetch →', url);
          const res = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
          console.log('🟢 LRI:   ↳ HTTP', res.status, 'final URL:', res.url);
          if (!res.ok) continue;
          const html = await res.text();
          const before = seen.size;
          for (const rx of patterns) {
            let m: RegExpExecArray | null;
            while ((m = rx.exec(html)) !== null) seen.add(m[1]);
          }
          console.log('🟢 LRI:   ↳ found', seen.size - before, 'new job IDs (total', seen.size + ')');
          if (seen.size > 0) break;
        } catch (err) {
          console.warn('🟡 LRI:   ↳ fetch failed:', (err as Error).message);
        }
      }

      const existingIds = new Set(posts.map((p) => p.jobId).filter(Boolean));
      let added = 0;
      for (const id of seen) {
        if (existingIds.has(id)) continue;
        posts.push({
          jobId: id,
          title: '(title unavailable — enrich step will fill it)',
          company: null,
          location: null,
          postedAt: null,
          jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
          source: 'recent_activity_fetch',
        });
        added++;
      }
      if (added > 0) {
        console.log(`🟢 LRI: URL-fetch added ${added} NEW job(s) (total now ${posts.length})`);
      } else if (seen.size > 0) {
        console.log(`🟢 LRI: URL-fetch found ${seen.size} ID(s) — all already in posts`);
      }
    }
  }

  // Method 5 (last resort): raw page HTML URN sweep
  if (hiringBanner || posts.length === 0) {
    console.log('🟢 LRI: Running raw HTML scan — current posts:', posts.length);
    try {
      try {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(800);
        window.scrollTo(0, 0);
        await sleep(300);
      } catch {
        /* scrolling optional */
      }

      const html = document.documentElement.outerHTML;
      const seen = new Set<string>();
      let m: RegExpExecArray | null;

      const urnRx = /urn:li:(?:fsd_)?(?:jobPosting|jobs):(\d{6,})/g;
      while ((m = urnRx.exec(html)) !== null) seen.add(m[1]);

      const viewRx = /\/jobs\/view\/(\d{6,})/g;
      while ((m = viewRx.exec(html)) !== null) seen.add(m[1]);

      const cardRx = /["']jobPostingId["']\s*:\s*["']?(\d{6,})/g;
      while ((m = cardRx.exec(html)) !== null) seen.add(m[1]);

      const existingIds = new Set(posts.map((p) => p.jobId).filter(Boolean));
      let added = 0;
      for (const id of seen) {
        if (existingIds.has(id)) continue;
        posts.push({
          jobId: id,
          title: '(title unavailable — enrich step will fill it)',
          company: null,
          location: null,
          postedAt: null,
          jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
          source: 'urn_scan',
        });
        added++;
      }

      if (added > 0) {
        console.log(`🟢 LRI: Raw HTML scan added ${added} NEW job(s) (total now ${posts.length})`);
      } else if (posts.length === 0) {
        console.log('🟢 LRI: No job IDs found anywhere in page HTML — profile likely has no active hiring posts');
      }
    } catch (err) {
      console.warn('⚠️ LRI: Raw HTML scan failed:', (err as Error).message);
    }
  }

  return posts;
}

// ═══════════════════════════════════════════════════════════════════════
// METHOD 4: Activity / Recent Posts scan
// ═══════════════════════════════════════════════════════════════════════

async function extractFromActivityPosts(): Promise<HiringPost[]> {
  const posts: HiringPost[] = [];
  const seen = new Set<string>();
  const MAX_POSTS_TO_SCAN = 15;

  console.log('🟢 LRI: Scanning Activity / Recent Posts...');

  const allSections = qq('section, div[class*="activity"], div[class*="feed"]');
  let activitySection: HTMLElement | null = null;

  for (const sec of allSections) {
    const heading = sec.querySelector<HTMLElement>('h2, h3, [class*="header"], [class*="title"]');
    const headingText = (heading?.innerText || sec.innerText || '').trim().toLowerCase();
    if (/^activity$|^posts$|^recent activity|^featured/i.test(headingText.substring(0, 50))) {
      activitySection = sec;
      break;
    }
  }

  if (!activitySection) {
    const containers = qq('[class*="profile-creator"], [class*="activity-feed"], [class*="recent-activity"]');
    if (containers.length > 0) activitySection = containers[0];
  }

  if (!activitySection) {
    console.log('🟢 LRI: No activity section found');
    return posts;
  }

  const postElements = activitySection.querySelectorAll<HTMLElement>(
    'li, article, div[class*="feed-shared"], div[class*="update-components"], div[class*="post"]',
  );

  let scannedCount = 0;
  for (const post of postElements) {
    if (scannedCount >= MAX_POSTS_TO_SCAN) break;
    scannedCount++;

    const jobLinks = post.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]');
    if (jobLinks.length === 0) continue;

    for (const link of jobLinks) {
      const idMatch = link.href.match(/\/jobs\/view\/(\d+)/);
      const jobId = idMatch?.[1];
      if (!jobId || seen.has(jobId)) continue;
      seen.add(jobId);

      const title = (
        link.innerText?.trim() ||
        post.querySelector<HTMLElement>('h2, h3, h4, [class*="title"]')?.innerText?.trim() ||
        'Untitled job'
      )
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 250);

      const postLinkEl = post.querySelector<HTMLAnchorElement>('a[href*="/posts/"], a[href*="/feed/update"]');

      posts.push({
        jobId,
        title,
        company: post.querySelector<HTMLElement>('[class*="company"], [class*="actor-name"]')?.innerText?.trim() || null,
        location: null,
        postedAt: post.querySelector<HTMLElement>('time, [class*="date"], [class*="time-since"]')?.innerText?.trim() || null,
        jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
        postUrl: postLinkEl?.href || null,
        source: 'activity_post',
      });
    }
  }

  console.log(`🟢 LRI: Activity scan: scanned ${scannedCount} posts, found ${posts.length} job links`);
  return posts;
}

// ═══════════════════════════════════════════════════════════════════════
// HIRING POSTS HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function findHiringBanner(): HTMLElement | null {
  const candidates = qq('div, section, a');
  for (const el of candidates) {
    const text = (el.innerText || '').trim();
    if (text.length > 800 || text.length < 5) continue;
    if (
      text.match(/^Hiring:/i) ||
      text.match(/\bis hiring\b/i) ||
      text.match(/\bShow\s+(\d+\s+)?jobs?\b/i) ||
      text.match(/\b(\d+)\s+open roles?\b/i) ||
      text.match(/\b(\d+)\s+active hiring posts?\b/i) ||
      text.match(/^See\s+(\d+\s+)?jobs?\b/i) ||
      text.match(/\bView\s+(\d+\s+)?(?:open\s+)?jobs?\b/i)
    ) {
      return el;
    }
  }
  return null;
}

function findShowJobsLink(banner: HTMLElement): HTMLElement | null {
  const allClickables = banner.querySelectorAll<HTMLElement>('a, button, [role="button"], [tabindex="0"]');
  for (const el of allClickables) {
    const text = (el.innerText || '').trim();
    if (
      text.match(/^show\s+(\d+\s+)?jobs?$/i) ||
      text.match(/^see\s+(all|more)\s+jobs?$/i) ||
      text.match(/^view\s+(all|jobs?)/i)
    ) {
      return el;
    }
  }
  if (banner.tagName === 'A' || banner.tagName === 'BUTTON' || banner.getAttribute('role') === 'button') {
    return banner;
  }
  for (const el of allClickables) {
    const href = (el as HTMLAnchorElement).href;
    if (href && /\/jobs\//.test(href)) return el;
  }
  return null;
}

async function waitForModal(timeout = 5000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const modal =
      q('div[role="dialog"]') ||
      q('.artdeco-modal') ||
      q('[data-test-modal]') ||
      q('.modal__content') ||
      qq('div').find((d) => {
        const txt = d.innerText || '';
        return txt.includes('Open roles') && txt.includes('hiring');
      }) ||
      null;
    if (modal) {
      const hasContent = modal.innerText && modal.innerText.length > 50;
      if (hasContent) return modal;
    }
    await sleep(200);
  }
  return null;
}

async function waitForModalContent(modal: HTMLElement, timeout = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hasJobLinks = modal.querySelectorAll('a[href*="/jobs/"]').length > 0;
    const hasMultipleJobCards = modal.querySelectorAll('li, [class*="job"], [class*="card"]').length >= 2;
    const text = modal.innerText || '';
    const looksLoaded = text.length > 200 && (hasJobLinks || hasMultipleJobCards);
    if (looksLoaded) {
      await sleep(500);
      return true;
    }
    await sleep(200);
  }
  return false;
}

function extractJobsFromModal(modal: HTMLElement): HiringPost[] {
  const posts: HiringPost[] = [];
  const seen = new Set<string>();

  // Strategy 1: job view links
  const jobLinks = modal.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"], a[href*="/jobs/"]');
  for (const link of jobLinks) {
    const job = parseJobFromLink(link);
    if (job && job.jobId && !seen.has(job.jobId)) {
      seen.add(job.jobId);
      posts.push(job);
    }
  }

  // Strategy 2: text-based cards
  if (posts.length === 0) {
    const cards = modal.querySelectorAll<HTMLElement>('li, [class*="card"], [class*="result"], [class*="entity"]');
    for (const card of cards) {
      const text = (card.innerText || '').trim();
      if (text.length < 20 || text.length > 500) continue;

      const titleEl =
        card.querySelector<HTMLElement>('h1, h2, h3, h4, strong, [class*="title"]') || card.querySelector<HTMLElement>('a');
      const title = titleEl?.innerText?.trim();
      if (!title || title.length < 3 || title.length > 200) continue;

      const companyEl = card.querySelector<HTMLElement>('[class*="company"], [class*="subtitle"]');
      const locationEl = card.querySelector<HTMLElement>('[class*="location"], [class*="metadata"]');
      const dateEl = card.querySelector<HTMLElement>('time, [class*="date"], [class*="posted"]');

      const linkInCard = card.querySelector<HTMLAnchorElement>('a[href*="/jobs/"]');
      let jobId: string | null = null;
      if (linkInCard) {
        const m = linkInCard.href.match(/\/jobs\/(?:view|details)\/(\d+)/);
        if (m) jobId = m[1];
      }
      if (!jobId) jobId = `text:${title.substring(0, 50)}`;
      if (seen.has(jobId)) continue;
      seen.add(jobId);

      posts.push({
        jobId,
        title: title.replace(/\s+/g, ' ').trim(),
        company: companyEl?.innerText?.trim() || null,
        location: locationEl?.innerText?.trim() || null,
        postedAt: dateEl?.innerText?.trim() || null,
        jobUrl: linkInCard?.href || null,
        source: 'hiring_badge',
      });
    }
  }

  // Strategy 3: parse the modal text manually
  if (posts.length === 0) {
    const text = modal.innerText || '';
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2 || lines.length > 6) continue;

      const title = lines[0];
      if (title.length < 3 || title.match(/^(open roles|hiring|close)/i)) continue;

      const jobId = `text:${title.substring(0, 50)}`;
      if (seen.has(jobId)) continue;
      seen.add(jobId);

      posts.push({
        jobId,
        title,
        company: lines[1] || null,
        location: lines[2] || null,
        postedAt: lines.find((l) => l.match(/(month|year|day|week|hour)s?\s+ago/i)) || null,
        jobUrl: null,
        source: 'hiring_badge',
      });
    }
  }

  return posts;
}

function parseJobFromLink(link: HTMLAnchorElement): HiringPost | null {
  const href = link.href || '';
  const idMatch = href.match(/\/jobs\/(?:view|details)\/(\d+)/);
  const jobId = idMatch ? idMatch[1] : null;
  if (!jobId) return null;

  let title: string | null = null;
  let company: string | null = null;
  let location: string | null = null;
  let date: string | null = null;
  let companyLinkedinUrl: string | null = null;

  // ── Company LinkedIn URL ──
  const card = link.closest<HTMLElement>('li, article, [class*="card"], [class*="entity"]') || link.parentElement;
  const companyLink =
    card?.querySelector<HTMLAnchorElement>('a[href*="/company/"]') ||
    link.querySelector<HTMLAnchorElement>('a[href*="/company/"]');
  if (companyLink) {
    const m = companyLink.getAttribute('href')?.match(/\/company\/([^/?#]+)/);
    if (m) {
      companyLinkedinUrl = `https://www.linkedin.com/company/${m[1]}/`;
      const cText = companyLink.innerText?.trim();
      if (cText && cText.length > 1 && cText.length < 100) company = cText;
    }
  }

  // ── Strategy A: structured children ──
  const titleEl = link.querySelector<HTMLElement>('h1, h2, h3, h4, h5, strong, [class*="title"]:not([class*="subtitle"])');
  if (titleEl) {
    const t = titleEl.innerText?.trim();
    if (t && t.length > 3 && t.length < 200) title = t;
  }

  // ── Strategy B: class-hint selectors ──
  if (!company) {
    const c = link.querySelector<HTMLElement>('[class*="company"], [class*="subtitle"]')?.innerText?.trim();
    if (c && c.length < 150) company = c;
  }
  if (!location) {
    const l = link.querySelector<HTMLElement>('[class*="location"], [class*="caption"], [class*="metadata"]')?.innerText?.trim();
    if (l && l.length < 150) location = l;
  }
  if (!date) {
    const d = link.querySelector<HTMLElement>('time, [class*="date"], [class*="posted"], [class*="listed"]')?.innerText?.trim();
    if (d && d.length < 80) date = d;
  }

  // ── Strategy C: walk leaf children positionally ──
  if (!title || !company || !location) {
    const allDivs = link.querySelectorAll<HTMLElement>('div, span, p');
    const textElements = Array.from(allDivs).filter((el) => {
      const t = el.innerText?.trim();
      return !!t && t.length > 2 && t.length < 200 && !el.querySelector('div, p') && !t.match(/^view\s+job$/i);
    });

    const seenText = new Set<string>();
    const uniqueTexts: string[] = [];
    for (const el of textElements) {
      const t = el.innerText.trim().replace(/\s+/g, ' ');
      if (!seenText.has(t)) {
        seenText.add(t);
        uniqueTexts.push(t);
      }
    }

    if (!title && uniqueTexts[0]) title = uniqueTexts[0];
    if (!company && uniqueTexts[1]) company = uniqueTexts[1];
    if (!location && uniqueTexts[2]) location = uniqueTexts[2];
    if (!date && uniqueTexts[3]) date = uniqueTexts[3];
  }

  // ── Strategy D: parse innerText if still missing fields ──
  if (!title || title === company) {
    const fullText = link.innerText?.trim() || '';
    const lines = fullText.split('\n').map((l) => l.trim()).filter((l) => l && !l.match(/^view\s+job$/i));

    if (lines.length >= 1 && (!title || title.length < 3)) title = lines[0];
    if (lines.length >= 2 && !company) company = lines[1];
    if (lines.length >= 3 && !location) location = lines[2];
    if (lines.length >= 4 && !date) date = lines[3];

    if (lines.length === 1 && lines[0]) {
      const parsed = parseConcatenatedJobText(lines[0]);
      if (parsed.title) title = parsed.title;
      if (parsed.company && !company) company = parsed.company;
      if (parsed.location && !location) location = parsed.location;
    }
  }

  if (!title || title.length < 3) return null;

  if (!date || !date.match(/(month|year|day|week|hour)s?\s+ago|^\d/i)) {
    const text = link.innerText || '';
    const dateMatch = text.match(/(\d+\s+(?:month|year|day|week|hour)s?\s+ago)/i);
    if (dateMatch) date = dateMatch[1];
  }

  return {
    jobId,
    title: title.replace(/\s+/g, ' ').trim(),
    company: company?.replace(/\s+/g, ' ').trim() || null,
    companyLinkedinUrl,
    location: location?.replace(/\s+/g, ' ').trim() || null,
    postedAt: date?.replace(/\s+/g, ' ').trim() || null,
    jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
    source: 'hiring_badge',
  };
}

/**
 * Concatenated text parser:
 * "ESS Solutions Engineer - Finland Sungrow Europe Helsinki (On-site) View job"
 * Pattern: {Title} {Company} {City (Mode)} View job
 */
function parseConcatenatedJobText(text: string): {
  title: string | null;
  company: string | null;
  location: string | null;
} {
  const result: { title: string | null; company: string | null; location: string | null } = {
    title: null,
    company: null,
    location: null,
  };
  const cleaned = text.replace(/\s*(View\s+job|Apply\s+now|See\s+more)\s*$/i, '').trim();

  const locMatch = cleaned.match(
    /^(.+?)\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s,&'.\-]+?\s*\((?:On-site|Hybrid|Remote(?:\s*work)?)\))\s*$/i,
  );
  if (locMatch) {
    const beforeLoc = locMatch[1].trim();
    result.location = locMatch[2].trim();

    const companySuffixMatch = beforeLoc.match(/^(.+?)\s+([A-Z][\w&]+(?:\s+[A-Z][\w&]+){0,3})$/);
    if (companySuffixMatch) {
      result.title = companySuffixMatch[1].trim();
      result.company = companySuffixMatch[2].trim();
    } else {
      result.title = beforeLoc;
    }
  } else {
    result.title = cleaned;
  }

  return result;
}

function closeModal(modal: HTMLElement): void {
  const closeBtn =
    modal.querySelector<HTMLElement>('button[aria-label*="Dismiss" i]') ||
    modal.querySelector<HTMLElement>('button[aria-label*="close" i]') ||
    modal.querySelector<HTMLElement>('.artdeco-modal__dismiss') ||
    modal.querySelector<HTMLElement>('button.artdeco-button--circle') ||
    modal.querySelector('svg[data-test-icon="close"]')?.closest<HTMLElement>('button');
  if (closeBtn) {
    closeBtn.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
  }
}
