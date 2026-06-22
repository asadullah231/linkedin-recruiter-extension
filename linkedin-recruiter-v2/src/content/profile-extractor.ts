/**
 * CONTENT SCRIPT — PROFILE DATA EXTRACTION
 * ─────────────────────────────────────────
 * Typed port of content/content-profile.js. Pulls a recruiter's identity from
 * two sources: hidden Voyager API JSON in <code> tags (most reliable) + the
 * visible DOM (fallback/supplement). Hiring-post extraction lives in
 * jobs-extractor.ts (extractHiringPosts).
 */

import {
  q,
  qq,
  extractPublicIdentifier,
  extractPicUrl,
  normalizeProfileName,
  getLoggedInUserName,
} from '../utils/content-utils';
import { extractHiringPosts } from './jobs-extractor';
import type { ScrapedProfile, VoyagerData, DomData } from '../types/extraction';

// ═══════════════════════════════════════════════════════════════════════
// PROFILE DATA EXTRACTOR — combines voyager + DOM + hiring posts
// ═══════════════════════════════════════════════════════════════════════

export async function extractProfileData(): Promise<ScrapedProfile> {
  const profileUrl = window.location.href.split('?')[0].replace(/\/$/, '');

  const voyagerData = extractVoyagerData();
  const domData = extractDomData();
  const hiringPosts = await extractHiringPosts(voyagerData);

  // ── Sanity: discard voyager.profile if it doesn't belong to the page we're on ──
  const expectedSlug = extractPublicIdentifier(profileUrl);
  const voyagerSlug = voyagerData?.profile?.publicIdentifier;
  const myName = getLoggedInUserName();
  const voyagerName = voyagerData?.profile?.firstName
    ? `${voyagerData.profile.firstName} ${voyagerData.profile.lastName || ''}`.trim()
    : null;

  let voyagerLooksValid = !!voyagerData?.profile?.firstName;
  if (voyagerLooksValid && voyagerSlug && expectedSlug && voyagerSlug !== expectedSlug) {
    console.warn('🟡 LRI: Voyager profile slug mismatch — discarding (slug', voyagerSlug, '!= expected', expectedSlug + ')');
    voyagerLooksValid = false;
  }
  if (voyagerLooksValid && myName && voyagerName && voyagerName.toLowerCase() === myName.toLowerCase()) {
    console.warn('🟡 LRI: Voyager profile = logged-in user (' + voyagerName + ') — discarding');
    voyagerLooksValid = false;
  }
  if (voyagerData?.profile && !voyagerLooksValid) {
    voyagerData.profile = null;
  }
  const vp = voyagerLooksValid ? voyagerData.profile : null;

  // ── Final guard: ensure the chosen name isn't the logged-in user's ──
  let chosenFullName: string | null = vp?.firstName
    ? `${vp.firstName} ${vp.lastName || ''}`.trim()
    : domData.fullName ?? null;
  let chosenFirstName: string | null = vp?.firstName || domData.firstName || null;
  let chosenLastName: string | null = vp?.lastName || domData.lastName || null;

  chosenFullName = normalizeProfileName(chosenFullName) || chosenFullName;
  chosenFirstName = normalizeProfileName(chosenFirstName) || chosenFirstName;
  chosenLastName = normalizeProfileName(chosenLastName) || chosenLastName;
  if (myName && chosenFullName && chosenFullName.toLowerCase() === myName.toLowerCase()) {
    console.warn('🟡 LRI: Final-guard rejected name = logged-in user (' + chosenFullName + '), falling back');
    if (domData.fullName && domData.fullName.toLowerCase() !== myName.toLowerCase()) {
      chosenFullName = domData.fullName;
      chosenFirstName = domData.firstName ?? null;
      chosenLastName = domData.lastName ?? null;
    } else {
      chosenFullName = null;
      chosenFirstName = null;
      chosenLastName = null;
    }
  }

  return {
    scrapedAt: new Date().toISOString(),
    profileUrl,
    publicIdentifier: expectedSlug,

    // Identity (voyager only used if it matches the page).
    // null fullName (total extraction failure) is coerced to '' to keep the
    // canonical type non-null; downstream uses `fullName || 'Unknown'`.
    fullName: chosenFullName ?? '',
    firstName: chosenFirstName ?? undefined,
    lastName: chosenLastName ?? undefined,
    headline: vp?.headline || domData.headline || undefined,
    location: vp?.locationName || vp?.geoLocationName || domData.location || null,
    about: vp?.summary || domData.about || null,
    profilePic: vp?.profilePicture || domData.profilePic || null,

    // Current job
    currentCompany: voyagerData?.currentCompany?.name || domData.currentCompany || undefined,
    currentCompanyUrl: voyagerData?.currentCompany?.url || domData.currentCompanyUrl || null,
    currentJobTitle: voyagerData?.currentPosition?.title || null,

    // Counts
    followers: domData.followers || undefined,
    connections: domData.connections || undefined,

    // Status flags
    hasHiringBadge: domData.hasHiringBadge,
    isOpenToWork: domData.isOpenToWork,
    isVerified: domData.isVerified,

    // ⭐ THE GOLD: Hiring posts
    hiringPosts,
    hiringPostsCount: hiringPosts.length,

    // Debug
    _voyagerExtracted: !!voyagerData?.profile,
    _extractionMethod: voyagerData?.profile ? 'voyager+dom' : 'dom-only',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// VOYAGER API DATA EXTRACTOR — JSON embedded in <code> tags
// ═══════════════════════════════════════════════════════════════════════

export function extractVoyagerData(): VoyagerData {
  const result: VoyagerData = {
    profile: null,
    currentCompany: null,
    currentPosition: null,
    hiringPosts: [],
  };

  const codeBlocks = document.querySelectorAll('code[id^="bpr-guid-"], code[style*="display:none"]');

  for (const code of codeBlocks) {
    try {
      const text = (code.textContent || '').trim();
      if (!text.startsWith('{')) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = JSON.parse(text);

      // Profile data
      if (json.data?.firstName || json.data?.headline) {
        result.profile = {
          firstName: json.data.firstName,
          lastName: json.data.lastName,
          headline: json.data.headline,
          locationName: json.data.locationName,
          geoLocationName: json.data.geoLocationName,
          publicIdentifier: json.data.publicIdentifier || null,
          summary: json.data.summary,
          profilePicture: extractPicUrl(json.data.profilePicture),
        };
      }

      // Walk included objects (LinkedIn's relational data structure)
      if (json.included && Array.isArray(json.included)) {
        for (const item of json.included) {
          // Profile object
          if (item.$type?.includes('Profile') && item.firstName && !result.profile?.firstName) {
            result.profile = result.profile || {};
            result.profile.firstName = item.firstName;
            result.profile.lastName = item.lastName;
            result.profile.headline = item.headline;
            result.profile.locationName = item.locationName;
            result.profile.geoLocationName = item.geoLocationName;
            result.profile.publicIdentifier = item.publicIdentifier || null;
            result.profile.summary = item.summary;
          }

          // Position (current job)
          if (item.$type?.includes('Position') && !item.timePeriod?.endDate) {
            result.currentPosition = { title: item.title, companyName: item.companyName };
          }

          // Company (organizational entity)
          if (item.$type?.includes('Company') && !result.currentCompany?.name) {
            result.currentCompany = {
              name: item.name,
              url: item.url,
              industry: item.industry,
              employeeCountRange: item.employeeCountRange?.start,
            };
          }

          // Job posting (hiring posts!) — match a wider range of $types
          const t = item.$type || '';
          if (
            t.includes('JobPosting') ||
            t.includes('JobPostingCard') ||
            t.includes('Hiring') ||
            t.includes('jobPosting')
          ) {
            const urn = item.entityUrn || item.jobPostingUrn || item.objectUrn || '';
            const idMatch = String(urn).match(/(\d{6,})/);
            const jobId = idMatch?.[1];
            if (jobId) {
              result.hiringPosts.push({
                jobId,
                title: item.title || item.jobTitle || item.name || '',
                companyName: item.companyName || item.company?.name || '',
                location: item.formattedLocation || item.location || '',
                postedAt: item.listedAt || item.postedAt || null,
                jobUrl: item.applyMethod?.companyApplyUrl || `https://www.linkedin.com/jobs/view/${jobId}`,
                applicants: item.applies || null,
                source: 'voyager_json',
              });
            }
          }
        }
      }

      // ── Aggressive fallback: scan raw JSON text for jobPosting URNs ──
      const jobUrnRx = /urn:li:(?:fsd_)?jobPosting:(\d{6,})/g;
      let m: RegExpExecArray | null;
      const seen = new Set(result.hiringPosts.map((p) => p.jobId));
      while ((m = jobUrnRx.exec(text)) !== null) {
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        result.hiringPosts.push({
          jobId: id,
          title: '', // backfilled later via raw URL scan if needed
          companyName: '',
          location: '',
          postedAt: null,
          jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
          source: 'voyager_urn_scan',
        });
      }
    } catch {
      // Skip malformed JSON blocks
    }
  }

  if (result.hiringPosts.length > 0) {
    console.log(`🟢 LRI: Voyager found ${result.hiringPosts.length} job(s) total`);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// DOM-BASED EXTRACTOR (fallback + complements voyager data)
// ═══════════════════════════════════════════════════════════════════════

export function extractDomData(): DomData {
  const data: DomData = {};

  // ── NAME ── STRICT extraction, scoped to the top card, rejecting self.
  const myName = getLoggedInUserName();
  const meRx = myName ? new RegExp(`^${myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;

  const candidates = [
    q('section.pv-top-card h1')?.innerText?.trim(),
    q('.pv-text-details__left-panel h1')?.innerText?.trim(),
    q('.ph5 h1.text-heading-xlarge')?.innerText?.trim(),
    q('main section h1.text-heading-xlarge')?.innerText?.trim(),
    q('main section h1.top-card-layout__title')?.innerText?.trim(),
    extractNameFromMeta(),
    extractNameFromTitle(),
  ];

  for (const cand of candidates) {
    if (!cand) continue;
    const clean = normalizeProfileName(cand);
    if (!clean) continue;
    if (clean.length < 2 || clean.length > 80) continue;
    if (/^linkedin/i.test(clean)) continue;
    if (/^(view|message|follow|connect|edit|premium)/i.test(clean)) continue;
    if (meRx && meRx.test(clean)) {
      console.warn('🟡 LRI: Rejected name candidate (matches logged-in user):', clean);
      continue;
    }
    data.fullName = clean;
    break;
  }

  if (data.fullName) {
    const parts = data.fullName.split(/\s+/);
    data.firstName = parts[0];
    data.lastName = parts.slice(1).join(' ') || null;
  } else {
    console.warn('🟡 LRI: Could not extract a profile name (all candidates rejected)');
  }

  // ── HEADLINE ──
  data.headline =
    q('.text-body-medium.break-words')?.innerText?.trim() ||
    q('.top-card-layout__headline')?.innerText?.trim() ||
    q('[data-generated-suggestion-target]')?.innerText?.trim() ||
    extractHeadlineFromMeta() ||
    extractHeadlineFromTitle();

  // ── LOCATION ──
  data.location =
    q('.text-body-small.inline.t-black--light.break-words')?.innerText?.trim() ||
    q('.top-card-layout__first-subline')?.innerText?.trim() ||
    extractLocationFromHeader();

  // ── ABOUT ──
  const aboutSection =
    q('section[data-section="summary"]') ||
    qq('section').find((s) => s.querySelector('#about, [id="about"]')) ||
    qq('section').find((s) => {
      const h = s.querySelector<HTMLElement>('h2, h3');
      return !!h && h.innerText.trim().toLowerCase() === 'about';
    });
  if (aboutSection) {
    const spans = aboutSection.querySelectorAll<HTMLElement>('span[aria-hidden="true"]');
    const texts = Array.from(spans)
      .map((s) => s.innerText?.trim())
      .filter((t) => t && t.length > 10);
    if (texts.length) {
      data.about =
        texts.join(' ').replace(/^About\s*/i, '').replace(/…\s*see more$/i, '').replace(/\.\.\.\s*see more$/i, '').trim() ||
        null;
    } else {
      const text = aboutSection.innerText?.trim() || '';
      if (text.length > 10) {
        data.about = text.replace(/^About\s*/i, '').replace(/…?\s*see more$/i, '').trim();
      }
    }
  }

  // ── CURRENT COMPANY ──
  const topCardCompany = findTopCardCurrentCompany();
  if (topCardCompany) {
    data.currentCompany = topCardCompany.name;
    data.currentCompanyUrl = topCardCompany.url;
  }
  if (!data.currentCompany) {
    const expCompany = findExperienceSectionCompany();
    if (expCompany) {
      data.currentCompany = expCompany.name;
      data.currentCompanyUrl = expCompany.url;
    }
  }
  if (!data.currentCompany && data.headline) {
    const m = data.headline.match(/\bat\s+(.+?)(?:\s+\||\s*$)/i);
    if (m) data.currentCompany = m[1].trim();
  }

  // ── PROFILE PIC ──
  data.profilePic =
    q<HTMLImageElement>('img.pv-top-card-profile-picture__image')?.src ||
    q<HTMLImageElement>('button.profile-picture img')?.src ||
    q<HTMLImageElement>('img.profile-photo-edit__preview')?.src ||
    q<HTMLImageElement>('main img[alt*="Photo of"]')?.src ||
    q<HTMLImageElement>('main section img[width]')?.src ||
    extractPicFromMeta() ||
    null;

  // ── FOLLOWERS / CONNECTIONS ──
  const bodyText = document.body.innerText || '';
  const followerMatch = bodyText.match(/([\d,.]+[KkMm]?)\s*follower/i);
  data.followers = followerMatch ? followerMatch[1] : null;
  const connectionMatch = bodyText.match(/([\d,.]+[KkMm]?\+?)\s*connection/i);
  data.connections = connectionMatch ? connectionMatch[1] : null;

  // ── BADGES ──
  const lowerBody = bodyText.toLowerCase();
  data.hasHiringBadge =
    lowerBody.includes('#hiring') || lowerBody.includes('is hiring') || !!q('[aria-label*="hiring" i]');
  data.isOpenToWork =
    lowerBody.includes('#opentowork') || lowerBody.includes('open to work') || !!q('[aria-label*="open to work" i]');
  data.isVerified =
    !!q('[aria-label*="verified" i]') ||
    !!q('svg[data-test-icon*="verified"]') ||
    !!q('[data-test-id*="verified"]');

  return data;
}

// ═══════════════════════════════════════════════════════════════════════
// META / TITLE FALLBACK EXTRACTORS
// ═══════════════════════════════════════════════════════════════════════

function extractNameFromMeta(): string | null {
  const og = q('meta[property="og:title"]')?.getAttribute('content') || '';
  if (og) {
    const m = og.match(/^([^-|]+?)(?:\s*[-|]\s*|$)/);
    if (m) {
      const name = m[1].trim();
      if (name && name.length > 1 && name.length < 80 && !name.match(/^linkedin/i)) return name;
    }
  }
  return null;
}

function extractNameFromTitle(): string | null {
  const title = document.title || '';
  const m = title.match(/^(.+?)(?:\s*[-|]\s*|$)/);
  if (m) {
    const name = m[1].trim();
    if (name && !name.match(/^linkedin/i) && name.length > 1) {
      if (!name.match(/(specialist|manager|engineer|director|recruiter)/i) || name.split(' ').length <= 4) {
        return name;
      }
    }
  }
  return null;
}

function extractHeadlineFromMeta(): string | null {
  const og = q('meta[property="og:description"]')?.getAttribute('content') || '';
  if (og) {
    const firstPart = og.split(/[·|]/)[0].trim();
    if (firstPart && firstPart.length > 5 && firstPart.length < 300 && !firstPart.match(/^view\s+/i)) {
      return firstPart;
    }
  }
  return null;
}

function extractHeadlineFromTitle(): string | null {
  const title = document.title || '';
  const m = title.match(/^[^-|]+?\s*[-]\s*(.+?)\s*\|\s*LinkedIn/i);
  if (m) {
    const headline = m[1].trim();
    if (headline && headline.length > 3 && headline.length < 300) return headline;
  }
  return null;
}

function extractLocationFromHeader(): string | null {
  const candidates = qq('main span, header span, .pv-text-details__left-panel span');
  for (const el of candidates) {
    const text = el.innerText?.trim() || '';
    if (text.length < 3 || text.length > 100) continue;
    if (text.match(/follower|connection|contact|recruiter|specialist|manager|engineer|director|message|connect|follow|premium|verified|joined|coach|hiring|opportunit/i)) continue;
    if (
      text.match(/^[A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+/) ||
      text.match(/\b(area|region|metropolitan)\b/i)
    ) {
      return text;
    }
  }
  return null;
}

function extractPicFromMeta(): string | null {
  const og = q('meta[property="og:image"]')?.getAttribute('content');
  if (og && og.includes('media.licdn')) return og;
  return null;
}

/** Find current company from the PROFILE TOP CARD (name/headline/location area). */
function findTopCardCurrentCompany(): { name: string; url: string } | null {
  const topCard =
    q('section.pv-top-card') ||
    q('section.artdeco-card') ||
    q('main > section:first-of-type') ||
    q('main section:has(h1)');
  if (!topCard) return null;

  const links = topCard.querySelectorAll<HTMLAnchorElement>('a[href*="/company/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (href.includes('/feed/') || href.includes('/setup/') || href.includes('/search/')) continue;

    const match = href.match(/\/company\/([^/?#]+)/);
    if (!match) continue;

    const text = link.innerText?.trim() || '';
    if (
      text &&
      text.length > 1 &&
      text.length < 100 &&
      !text.match(/^(show|view|see|all|more|\d)/i) &&
      !text.match(/follow|connect|message/i)
    ) {
      return { name: text, url: `https://www.linkedin.com/company/${match[1]}/` };
    }
  }
  return null;
}

/** Find current company from the EXPERIENCE section (first/active job). */
function findExperienceSectionCompany(): { name: string; url: string } | null {
  let expSection: HTMLElement | null =
    q('section[id="experience"]') ||
    q('div[id="experience"]') ||
    qq('section').find((s) => {
      const h = s.querySelector<HTMLElement>('h2');
      return !!h && h.innerText.trim().toLowerCase() === 'experience';
    }) ||
    null;

  if (expSection && expSection.tagName === 'DIV') {
    expSection = expSection.closest('section') || expSection.parentElement;
  }
  if (!expSection) return null;

  const firstItem = expSection.querySelector<HTMLElement>('li, [class*="entity"]');
  if (!firstItem) return null;

  const companyLink = firstItem.querySelector<HTMLAnchorElement>('a[href*="/company/"]');
  if (!companyLink) return null;

  const href = companyLink.getAttribute('href') || '';
  const match = href.match(/\/company\/([^/?#]+)/);
  if (!match) return null;

  const nameEl =
    firstItem.querySelector<HTMLElement>('.t-bold span[aria-hidden="true"]') ||
    firstItem.querySelector<HTMLElement>('span[aria-hidden="true"]') ||
    companyLink;

  const name = nameEl?.innerText?.trim();
  if (name && name.length > 1 && name.length < 100) {
    return { name, url: `https://www.linkedin.com/company/${match[1]}/` };
  }
  return null;
}
