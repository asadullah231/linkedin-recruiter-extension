/**
 * JOB PAGE SCRAPER — unlisted script (WXT)
 * ─────────────────────────────────────────
 * Typed port of job-scraper.js. Injected by the background scraper into a
 * /jobs/view/<id> tab; extracts full job data and posts a `jobScraped`
 * message. Built to `job-scraper.js` so background scraper.ts can inject it.
 */

import { q, qq } from '../utils/content-utils';
import type { JobDetails } from '../types/extraction';
import type { RuntimeMessage } from '../types/messages';

export default defineUnlistedScript(() => {
  const w = window as typeof window & { __lriJobScraperLoaded?: boolean };
  if (w.__lriJobScraperLoaded) return;
  w.__lriJobScraperLoaded = true;

  console.log('🟢 LRI Job Scraper loaded on:', window.location.href);

  // Wait for content to settle, then send data
  setTimeout(() => {
    try {
      const jobData = extractJobData();
      const message: RuntimeMessage = { action: 'jobScraped', data: jobData };
      chrome.runtime.sendMessage(message);
      console.log('🟢 LRI: Job extracted', jobData);
    } catch (err) {
      console.error('LRI Job Scraper error:', err);
      const message: RuntimeMessage = { action: 'jobScraped', data: null };
      chrome.runtime.sendMessage(message);
    }
  }, 2500);

  function extractJobData(): JobDetails {
    const url = window.location.href;
    const idMatch = url.match(/\/jobs\/view\/(\d+)/);
    const jobId = idMatch ? idMatch[1] : null;

    const data: JobDetails = {
      jobId,
      jobUrl: url.split('?')[0],
      scrapedAt: new Date().toISOString(),
    };

    // ── Title ──
    data.title =
      q('h1.top-card-layout__title')?.innerText?.trim() ||
      q('h1.t-24')?.innerText?.trim() ||
      q('main h1')?.innerText?.trim() ||
      null;

    // ── Company ──
    const companyLink =
      q<HTMLAnchorElement>('a.topcard__org-name-link') ||
      q<HTMLAnchorElement>('a[data-tracking-control-name="public_jobs_topcard-org-name"]') ||
      q<HTMLAnchorElement>('.topcard__flavor a[href*="/company/"]') ||
      q<HTMLAnchorElement>('main a[href*="/company/"]');
    if (companyLink) {
      data.companyName = companyLink.innerText?.trim() || undefined;
      data.companyLinkedinUrl = companyLink.href.split('?')[0];
    }

    // ── Location ──
    data.location =
      q('.topcard__flavor--bullet')?.innerText?.trim() ||
      q('span.topcard__flavor:not(.topcard__flavor--metadata)')?.innerText?.trim() ||
      null;

    // ── Posted date / applicants ──
    const flavorEls = qq('.topcard__flavor, .top-card-layout__second-subline span');
    for (const el of flavorEls) {
      const text = el.innerText?.trim() || '';
      if (text.match(/applicant/i)) data.applicantsCount = text;
      if (text.match(/(month|year|day|week|hour)s?\s+ago/i)) data.postedAt = text;
    }

    // ── Job criteria sidebar ──
    const criteriaItems = qq('.description__job-criteria-item, .job-criteria__item');
    for (const item of criteriaItems) {
      const subheader = item
        .querySelector<HTMLElement>('.description__job-criteria-subheader, h3')
        ?.innerText?.trim()
        .toLowerCase();
      const text = item.querySelector<HTMLElement>('.description__job-criteria-text, .job-criteria__text')?.innerText?.trim();
      if (!subheader || !text) continue;
      if (subheader.includes('seniority')) data.seniorityLevel = text;
      if (subheader.includes('employment')) data.employmentType = text;
      if (subheader.includes('function')) data.jobFunction = text;
      if (subheader.includes('industries')) data.industries = text;
    }

    // ── Job description ──
    const descEl = q('.show-more-less-html__markup') || q('.description__text') || q('section.description');
    if (descEl) {
      data.jobDescription = descEl.innerText?.trim().substring(0, 10000) || null;
    }

    // ── Salary (often in description) ──
    const fullText = (data.jobDescription || '') + ' ' + (document.body.innerText || '').substring(0, 2000);
    const salaryMatch = fullText.match(
      /(?:€|EUR|\$|USD|£|GBP)\s?[\d,.]+(?:\s?(?:k|K|thousand|million))?(?:\s*[-–to]+\s*(?:€|EUR|\$|USD|£|GBP)?\s?[\d,.]+(?:\s?(?:k|K))?)?(?:\s*(?:per\s+(?:year|annum|month|hour)|\/yr|\/year|\/mo|\/hr|annually))?/i,
    );
    if (salaryMatch) data.salary = salaryMatch[0].trim();

    // ── Company description (sidebar) ──
    const companyDescEl = q('.company-description__text, .org-about-us__description, .topcard__org-name-link + p');
    if (companyDescEl) {
      data.companyDescription = companyDescEl.innerText?.trim().substring(0, 2000) || null;
    }

    // ── Company size ──
    const bodyText = document.body.innerText || '';
    const sizeMatch = bodyText.match(/(?<![,\d])([\d,]+(?:\+|\s*[-–]\s*[\d,]+))\s*employees/i);
    if (sizeMatch) data.companySize = sizeMatch[1].replace(/\s+/g, '').trim();

    // ── Company website (JSON-LD) ──
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = JSON.parse(script.textContent || '');
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (item.hiringOrganization?.sameAs && !data.companyWebsite) {
            data.companyWebsite = item.hiringOrganization.sameAs;
          }
          if (item.industry && !data.industries) {
            data.industries = item.industry;
          }
          if (item.hiringOrganization?.numberOfEmployees?.value && !data.companySize) {
            data.companySize = String(item.hiringOrganization.numberOfEmployees.value);
          }
          if (item.baseSalary?.value && !data.salary) {
            const sal = item.baseSalary.value;
            data.salary = `${sal.minValue || sal.value || ''}${sal.maxValue ? '-' + sal.maxValue : ''} ${item.baseSalary.currency || ''}`.trim();
          }
        }
      } catch {
        /* skip malformed JSON-LD */
      }
    }

    return data;
  }
});
