/**
 * CONTENT SCRIPT — HIRING POSTS / JOBS EXTRACTION
 * ────────────────────────────────────────────────
 * Everything related to finding a recruiter's open roles:
 *   - the "Hiring: …" banner + "Show N jobs" modal
 *   - recent-activity post scan
 *   - background URL fetch + raw-HTML URN sweep fallbacks
 * Entry point is extractHiringPosts(voyagerData), called from
 * extractProfileData() in content-profile.js.
 */

// ═══════════════════════════════════════════════════════════════════════
// HIRING POSTS EXTRACTOR
// "Hiring: Field Service Engineer & 5 others" wala card
// ═══════════════════════════════════════════════════════════════════════

async function extractHiringPosts(voyagerData) {
    const posts = [];

    // Method 1: Already extracted from voyager <code> tags — seed but DON'T return.
    // We'll still run subsequent methods to enrich titles/locations missing
    // from the URN-only voyager scan.
    if (voyagerData?.hiringPosts?.length > 0) {
        console.log('🟢 LRI: Voyager seeded', voyagerData.hiringPosts.length, 'job(s) — enriching');
        const seen = new Set();
        for (const j of voyagerData.hiringPosts) {
            if (j.jobId && !seen.has(j.jobId)) {
                seen.add(j.jobId);
                posts.push(j);
            }
        }
    }

    // Method 2: Find hiring banner & click "Show N jobs"
    console.log('🟢 LRI: Looking for hiring banner...');
    const hiringBanner = findHiringBanner();

    if (hiringBanner) {
        console.log('🟢 LRI: Found hiring banner. text(0..120):', (hiringBanner.innerText || '').substring(0, 120));
        console.log('🟢 LRI: Banner outerHTML (0..600):', (hiringBanner.outerHTML || '').substring(0, 600));

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

    // ── Method 5.5 (CRITICAL for multi-job recruiters): fetch one of
    // LinkedIn's hiring-posts URLs in the background. LinkedIn lazy-loads
    // the modal contents on click for profiles with 2+ open roles, and
    // the click is React-isTrusted-gated, so we can't fake it. We try a
    // sequence of URLs that sometimes contain the same SSR data.
    //
    // Runs whenever a hiring banner was detected — even if we already
    // got SOME jobs (banner sometimes renders only the first one inline
    // and hides the rest behind 'Show N jobs', so we still need to fetch
    // to get the complete list).
    if (hiringBanner || posts.length === 0) {
        const slug = extractPublicIdentifier(window.location.href);
        console.log('🟢 LRI: Running URL fallbacks — current posts:', posts.length, 'slug:', slug);

        if (slug) {
            // ── Try: harvest the actual "Show N jobs" element href if any ──
            const showLink = q('a[href*="recent-activity"], a[href*="hiring"]')
                          || qq('a, button').find(el => /show\s+\d*\s*jobs?|see\s+\d*\s*jobs?/i.test(el.innerText || ''));
            if (showLink) {
                console.log('🟢 LRI: Found show-jobs element:',
                    showLink.tagName,
                    'href=', showLink.getAttribute?.('href'),
                    'data-attrs=', JSON.stringify(Object.fromEntries(
                        Array.from(showLink.attributes || []).filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])
                    )));
            } else {
                console.log('🟢 LRI: No show-jobs element found on page');
            }

            const candidateUrls = [
                `https://www.linkedin.com/in/${slug}/recent-activity/jobs/`,
                `https://www.linkedin.com/in/${slug}/recent-activity/all/`,
                showLink?.getAttribute?.('href') ? new URL(showLink.getAttribute('href'), window.location.origin).href : null
            ].filter(Boolean);

            const seen = new Set();
            const patterns = [
                /urn:li:(?:fsd_)?(?:jobPosting|jobs):(\d{6,})/g,
                /\/jobs\/view\/(\d{6,})/g,
                /["']jobPostingId["']\s*:\s*["']?(\d{6,})/g
            ];

            for (const url of candidateUrls) {
                try {
                    console.log('🟢 LRI: Trying fetch →', url);
                    const res = await fetch(url, { credentials: 'include', headers: { 'Accept': 'text/html' } });
                    console.log('🟢 LRI:   ↳ HTTP', res.status, 'final URL:', res.url);

                    if (!res.ok) continue;
                    const html = await res.text();
                    console.log('🟢 LRI:   ↳ body', html.length, 'bytes');

                    const before = seen.size;
                    for (const rx of patterns) {
                        let m;
                        while ((m = rx.exec(html)) !== null) seen.add(m[1]);
                    }
                    console.log('🟢 LRI:   ↳ found', seen.size - before, 'new job IDs (total', seen.size + ')');

                    if (seen.size > 0) break;  // got some, no need to try more URLs
                } catch (err) {
                    console.warn('🟡 LRI:   ↳ fetch failed:', err.message);
                }
            }

            // Dedupe against jobs we already harvested from the banner /
            // inline / activity passes — only ADD truly new IDs.
            const existingIds = new Set(posts.map(p => p.jobId).filter(Boolean));
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
                    source: 'recent_activity_fetch'
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

    // Method 5 (LAST RESORT): scan the raw page HTML for any LinkedIn
    // jobPosting URN or /jobs/view/<id> reference. Runs whenever a hiring
    // banner was seen OR posts is still empty, so we sweep up any IDs the
    // earlier methods missed even when we already got a few.
    if (hiringBanner || posts.length === 0) {
        console.log('🟢 LRI: Running raw HTML scan — current posts:', posts.length);
        try {
            // Trigger lazy-loaded content: scroll to bottom and back, then re-query
            try {
                window.scrollTo(0, document.body.scrollHeight);
                await sleep(800);
                window.scrollTo(0, 0);
                await sleep(300);
            } catch (_) {}

            const html = document.documentElement.outerHTML;
            const seen = new Set();

            // Pattern A: jobPosting URN (most reliable)
            const urnRx = /urn:li:(?:fsd_)?(?:jobPosting|jobs):(\d{6,})/g;
            let m;
            while ((m = urnRx.exec(html)) !== null) {
                const id = m[1];
                if (seen.has(id)) continue;
                seen.add(id);
            }

            // Pattern B: /jobs/view/<id> in any href / JSON string
            const viewRx = /\/jobs\/view\/(\d{6,})/g;
            while ((m = viewRx.exec(html)) !== null) {
                const id = m[1];
                if (seen.has(id)) continue;
                seen.add(id);
            }

            // Pattern C: jobPostingCardUnion / jobPostingId
            const cardRx = /["']jobPostingId["']\s*:\s*["']?(\d{6,})/g;
            while ((m = cardRx.exec(html)) !== null) {
                const id = m[1];
                if (seen.has(id)) continue;
                seen.add(id);
            }

            const existingIds = new Set(posts.map(p => p.jobId).filter(Boolean));
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
                    source: 'urn_scan'
                });
                added++;
            }

            if (added > 0) {
                console.log(`🟢 LRI: Raw HTML scan added ${added} NEW job(s) (total now ${posts.length})`);
            } else if (posts.length === 0) {
                console.log('🟢 LRI: No job IDs found anywhere in page HTML — profile likely has no active hiring posts');
            }
        } catch (err) {
            console.warn('⚠️ LRI: Raw HTML scan failed:', err.message);
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
        // Match wide variety of hiring-banner phrasings LinkedIn uses
        if (
            text.match(/^Hiring:/i) ||                    // "Hiring: <title>"
            text.match(/\bis hiring\b/i) ||                // "<X> is hiring"
            text.match(/\bShow\s+(\d+\s+)?jobs?\b/i) ||    // "Show job" / "Show 5 jobs"
            text.match(/\b(\d+)\s+open roles?\b/i) ||      // "5 open roles"
            text.match(/\b(\d+)\s+active hiring posts?\b/i) ||
            text.match(/^See\s+(\d+\s+)?jobs?\b/i) ||      // "See 3 jobs"
            text.match(/\bView\s+(\d+\s+)?(?:open\s+)?jobs?\b/i)
        ) {
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
