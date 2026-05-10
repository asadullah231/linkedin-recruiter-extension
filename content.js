/**
 * LINKEDIN RECRUITER INTELLIGENCE — Content Script
 * ─────────────────────────────────────────────────
 * Yeh script har LinkedIn profile page pe inject hoti hai.
 *
 * KEY INSIGHT: LinkedIn profile pages me data 2 jagah hota hai:
 *   1. Visible DOM (jo aapko dikh raha hai)
 *   2. Hidden <code> tags (Voyager API responses, full structured data)
 *
 * Hum dono se data extract karte hain — DOM se HTML me dikhne wala,
 * <code> tags se hidden fields (hiring posts, URNs, etc).
 */

console.log('🟢 LinkedIn Recruiter Intelligence: Content script loaded');

// ═══════════════════════════════════════════════════════════════════════
// FLOATING ACTION BUTTON — Profile pe save button add karo
// ═══════════════════════════════════════════════════════════════════════

function injectFloatingButton() {
    if (document.getElementById('lri-save-button')) return; // already exists

    const button = document.createElement('div');
    button.id = 'lri-save-button';
    button.className = 'lri-fab';
    button.innerHTML = `
        <div class="lri-fab-icon">📥</div>
        <div class="lri-fab-text">Save Profile</div>
    `;

    button.addEventListener('click', handleSaveProfile);
    document.body.appendChild(button);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SAVE HANDLER
// ═══════════════════════════════════════════════════════════════════════

async function handleSaveProfile() {
    const button = document.getElementById('lri-save-button');
    if (!button) return;

    // Show loading state
    button.classList.add('lri-loading');
    button.querySelector('.lri-fab-text').textContent = 'Capturing...';

    try {
        const data = await extractProfileData();

        // Save to chrome storage
        await chrome.runtime.sendMessage({
            action: 'saveProfile',
            data: data
        });

        // Success state
        button.classList.remove('lri-loading');
        button.classList.add('lri-success');
        button.querySelector('.lri-fab-icon').textContent = '✅';
        button.querySelector('.lri-fab-text').textContent = `Saved! ${data.hiringPosts?.length || 0} jobs found`;

        setTimeout(() => {
            button.classList.remove('lri-success');
            button.querySelector('.lri-fab-icon').textContent = '📥';
            button.querySelector('.lri-fab-text').textContent = 'Save Profile';
        }, 3000);

    } catch (err) {
        console.error('LRI Error:', err);
        button.classList.remove('lri-loading');
        button.classList.add('lri-error');
        button.querySelector('.lri-fab-icon').textContent = '❌';
        button.querySelector('.lri-fab-text').textContent = 'Failed: ' + err.message.substring(0, 30);

        setTimeout(() => {
            button.classList.remove('lri-error');
            button.querySelector('.lri-fab-icon').textContent = '📥';
            button.querySelector('.lri-fab-text').textContent = 'Save Profile';
        }, 5000);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PROFILE DATA EXTRACTOR — heart of the extension
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
    const voyagerLooksValid = voyagerData?.profile?.firstName
        && (!voyagerSlug || !expectedSlug || voyagerSlug === expectedSlug);
    if (voyagerData?.profile && !voyagerLooksValid) {
        console.warn('🟡 LRI: Voyager profile mismatch — discarding (slug', voyagerSlug, '!= expected', expectedSlug + ')');
        voyagerData.profile = null;
    }
    const vp = voyagerLooksValid ? voyagerData.profile : null;

    return {
        scrapedAt: new Date().toISOString(),
        profileUrl,
        publicIdentifier: expectedSlug,

        // Identity (voyager only used if it matches the page)
        fullName: vp?.firstName
            ? `${vp.firstName} ${vp.lastName || ''}`.trim()
            : domData.fullName,
        firstName: vp?.firstName || domData.firstName,
        lastName: vp?.lastName || domData.lastName,
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
        if (cand.length < 2 || cand.length > 80) continue;
        if (/^linkedin/i.test(cand)) continue;
        if (/^(view|message|follow|connect|edit|premium)/i.test(cand)) continue;
        // Reject if it's the logged-in user's name (the bug we're fixing)
        if (meRx && meRx.test(cand)) {
            console.warn('🟡 LRI: Rejected name candidate (matches logged-in user):', cand);
            continue;
        }
        data.fullName = cand.replace(/\s+/g, ' ');
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
        // Modern LinkedIn: profile photo in nav has alt = "Photo of <Your Name>"
        // or aria-label "<Name>".
        const meImg = q('.global-nav__me img.global-nav__me-photo')
                   || q('img.global-nav__me-photo')
                   || q('a.global-nav__me-photo')
                   || q('button.global-nav__primary-link-me-menu-trigger img')
                   || q('a.global-nav__primary-link-me-menu-trigger img');
        const alt = meImg?.getAttribute?.('alt') || '';
        let m = alt.match(/(?:photo of|profile picture of)\s+(.+)$/i);
        if (m && m[1]) return m[1].trim();
        if (alt && alt.length > 1 && alt.length < 80 && !/linkedin|profile/i.test(alt)) return alt.trim();

        // Fallback: aria-label on me-menu trigger
        const meBtn = q('button.global-nav__primary-link-me-menu-trigger, .global-nav__me [aria-label]');
        const aria  = meBtn?.getAttribute?.('aria-label') || '';
        m = aria.match(/^(.+?)(?:'s|\s*profile|\s*menu|$)/i);
        if (m && m[1] && m[1].length < 80) return m[1].trim();
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

// ═══════════════════════════════════════════════════════════════════════
// HIRING POSTS EXTRACTOR
// "Hiring: Field Service Engineer & 5 others" wala card
// ═══════════════════════════════════════════════════════════════════════

async function extractHiringPosts(voyagerData) {
    const posts = [];

    // Method 1: Already extracted from voyager <code> tags
    if (voyagerData?.hiringPosts?.length > 0) {
        console.log('🟢 LRI: Got hiring posts from voyager data:', voyagerData.hiringPosts.length);
        return voyagerData.hiringPosts;
    }

    // Method 2: Find hiring banner & click "Show N jobs"
    console.log('🟢 LRI: Looking for hiring banner...');
    const hiringBanner = findHiringBanner();

    if (hiringBanner) {
        console.log('🟢 LRI: Found hiring banner, looking for show jobs link...');

        // ── Quick win: if banner itself has /jobs/view/<id> links, scrape inline first ──
        const directJobLinks = hiringBanner.querySelectorAll('a[href*="/jobs/view/"]');
        if (directJobLinks.length > 0) {
            console.log(`🟢 LRI: Banner has ${directJobLinks.length} direct job link(s) — extracting without modal`);
            const seen = new Set();
            for (const link of directJobLinks) {
                const idMatch = link.href.match(/\/jobs\/view\/(\d+)/);
                const jobId = idMatch?.[1];
                if (!jobId || seen.has(jobId)) continue;
                seen.add(jobId);
                const card = link.closest('li, article, div') || hiringBanner;
                const titleEl = card.querySelector('h3, h4, [class*="title"], strong') || link;
                const title = (titleEl.innerText || link.innerText || '').trim().split('\n')[0];
                if (title && title.length > 3) {
                    posts.push({
                        jobId,
                        title: title.substring(0, 200),
                        company: card.querySelector('[class*="company"], [class*="subtitle"]')?.innerText?.trim().split('\n')[0] || null,
                        location: null,
                        postedAt: null,
                        jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
                        source: 'hiring_badge'
                    });
                }
            }
        }

        // If we already got jobs from the banner (single-job recruiters), skip the modal step
        if (posts.length > 0) {
            console.log(`🟢 LRI: Got ${posts.length} job(s) directly from banner — skipping modal`);
        }

        const showJobsLink = posts.length === 0 ? findShowJobsLink(hiringBanner) : null;

        if (showJobsLink) {
            console.log('🟢 LRI: Clicking show jobs link...');
            // React-friendly click: a plain .click() doesn't always fire
            // LinkedIn's onClick handler. Dispatch a real MouseEvent chain.
            try {
                ['mousedown', 'mouseup', 'click'].forEach(type => {
                    showJobsLink.dispatchEvent(new MouseEvent(type, {
                        bubbles: true, cancelable: true, view: window, button: 0
                    }));
                });
            } catch (e) {
                console.warn('🟡 LRI: MouseEvent dispatch failed, falling back to .click()', e);
                showJobsLink.click();
            }

            // Wait for modal AND its content to load (poll, don't just sleep)
            const modal = await waitForModal();

            if (modal) {
                console.log('🟢 LRI: Modal appeared, waiting for jobs to load...');
                // Wait for at least 1 job link OR text containing job titles
                await waitForModalContent(modal);

                console.log('🟢 LRI: Extracting from modal HTML:', modal.outerHTML.substring(0, 500));

                const extracted = extractJobsFromModal(modal);
                console.log(`🟢 LRI: Extracted ${extracted.length} jobs from modal`);
                posts.push(...extracted);

                // Close modal (after extraction)
                closeModal(modal);
            } else {
                console.warn('⚠️ LRI: Modal did not appear after click');
            }
        }
    }

    // Method 3: Inline job links on profile (no modal needed)
    if (posts.length === 0) {
        console.log('🟢 LRI: Trying inline job links fallback...');
        const allJobLinks = qq('a[href*="/jobs/view/"]');
        const seen = new Set();
        for (const link of allJobLinks) {
            const idMatch = link.href.match(/\/jobs\/view\/(\d+)/);
            const jobId = idMatch ? idMatch[1] : null;
            if (!jobId || seen.has(jobId)) continue;
            seen.add(jobId);

            const card = link.closest('li, article, div');
            const title = link.innerText?.trim() || card?.querySelector('h3, h4')?.innerText?.trim();
            if (title && title.length > 3) {
                posts.push({
                    jobId,
                    title: title.replace(/\s+/g, ' ').trim(),
                    company: card?.querySelector('[class*="company"]')?.innerText?.trim() || null,
                    location: card?.querySelector('[class*="location"]')?.innerText?.trim() || null,
                    postedAt: card?.querySelector('time, [class*="date"]')?.innerText?.trim() || null,
                    jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
                    source: 'inline'
                });
            }
        }
    }

    // Tag the existing posts with source if not already
    for (const p of posts) {
        if (!p.source) p.source = 'hiring_badge';
    }

    // Method 4: Recent activity posts (last 15) — looks for jobs in recent posts/reposts
    try {
        const activityJobs = await extractFromActivityPosts();
        if (activityJobs.length > 0) {
            const existingIds = new Set(posts.map(p => p.jobId));
            const newJobs = activityJobs.filter(j => !existingIds.has(j.jobId));
            posts.push(...newJobs);
            console.log(`🟢 LRI: Added ${newJobs.length} jobs from activity posts (after dedup)`);
        }
    } catch (err) {
        console.warn('⚠️ LRI: Activity posts scan failed:', err.message);
    }

    // Method 5 (LAST RESORT): scan the raw page HTML for any LinkedIn
    // jobPosting URN. The 2024 redesign hides job IDs in <code>/<script>
    // blobs that aren't valid JSON or aren't typed correctly, so the
    // structured passes above miss them. This catches everything left.
    if (posts.length === 0 && hiringBanner) {
        console.log('🟢 LRI: All structured methods empty — running raw URN scan');
        try {
            const html = document.documentElement.outerHTML;
            const seen = new Set();
            const rx = /urn:li:(?:fsd_)?jobPosting:(\d{6,})/g;
            let m;
            while ((m = rx.exec(html)) !== null) {
                const id = m[1];
                if (seen.has(id)) continue;
                seen.add(id);
                posts.push({
                    jobId: id,
                    title: '(title unavailable — pull from job page on enrich)',
                    company: null,
                    location: null,
                    postedAt: null,
                    jobUrl: `https://www.linkedin.com/jobs/view/${id}`,
                    source: 'urn_scan'
                });
            }
            if (posts.length > 0) {
                console.log(`🟢 LRI: Raw URN scan recovered ${posts.length} job(s)`);
            }
        } catch (err) {
            console.warn('⚠️ LRI: Raw URN scan failed:', err.message);
        }
    }

    return posts;
}

// ═══════════════════════════════════════════════════════════════════════
// METHOD 4: Activity / Recent Posts scan
// Looks at recruiter's last 15 posts/activity items for job links
// ═══════════════════════════════════════════════════════════════════════

async function extractFromActivityPosts() {
    const posts = [];
    const seen = new Set();
    const MAX_POSTS_TO_SCAN = 15;

    console.log('🟢 LRI: Scanning Activity / Recent Posts...');

    // Find the Activity section — multiple heuristics
    const allSections = qq('section, div[class*="activity"], div[class*="feed"]');
    let activitySection = null;

    for (const sec of allSections) {
        const heading = sec.querySelector('h2, h3, [class*="header"], [class*="title"]');
        const headingText = (heading?.innerText || sec.innerText || '').trim().toLowerCase();
        if (/^activity$|^posts$|^recent activity|^featured/i.test(headingText.substring(0, 50))) {
            activitySection = sec;
            break;
        }
    }

    // Fallback: find any container that has multiple post-like children
    if (!activitySection) {
        const containers = qq('[class*="profile-creator"], [class*="activity-feed"], [class*="recent-activity"]');
        if (containers.length > 0) activitySection = containers[0];
    }

    if (!activitySection) {
        console.log('🟢 LRI: No activity section found');
        return posts;
    }

    // Scan post-like children for job links
    const postElements = activitySection.querySelectorAll(
        'li, article, div[class*="feed-shared"], div[class*="update-components"], div[class*="post"]'
    );

    let scannedCount = 0;
    for (const post of postElements) {
        if (scannedCount >= MAX_POSTS_TO_SCAN) break;
        scannedCount++;

        const jobLinks = post.querySelectorAll('a[href*="/jobs/view/"]');
        if (jobLinks.length === 0) continue;

        for (const link of jobLinks) {
            const idMatch = link.href.match(/\/jobs\/view\/(\d+)/);
            const jobId = idMatch?.[1];
            if (!jobId || seen.has(jobId)) continue;
            seen.add(jobId);

            const title = (link.innerText?.trim()
                       || post.querySelector('h2, h3, h4, [class*="title"]')?.innerText?.trim()
                       || 'Untitled job').replace(/\s+/g, ' ').trim().substring(0, 250);

            const postLinkEl = post.querySelector('a[href*="/posts/"], a[href*="/feed/update"]');

            posts.push({
                jobId,
                title,
                company: post.querySelector('[class*="company"], [class*="actor-name"]')?.innerText?.trim() || null,
                location: null,
                postedAt: post.querySelector('time, [class*="date"], [class*="time-since"]')?.innerText?.trim() || null,
                jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`,
                postUrl: postLinkEl?.href || null,
                source: 'activity_post'
            });
        }
    }

    console.log(`🟢 LRI: Activity scan: scanned ${scannedCount} posts, found ${posts.length} job links`);
    return posts;
}

// ═══════════════════════════════════════════════════════════════════════
// HIRING POSTS HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function findHiringBanner() {
    // Look for "Hiring: ..." text or "Show N jobs" link
    const candidates = qq('div, section, a');
    for (const el of candidates) {
        const text = (el.innerText || '').trim();
        if (text.length > 800 || text.length < 5) continue;
        // Match BOTH "Show 5 jobs" and the singular "Show job" (when only 1 opening exists)
        if (text.match(/^Hiring:/i) || text.match(/\bShow\s+(\d+\s+)?jobs?\b/i)) {
            return el;
        }
    }
    return null;
}

function findShowJobsLink(banner) {
    // Could be: a tag, button, or div with click handler
    const allClickables = banner.querySelectorAll('a, button, [role="button"], [tabindex="0"]');
    for (const el of allClickables) {
        const text = (el.innerText || '').trim();
        // Match: "Show job", "Show 1 job", "Show 5 jobs", "See all jobs", "See more jobs", "View all"
        if (
            text.match(/^show\s+(\d+\s+)?jobs?$/i) ||
            text.match(/^see\s+(all|more)\s+jobs?$/i) ||
            text.match(/^view\s+(all|jobs?)/i)
        ) {
            return el;
        }
    }
    // Fallback: if banner itself is clickable
    if (banner.tagName === 'A' || banner.tagName === 'BUTTON' || banner.getAttribute('role') === 'button') {
        return banner;
    }
    // Fallback 2: any link inside the banner that goes to /jobs/
    for (const el of allClickables) {
        if (el.href && /\/jobs\//.test(el.href)) return el;
    }
    return null;
}

async function waitForModal(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        // Try multiple modal selectors
        const modal = q('div[role="dialog"]')
                   || q('.artdeco-modal')
                   || q('[data-test-modal]')
                   || q('.modal__content')
                   || qq('div').find(d => {
                        const txt = d.innerText || '';
                        return txt.includes('Open roles') && txt.includes('hiring');
                      });
        if (modal) {
            // Make sure modal has content (not just opened empty)
            const hasContent = modal.innerText && modal.innerText.length > 50;
            if (hasContent) return modal;
        }
        await sleep(200);
    }
    return null;
}

async function waitForModalContent(modal, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        // Wait for either job links OR job titles in text
        const hasJobLinks = modal.querySelectorAll('a[href*="/jobs/"]').length > 0;
        const hasMultipleJobCards = modal.querySelectorAll('li, [class*="job"], [class*="card"]').length >= 2;
        const text = modal.innerText || '';
        const looksLoaded = text.length > 200 && (hasJobLinks || hasMultipleJobCards);

        if (looksLoaded) {
            // Wait one more tick for any final renders
            await sleep(500);
            return true;
        }
        await sleep(200);
    }
    return false;
}

function extractJobsFromModal(modal) {
    const posts = [];
    const seen = new Set();

    // Strategy 1: Extract via job view links
    const jobLinks = modal.querySelectorAll('a[href*="/jobs/view/"], a[href*="/jobs/"]');
    for (const link of jobLinks) {
        const job = parseJobFromLink(link, modal);
        if (job && !seen.has(job.jobId)) {
            seen.add(job.jobId);
            posts.push(job);
        }
    }

    // Strategy 2: If no links found, parse text-based cards
    if (posts.length === 0) {
        // Each job card is likely a list item or div with title + company + location
        const cards = modal.querySelectorAll('li, [class*="card"], [class*="result"], [class*="entity"]');
        for (const card of cards) {
            const text = (card.innerText || '').trim();
            if (text.length < 20 || text.length > 500) continue;

            // Look for title (usually first significant text or h3/h4/strong)
            const titleEl = card.querySelector('h1, h2, h3, h4, strong, [class*="title"]')
                         || card.querySelector('a');
            const title = titleEl?.innerText?.trim();
            if (!title || title.length < 3 || title.length > 200) continue;

            // Skip if title looks like company name only
            const companyEl = card.querySelector('[class*="company"], [class*="subtitle"]');
            const locationEl = card.querySelector('[class*="location"], [class*="metadata"]');
            const dateEl = card.querySelector('time, [class*="date"], [class*="posted"]');

            // Try to find job ID via any nested attribute
            const linkInCard = card.querySelector('a[href*="/jobs/"]');
            let jobId = null;
            if (linkInCard) {
                const m = linkInCard.href.match(/\/jobs\/(?:view|details)\/(\d+)/);
                if (m) jobId = m[1];
            }
            if (!jobId) {
                // Use title as dedup key
                jobId = `text:${title.substring(0, 50)}`;
            }
            if (seen.has(jobId)) continue;
            seen.add(jobId);

            posts.push({
                jobId,
                title: title.replace(/\s+/g, ' ').trim(),
                company: companyEl?.innerText?.trim() || null,
                location: locationEl?.innerText?.trim() || null,
                postedAt: dateEl?.innerText?.trim() || null,
                jobUrl: linkInCard?.href || null
            });
        }
    }

    // Strategy 3: Last resort — parse the modal text manually
    if (posts.length === 0) {
        const text = modal.innerText || '';
        // Pattern: "Title\nCompany\nLocation\nX months ago"
        const blocks = text.split(/\n\n+/);
        for (const block of blocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2 || lines.length > 6) continue;

            // Heuristic: line 1 = title, line 2 = company, line 3 = location, line 4 = date
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
                postedAt: lines.find(l => l.match(/(month|year|day|week|hour)s?\s+ago/i)) || null,
                jobUrl: null
            });
        }
    }

    return posts;
}

function parseJobFromLink(link, modal) {
    const href = link.href || '';
    const idMatch = href.match(/\/jobs\/(?:view|details)\/(\d+)/);
    const jobId = idMatch ? idMatch[1] : null;
    if (!jobId) return null;

    let title = null, company = null, location = null, date = null, companyLinkedinUrl = null;

    // ── Company LinkedIn URL — look in card or modal for /company/ link ──
    // Walk up to card container, then search for company link
    const card = link.closest('li, article, [class*="card"], [class*="entity"]') || link.parentElement;
    const companyLink = card?.querySelector('a[href*="/company/"]')
                     || link.querySelector('a[href*="/company/"]');
    if (companyLink) {
        const m = companyLink.getAttribute('href')?.match(/\/company\/([^/?#]+)/);
        if (m) {
            companyLinkedinUrl = `https://www.linkedin.com/company/${m[1]}/`;
            // Also use this as company name if we don't have it
            const cText = companyLink.innerText?.trim();
            if (cText && cText.length > 1 && cText.length < 100) company = cText;
        }
    }

    // ── Strategy A: Structured children (h3/h4/strong inside link) ──
    const titleEl = link.querySelector('h1, h2, h3, h4, h5, strong, [class*="title"]:not([class*="subtitle"])');
    if (titleEl) {
        const t = titleEl.innerText?.trim();
        if (t && t.length > 3 && t.length < 200) title = t;
    }

    // ── Strategy B: Class hint based selectors ──
    if (!company) {
        const c = link.querySelector('[class*="company"], [class*="subtitle"]')?.innerText?.trim();
        if (c && c.length < 150) company = c;
    }
    if (!location) {
        const l = link.querySelector('[class*="location"], [class*="caption"], [class*="metadata"]')?.innerText?.trim();
        if (l && l.length < 150) location = l;
    }
    if (!date) {
        const d = link.querySelector('time, [class*="date"], [class*="posted"], [class*="listed"]')?.innerText?.trim();
        if (d && d.length < 80) date = d;
    }

    // ── Strategy C: Walk direct children divs/spans (positional) ──
    if (!title || !company || !location) {
        // Find the deepest container with multiple sibling text nodes
        const allDivs = link.querySelectorAll('div, span, p');
        const textElements = Array.from(allDivs).filter(el => {
            const t = el.innerText?.trim();
            return t && t.length > 2 && t.length < 200 &&
                   !el.querySelector('div, p') && // leaf-ish
                   !t.match(/^view\s+job$/i);
        });

        // Get unique texts in order
        const seen = new Set();
        const uniqueTexts = [];
        for (const el of textElements) {
            const t = el.innerText.trim().replace(/\s+/g, ' ');
            if (!seen.has(t)) {
                seen.add(t);
                uniqueTexts.push(t);
            }
        }

        // Map by position: 0=title, 1=company, 2=location, 3=date
        if (!title && uniqueTexts[0]) title = uniqueTexts[0];
        if (!company && uniqueTexts[1]) company = uniqueTexts[1];
        if (!location && uniqueTexts[2]) location = uniqueTexts[2];
        if (!date && uniqueTexts[3]) date = uniqueTexts[3];
    }

    // ── Strategy D: Parse innerText if still missing fields ──
    if (!title || (title === company)) {
        const fullText = link.innerText?.trim() || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^view\s+job$/i));

        if (lines.length >= 1 && (!title || title.length < 3)) title = lines[0];
        if (lines.length >= 2 && !company) company = lines[1];
        if (lines.length >= 3 && !location) location = lines[2];
        if (lines.length >= 4 && !date) date = lines[3];

        // Worst case: concatenated single-line text
        if (lines.length === 1 && lines[0]) {
            const parsed = parseConcatenatedJobText(lines[0]);
            if (parsed.title) title = parsed.title;
            if (parsed.company && !company) company = parsed.company;
            if (parsed.location && !location) location = parsed.location;
        }
    }

    if (!title || title.length < 3) return null;

    // Date detection: if date field has wrong content, try to find it in any field
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
        jobUrl: `https://www.linkedin.com/jobs/view/${jobId}`
    };
}

/**
 * Concatenated text parser:
 * "ESS Solutions Engineer - Finland Sungrow Europe Helsinki (On-site) View job"
 * Pattern: {Title} {Company} {City (Mode)} View job
 */
function parseConcatenatedJobText(text) {
    const result = { title: null, company: null, location: null };
    let cleaned = text.replace(/\s*(View\s+job|Apply\s+now|See\s+more)\s*$/i, '').trim();

    // Find location pattern: "City (On-site|Hybrid|Remote)" at end
    const locMatch = cleaned.match(/^(.+?)\s+([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s,&'.\-]+?\s*\((?:On-site|Hybrid|Remote(?:\s*work)?)\))\s*$/i);
    if (locMatch) {
        const beforeLoc = locMatch[1].trim();
        result.location = locMatch[2].trim();

        // Now we have "{title} {company}". Try to detect company by capitalization patterns.
        // Heuristic: Company name is usually 1-3 capitalized words at end
        // E.g. "ESS Solutions Engineer - Finland Sungrow Europe" → title="ESS Solutions Engineer - Finland", company="Sungrow Europe"

        // Try to find company suffix patterns first
        const companySuffixMatch = beforeLoc.match(/^(.+?)\s+([A-Z][\w&]+(?:\s+[A-Z][\w&]+){0,3})$/);
        if (companySuffixMatch) {
            result.title = companySuffixMatch[1].trim();
            result.company = companySuffixMatch[2].trim();
        } else {
            // Can't reliably split — keep whole as title
            result.title = beforeLoc;
        }
    } else {
        result.title = cleaned;
    }

    return result;
}

function closeModal(modal) {
    // Try multiple close button selectors
    const closeBtn = modal.querySelector('button[aria-label*="Dismiss" i]')
                  || modal.querySelector('button[aria-label*="close" i]')
                  || modal.querySelector('.artdeco-modal__dismiss')
                  || modal.querySelector('button.artdeco-button--circle')
                  || modal.querySelector('svg[data-test-icon="close"]')?.closest('button');
    if (closeBtn) {
        closeBtn.click();
    } else {
        // Fallback: press Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

const q = (sel) => document.querySelector(sel);
const qq = (sel) => Array.from(document.querySelectorAll(sel));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractPublicIdentifier(url) {
    const match = url.match(/\/in\/([^/?#]+)/);
    return match ? match[1] : null;
}

function extractPicUrl(profilePicture) {
    if (!profilePicture) return null;
    if (typeof profilePicture === 'string') return profilePicture;
    // LinkedIn nested image structure
    const artifacts = profilePicture.displayImageReference?.vectorImage?.artifacts;
    if (artifacts && artifacts.length > 0) {
        const root = profilePicture.displayImageReference.vectorImage.rootUrl;
        const largest = artifacts[artifacts.length - 1];
        return root + largest.fileIdentifyingUrlPathSegment;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════
// INIT — wait for page to settle, then inject button
// ═══════════════════════════════════════════════════════════════════════

function init() {
    // Wait for LinkedIn's SPA to render
    setTimeout(() => {
        injectFloatingButton();
    }, 1500);
}

// LinkedIn is SPA — listen for URL changes
let lastUrl = window.location.href;
new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // Remove old button, inject new one if on profile page
        const oldBtn = document.getElementById('lri-save-button');
        if (oldBtn) oldBtn.remove();
        if (window.location.href.match(/\/in\//)) {
            setTimeout(injectFloatingButton, 1500);
        }
    }
}).observe(document, { subtree: true, childList: true });

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
