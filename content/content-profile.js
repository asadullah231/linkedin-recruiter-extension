/**
 * CONTENT SCRIPT — PROFILE DATA EXTRACTION
 * ─────────────────────────────────────────
 * Heart of the extension: pulls a recruiter's identity from two sources —
 *   1. Hidden Voyager API JSON embedded in <code> tags (most reliable)
 *   2. Visible DOM (fallback + supplements)
 * Hiring-post extraction lives in content-jobs.js (extractHiringPosts).
 */

// ═══════════════════════════════════════════════════════════════════════
// PROFILE DATA EXTRACTOR — combines voyager + DOM + hiring posts
// ═══════════════════════════════════════════════════════════════════════

async function extractProfileData() {
    const profileUrl = window.location.href.split('?')[0].replace(/\/$/, '');

    // ── Extract from hidden Voyager data (most reliable) ──
    const voyagerData = extractVoyagerData();

    // ── Extract from visible DOM (fallback + supplements) ──
    const domData = extractDomData();

    // ── Hiring posts — the GOLD ──
    const hiringPosts = await extractHiringPosts(voyagerData);

    // ── Combine everything ──
    // ── Sanity: discard voyager.profile if it doesn't belong to the page we're on ──
    // (sometimes the JSON cache contains the viewer-self entity ahead of the
    // target profile, which leads to every scrape coming back as the logged-in user)
    const expectedSlug = extractPublicIdentifier(profileUrl);
    const voyagerSlug = voyagerData?.profile?.publicIdentifier;
    const myName = getLoggedInUserName();
    const voyagerName = voyagerData?.profile?.firstName
        ? `${voyagerData.profile.firstName} ${voyagerData.profile.lastName || ''}`.trim()
        : null;

    // Reject voyager.profile if ANY of these red flags fire:
    //   1) publicIdentifier is set AND doesn't match the URL slug
    //   2) name matches the currently logged-in user (covers the common case where
    //      voyager has no publicIdentifier on the viewer-self entity)
    let voyagerLooksValid = !!voyagerData?.profile?.firstName;
    if (voyagerLooksValid && voyagerSlug && expectedSlug && voyagerSlug !== expectedSlug) {
        console.warn('🟡 LRI: Voyager profile slug mismatch — discarding (slug', voyagerSlug, '!= expected', expectedSlug + ')');
        voyagerLooksValid = false;
    }
    if (voyagerLooksValid && myName && voyagerName &&
        voyagerName.toLowerCase() === myName.toLowerCase()) {
        console.warn('🟡 LRI: Voyager profile = logged-in user (' + voyagerName + ') — discarding');
        voyagerLooksValid = false;
    }
    if (voyagerData?.profile && !voyagerLooksValid) {
        voyagerData.profile = null;
    }
    const vp = voyagerLooksValid ? voyagerData.profile : null;

    // ── Final guard: even if voyager passed and we ended up with a name,
    // make sure it's NOT the logged-in user's name. If it is, prefer DOM.
    // Also normalise to strip LinkedIn UI artefacts like "(1) " prefixes.
    let chosenFullName = vp?.firstName
        ? `${vp.firstName} ${vp.lastName || ''}`.trim()
        : domData.fullName;
    let chosenFirstName = vp?.firstName || domData.firstName;
    let chosenLastName  = vp?.lastName  || domData.lastName;

    chosenFullName  = normalizeProfileName(chosenFullName)  || chosenFullName;
    chosenFirstName = normalizeProfileName(chosenFirstName) || chosenFirstName;
    chosenLastName  = normalizeProfileName(chosenLastName)  || chosenLastName;
    if (myName && chosenFullName && chosenFullName.toLowerCase() === myName.toLowerCase()) {
        console.warn('🟡 LRI: Final-guard rejected name = logged-in user (' + chosenFullName + '), falling back');
        // If DOM name is also = logged-in user (or empty), null everything.
        if (domData.fullName && domData.fullName.toLowerCase() !== myName.toLowerCase()) {
            chosenFullName  = domData.fullName;
            chosenFirstName = domData.firstName;
            chosenLastName  = domData.lastName;
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

        // Identity (voyager only used if it matches the page)
        fullName: chosenFullName,
        firstName: chosenFirstName,
        lastName: chosenLastName,
        headline: vp?.headline || domData.headline,
        location: vp?.locationName || vp?.geoLocationName || domData.location,
        about: vp?.summary || domData.about,
        profilePic: vp?.profilePicture || domData.profilePic,

        // Current job
        currentCompany: voyagerData?.currentCompany?.name || domData.currentCompany,
        currentCompanyUrl: voyagerData?.currentCompany?.url || domData.currentCompanyUrl,
        currentJobTitle: voyagerData?.currentPosition?.title || null,

        // Counts
        followers: domData.followers,
        connections: domData.connections,

        // Status flags
        hasHiringBadge: domData.hasHiringBadge,
        isOpenToWork: domData.isOpenToWork,
        isVerified: domData.isVerified,

        // ⭐ THE GOLD: Hiring posts
        hiringPosts,
        hiringPostsCount: hiringPosts.length,

        // Raw voyager data (for debugging / future use)
        _voyagerExtracted: !!voyagerData?.profile,
        _extractionMethod: voyagerData?.profile ? 'voyager+dom' : 'dom-only'
    };
}

// ═══════════════════════════════════════════════════════════════════════
// VOYAGER API DATA EXTRACTOR
// LinkedIn profile pages me <code> tags me JSON hota hai with full data
// ═══════════════════════════════════════════════════════════════════════

function extractVoyagerData() {
    const result = {
        profile: null,
        currentCompany: null,
        currentPosition: null,
        hiringPosts: []
    };

    // LinkedIn embeds Voyager API responses in <code id="bpr-guid-XXX"> tags
    const codeBlocks = document.querySelectorAll('code[id^="bpr-guid-"], code[style*="display:none"]');

    for (const code of codeBlocks) {
        try {
            const text = code.textContent.trim();
            if (!text.startsWith('{')) continue;

            const json = JSON.parse(text);

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
                    profilePicture: extractPicUrl(json.data.profilePicture)
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
                        result.currentPosition = {
                            title: item.title,
                            companyName: item.companyName
                        };
                    }

                    // Company (organizational entity)
                    if (item.$type?.includes('Company') && !result.currentCompany?.name) {
                        result.currentCompany = {
                            name: item.name,
                            url: item.url,
                            industry: item.industry,
                            employeeCountRange: item.employeeCountRange?.start
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
                                source: 'voyager_json'
                            });
                        }
                    }
                }
            }

            // ── Aggressive fallback: scan the raw JSON text for any
            // LinkedIn job-posting URN that wasn't matched by $type above.
            // This catches profiles where LinkedIn embeds the IDs without a
            // typed wrapper (very common since the 2024 redesign).
            const jobUrnRx = /urn:li:(?:fsd_)?jobPosting:(\d{6,})/g;
            let m;
            const seen = new Set(result.hiringPosts.map(p => p.jobId));
            while ((m = jobUrnRx.exec(text)) !== null) {
                const id = m[1];
                if (seen.has(id)) continue;
                seen.add(id);
                result.hiringPosts.push({
                    jobId: id,
                    title: '',  // backfilled later via raw URL scan if needed
                    companyName: '',
                    location: '',
                    postedAt: null,
                    jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
                    source: 'voyager_urn_scan'
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

function extractDomData() {
    const data = {};

    // ── NAME ── STRICT extraction.
    // LinkedIn occasionally renders an h1 with the logged-in user's name
    // in side panels / "People also viewed" / sticky widgets. The naive
    // `h1` fallback was returning that. Now we scope to the profile's
    // main top-card container ONLY, fall back to og:title (server-set),
    // and reject any name that matches the logged-in user.
    const myName = getLoggedInUserName();
    const meRx   = myName ? new RegExp(`^${myName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i') : null;

    const candidates = [
        // Modern profile top card
        q('section.pv-top-card h1')?.innerText?.trim(),
        q('.pv-text-details__left-panel h1')?.innerText?.trim(),
        q('.ph5 h1.text-heading-xlarge')?.innerText?.trim(),
        // Older / fallback profile shell
        q('main section h1.text-heading-xlarge')?.innerText?.trim(),
        q('main section h1.top-card-layout__title')?.innerText?.trim(),
        // Server-rendered metadata (very reliable)
        extractNameFromMeta(),
        extractNameFromTitle()
    ];

    for (const cand of candidates) {
        if (!cand) continue;
        // ── Normalise: strip notification badges that LinkedIn injects into
        // the browser tab title, e.g. "(1) Maria Robillard - …" ──
        const clean = normalizeProfileName(cand);
        if (!clean) continue;
        if (clean.length < 2 || clean.length > 80) continue;
        if (/^linkedin/i.test(clean)) continue;
        if (/^(view|message|follow|connect|edit|premium)/i.test(clean)) continue;
        // Reject if it's the logged-in user's name (the bug we're fixing)
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

    // ── HEADLINE ── multiple modern selectors + meta fallback
    data.headline = q('.text-body-medium.break-words')?.innerText?.trim()
                 || q('.top-card-layout__headline')?.innerText?.trim()
                 || q('[data-generated-suggestion-target]')?.innerText?.trim()
                 || extractHeadlineFromMeta()
                 || extractHeadlineFromTitle();

    // ── LOCATION ──
    data.location = q('.text-body-small.inline.t-black--light.break-words')?.innerText?.trim()
                 || q('.top-card-layout__first-subline')?.innerText?.trim()
                 || extractLocationFromHeader();

    // ── ABOUT ──
    const aboutSection = q('section[data-section="summary"]')
                      || qq('section').find(s => s.querySelector('#about, [id="about"]'))
                      || qq('section').find(s => {
                            const h = s.querySelector('h2, h3');
                            return h && h.innerText.trim().toLowerCase() === 'about';
                         });
    if (aboutSection) {
        const spans = aboutSection.querySelectorAll('span[aria-hidden="true"]');
        const texts = Array.from(spans).map(s => s.innerText?.trim()).filter(t => t && t.length > 10);
        if (texts.length) {
            data.about = texts.join(' ').replace(/^About\s*/i, '').replace(/…\s*see more$/i, '').replace(/\.\.\.\s*see more$/i, '').trim() || null;
        } else {
            // Fallback to whole section text
            const text = aboutSection.innerText?.trim() || '';
            if (text.length > 10) {
                data.about = text.replace(/^About\s*/i, '').replace(/…?\s*see more$/i, '').trim();
            }
        }
    }

    // ── CURRENT COMPANY ──
    // Strategy 1: Top card current company link (most reliable)
    // LinkedIn shows current company in the profile header/intro section
    const topCardCompany = findTopCardCurrentCompany();
    if (topCardCompany) {
        data.currentCompany = topCardCompany.name;
        data.currentCompanyUrl = topCardCompany.url;
    }

    // Strategy 2: Experience section first item (active job)
    if (!data.currentCompany) {
        const expCompany = findExperienceSectionCompany();
        if (expCompany) {
            data.currentCompany = expCompany.name;
            data.currentCompanyUrl = expCompany.url;
        }
    }

    // Strategy 3: Parse from headline ("at Sungrow Europe")
    if (!data.currentCompany && data.headline) {
        const m = data.headline.match(/\bat\s+(.+?)(?:\s+\||\s*$)/i);
        if (m) data.currentCompany = m[1].trim();
    }

    // ── PROFILE PIC ──
    data.profilePic = q('img.pv-top-card-profile-picture__image')?.src
                   || q('button.profile-picture img')?.src
                   || q('img.profile-photo-edit__preview')?.src
                   || q('main img[alt*="Photo of"]')?.src
                   || q('main section img[width]')?.src
                   || extractPicFromMeta()
                   || null;

    // ── FOLLOWERS / CONNECTIONS ──
    const bodyText = document.body.innerText || '';
    const followerMatch = bodyText.match(/([\d,.]+[KkMm]?)\s*follower/i);
    data.followers = followerMatch ? followerMatch[1] : null;
    const connectionMatch = bodyText.match(/([\d,.]+[KkMm]?\+?)\s*connection/i);
    data.connections = connectionMatch ? connectionMatch[1] : null;

    // ── BADGES ──
    const lowerBody = bodyText.toLowerCase();
    data.hasHiringBadge = lowerBody.includes('#hiring') || lowerBody.includes('is hiring') ||
                          !!q('[aria-label*="hiring" i]');
    data.isOpenToWork = lowerBody.includes('#opentowork') || lowerBody.includes('open to work') ||
                       !!q('[aria-label*="open to work" i]');
    data.isVerified = !!q('[aria-label*="verified" i]')
                   || !!q('svg[data-test-icon*="verified"]')
                   || !!q('[data-test-id*="verified"]');

    return data;
}

// ═══════════════════════════════════════════════════════════════════════
// META / TITLE FALLBACK EXTRACTORS (always work, even when LinkedIn changes DOM)
// ═══════════════════════════════════════════════════════════════════════

function extractNameFromMeta() {
    // og:title is usually "Name - Headline | LinkedIn"
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

// Detect the logged-in user's display name from the global nav so we can
// REJECT it when it accidentally appears as the page's h1 (which used to
// cause every scraped profile to come back as "Iqra Chem").
function getLoggedInUserName() {
    try {
        // Strategy 1: nav profile photo (alt text)
        const imgSelectors = [
            '.global-nav__me img.global-nav__me-photo',
            'img.global-nav__me-photo',
            'a.global-nav__me-photo img',
            'button.global-nav__primary-link-me-menu-trigger img',
            'a.global-nav__primary-link-me-menu-trigger img',
            '.global-nav img[alt]',
            'header img.evi-image',  // newer header
            'nav img[width="32"][alt]'
        ];
        for (const sel of imgSelectors) {
            const el = q(sel);
            const alt = el?.getAttribute?.('alt') || '';
            if (!alt) continue;
            let m = alt.match(/(?:photo of|profile picture of|picture of)\s+(.+)$/i);
            if (m?.[1]) return cleanName(m[1]);
            if (alt.length > 1 && alt.length < 80 && !/linkedin|profile|photo/i.test(alt)) {
                return cleanName(alt);
            }
        }

        // Strategy 2: aria-label on me-menu trigger
        const ariaSelectors = [
            'button.global-nav__primary-link-me-menu-trigger',
            '.global-nav__me [aria-label]',
            'button[aria-label*="menu"]',
            'a[href="/in/me/"]'
        ];
        for (const sel of ariaSelectors) {
            const el = q(sel);
            const aria = el?.getAttribute?.('aria-label') || '';
            if (!aria) continue;
            const m = aria.match(/^(.+?)(?:'s|\s*profile|\s*menu|$)/i);
            if (m?.[1] && m[1].length < 80) return cleanName(m[1]);
        }

        // Strategy 3: voyager hidden data — look for the SELF entity
        // Many pages embed { "miniProfile": { firstName, lastName, publicIdentifier }, ... }
        // tagged with $type containing "MeViewer" or in "data.*.miniProfile"
        const codeBlocks = document.querySelectorAll('code[id^="bpr-guid-"]');
        for (const code of codeBlocks) {
            try {
                const json = JSON.parse(code.textContent.trim());
                const items = json?.included || [];
                for (const item of items) {
                    if (item?.$type?.includes('MiniProfile') &&
                        item.firstName && item.lastName &&
                        /global-nav|me|self/i.test(item?.$id || '')) {
                        return `${item.firstName} ${item.lastName}`.trim();
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
    return null;
}

function extractNameFromTitle() {
    // document.title format: "Name - Headline | LinkedIn"
    const title = document.title || '';
    const m = title.match(/^(.+?)(?:\s*[-|]\s*|$)/);
    if (m) {
        const name = m[1].trim();
        if (name && !name.match(/^linkedin/i) && name.length > 1) {
            // Make sure it's not the headline part
            if (!name.match(/(specialist|manager|engineer|director|recruiter)/i) || name.split(' ').length <= 4) {
                return name;
            }
        }
    }
    return null;
}

function extractHeadlineFromMeta() {
    // og:description usually contains the headline
    const og = q('meta[property="og:description"]')?.getAttribute('content') || '';
    if (og) {
        // Format varies. Sometimes: "Headline · Location · ..." or just "Headline"
        const firstPart = og.split(/[·|]/)[0].trim();
        if (firstPart && firstPart.length > 5 && firstPart.length < 300 && !firstPart.match(/^view\s+/i)) {
            return firstPart;
        }
    }
    return null;
}

function extractHeadlineFromTitle() {
    // "Name - Headline | LinkedIn"
    const title = document.title || '';
    const m = title.match(/^[^-|]+?\s*[-]\s*(.+?)\s*\|\s*LinkedIn/i);
    if (m) {
        const headline = m[1].trim();
        if (headline && headline.length > 3 && headline.length < 300) return headline;
    }
    return null;
}

function extractLocationFromHeader() {
    // Look for any small text near the name that contains a country/region
    // LinkedIn locations often have format "City, Region, Country" or "Country"
    const candidates = qq('main span, header span, .pv-text-details__left-panel span');
    for (const el of candidates) {
        const text = el.innerText?.trim() || '';
        if (text.length < 3 || text.length > 100) continue;
        // Skip non-location text
        if (text.match(/follower|connection|contact|recruiter|specialist|manager|engineer|director|message|connect|follow|premium|verified|joined|coach|hiring|opportunit/i)) continue;
        // Location heuristic: has comma (City, Country) OR is a known region pattern
        if (text.match(/^[A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+/) ||
            text.match(/\b(area|region|metropolitan)\b/i)) {
            return text;
        }
    }
    return null;
}

function extractPicFromMeta() {
    const og = q('meta[property="og:image"]')?.getAttribute('content');
    if (og && og.includes('media.licdn')) return og;
    return null;
}

/**
 * Find current company from PROFILE TOP CARD section
 * (the area with name, headline, location, current company badge)
 * Avoids matching companies from certifications/recommendations sections
 */
function findTopCardCurrentCompany() {
    // The top card is typically the first <section> in <main>, or has class hints
    const topCard = q('section.pv-top-card')
                 || q('section.artdeco-card')
                 || q('main > section:first-of-type')
                 || q('main section:has(h1)');

    if (!topCard) return null;

    // Look for company link only inside top card
    const links = topCard.querySelectorAll('a[href*="/company/"]');
    for (const link of links) {
        // Skip links in feed/setup/search URLs
        const href = link.getAttribute('href') || '';
        if (href.includes('/feed/') || href.includes('/setup/') || href.includes('/search/')) continue;

        const match = href.match(/\/company\/([^/?#]+)/);
        if (!match) continue;

        const text = link.innerText?.trim() || '';
        // Must look like company name (not "Show all" or numbers)
        if (text && text.length > 1 && text.length < 100 &&
            !text.match(/^(show|view|see|all|more|\d)/i) &&
            !text.match(/follow|connect|message/i)) {
            return {
                name: text,
                url: `https://www.linkedin.com/company/${match[1]}/`
            };
        }
    }
    return null;
}

/**
 * Find current company from EXPERIENCE section (first/active job)
 */
function findExperienceSectionCompany() {
    // Find experience section
    let expSection = q('section[id="experience"]')
                  || q('div[id="experience"]')
                  || qq('section').find(s => {
                        const h = s.querySelector('h2');
                        return h && h.innerText.trim().toLowerCase() === 'experience';
                     });

    // The experience section's parent might be the actual section
    if (expSection && expSection.tagName === 'DIV') {
        expSection = expSection.closest('section') || expSection.parentElement;
    }

    if (!expSection) return null;

    // First experience item is the current job
    const firstItem = expSection.querySelector('li, [class*="entity"]');
    if (!firstItem) return null;

    // Find company link in first item
    const companyLink = firstItem.querySelector('a[href*="/company/"]');
    if (!companyLink) return null;

    const href = companyLink.getAttribute('href') || '';
    const match = href.match(/\/company\/([^/?#]+)/);
    if (!match) return null;

    // Try multiple selectors for company name
    const nameEl = firstItem.querySelector('.t-bold span[aria-hidden="true"]')
                || firstItem.querySelector('span[aria-hidden="true"]')
                || companyLink;

    const name = nameEl?.innerText?.trim();
    if (name && name.length > 1 && name.length < 100) {
        return {
            name,
            url: `https://www.linkedin.com/company/${match[1]}/`
        };
    }
    return null;
}
