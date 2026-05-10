/**
 * BACKGROUND SERVICE WORKER — V0.2.0
 * ───────────────────────────────────
 * Manages:
 *  - Single profile saves (manual button click)
 *  - Bulk profile scraping queue
 *  - Job page enrichment (visits each hiring post URL)
 *  - Progress tracking + notifications to popup
 */

// Load SheetJS for XLSX generation in service worker
try { importScripts('lib/xlsx.full.min.js'); } catch (e) { console.error('XLSX lib load failed:', e); }

console.log('🟢 LRI Background v0.15.1 loaded');

// In-memory bulk scrape state (resets on service worker restart)
let bulkState = {
    isRunning: false,
    queue: [],
    totalUrls: 0,
    currentIndex: 0,
    delay: 15,
    enrichJobs: true,
    activeTabId: null,
    pendingProfileResolve: null,
    pendingJobResolve: null,
    log: []
};

// ═══════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'saveProfile') {
        saveProfile(message.data)
            .then(result => {
                // If bulk mode is running, also resolve the pending promise
                if (bulkState.isRunning && bulkState.pendingProfileResolve) {
                    bulkState.pendingProfileResolve(message.data);
                    bulkState.pendingProfileResolve = null;
                }
                sendResponse({ success: true, result });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'jobScraped') {
        // Job page extracted data — used during bulk enrichment
        if (bulkState.pendingJobResolve) {
            bulkState.pendingJobResolve(message.data || null);
            bulkState.pendingJobResolve = null;
        }
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'getProfiles') {
        getAllProfiles()
            .then(profiles => sendResponse({ success: true, profiles }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'deleteProfile') {
        deleteProfile(message.profileUrl)
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'clearAll') {
        chrome.storage.local.set({ profiles: {} })
            .then(() => {
                chrome.action.setBadgeText({ text: '' });
                sendResponse({ success: true });
            });
        return true;
    }

    if (message.action === 'startBulk') {
        startBulkScrape(message.urls, message.options || {})
            .then(result => sendResponse({ success: true, ...result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === 'stopBulk') {
        bulkState.isRunning = false;
        bulkLog('⏹ Stopped by user', 'error');
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'getBulkState') {
        sendResponse({
            success: true,
            state: {
                isRunning: bulkState.isRunning,
                currentIndex: bulkState.currentIndex,
                totalUrls: bulkState.totalUrls,
                log: bulkState.log.slice(-30)
            }
        });
        return true;
    }

    if (message.action === 'setAutoPull') {
        if (message.enabled) {
            chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
            console.log('🤖 Auto-pull ENABLED (every 30s)');
        } else {
            chrome.alarms.clear('auto-pull');
            console.log('🛑 Auto-pull DISABLED');
        }
        updateBadge();
        sendResponse({ success: true });
        return true;
    }
});

// ═══════════════════════════════════════════════════════════════════════
// AUTO-PULL — periodic check for new URLs from n8n
// ═══════════════════════════════════════════════════════════════════════

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'auto-pull') return;
    if (bulkState.isRunning) {
        console.log('🤖 Auto-pull skipped: scrape already running');
        return;
    }

    try {
        const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
        if (!n8nSettings.autoPull || !n8nSettings.pullUrl) return;

        const headers = { 'Content-Type': 'application/json' };
        if (n8nSettings.apiKey) headers['Authorization'] = `Bearer ${n8nSettings.apiKey}`;

        const res = await fetch(n8nSettings.pullUrl, { method: 'GET', headers });
        if (!res.ok) {
            console.log(`🤖 Auto-pull HTTP ${res.status}`);
            return;
        }

        const data = await res.json();
        const urls = extractUrls(data);

        // Diagnostic: how many raw items did we receive vs. how many valid URLs
        const rawCount = (Array.isArray(data) ? data
                        : data?.urls || data?.data || data?.items || []).length;

        if (urls.length === 0) {
            if (rawCount > 0) {
                console.warn(`⚠️ Auto-pull: received ${rawCount} items but 0 valid LinkedIn URLs.`);
                console.warn('First item keys:', Object.keys((data?.urls || data?.data || [])[0] || {}));
                console.warn('First item:', (data?.urls || data?.data || [])[0]);
            } else {
                console.log('🤖 Auto-pull: no pending URLs');
            }
            return;
        }

        console.log(`🤖 Auto-pull: ${urls.length} valid URLs → starting scrape`);
        console.log('First URL:', urls[0]);
        await startBulkScrape(urls, { delay: 6, enrichJobs: false });
    } catch (err) {
        console.error('🤖 Auto-pull error:', err);
    }
});

function extractUrls(data) {
    let items = [];
    if (Array.isArray(data)) items = data;
    else if (Array.isArray(data?.urls)) items = data.urls;
    else if (Array.isArray(data?.data)) items = data.data;
    else if (Array.isArray(data?.items)) items = data.items;

    const urls = [];
    const seen = new Set();
    for (const item of items) {
        let url = null;
        if (typeof item === 'string') url = item;
        else if (item && typeof item === 'object') {
            // Try every common variant — case-insensitive last-resort
            url = item['Profile URL'] || item.profileUrl || item.url
                || item['LinkedIn-Profile'] || item.linkedinUrl
                || item.ProfileURL || item.ProfileUrl || item['Profile Url']
                || item.profile_url || item['profile-url'];
            if (!url) {
                // Fallback: scan ALL string fields for a LinkedIn URL
                for (const k of Object.keys(item)) {
                    const v = item[k];
                    if (typeof v === 'string' && /linkedin\.com\/in\//i.test(v)) {
                        url = v;
                        break;
                    }
                }
            }
        }
        if (!url) continue;
        const m = String(url).match(/https?:\/\/[\w.]*linkedin\.com\/in\/[^\s,"'<>]+/i);
        if (m) {
            const clean = m[0].replace(/\/$/, '');
            if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
        }
    }
    return urls;
}

// Re-arm alarm on service worker startup — only if user has Auto Mode ON
chrome.runtime.onStartup.addListener(async () => {
    const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
    if (n8nSettings.autoPull) {
        chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
        console.log('🤖 Auto-pull re-armed on startup');
    } else {
        console.log('⏸ Auto-pull paused on startup (user OFF)');
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    const { n8nSettings = {}, aiSettings = {} } = await chrome.storage.local.get(['n8nSettings', 'aiSettings']);

    // Force-fix URLs + behaviour flags. autoPull stays user-controlled.
    n8nSettings.pullUrl = 'https://n8n.emergeautomation.tech/webhook/pull-urls';
    n8nSettings.callbackUrl = 'https://n8n.emergeautomation.tech/webhook/scrape-results';
    n8nSettings.autoSend = true;
    n8nSettings.stopAfterBatch = true;
    if (typeof n8nSettings.autoPull === 'undefined') n8nSettings.autoPull = false;  // default OFF on first install
    await chrome.storage.local.set({ n8nSettings });

    aiSettings.filterClosed = true;
    await chrome.storage.local.set({ aiSettings });

    if (n8nSettings.autoPull) {
        chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
        console.log('🤖 Auto-pull re-armed (user had it ON)');
    } else {
        chrome.alarms.clear('auto-pull');
        console.log('⏸ Auto-pull paused (default / user OFF)');
    }
});

// ═══════════════════════════════════════════════════════════════════════
// BULK SCRAPE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════

async function startBulkScrape(urls, options) {
    if (bulkState.isRunning) {
        return { error: 'Bulk scrape already in progress' };
    }

    // Initialize state
    bulkState = {
        isRunning: true,
        queue: urls,
        totalUrls: urls.length,
        currentIndex: 0,
        delay: options.delay || 15,
        enrichJobs: options.enrichJobs !== false,
        activeTabId: null,
        pendingProfileResolve: null,
        pendingJobResolve: null,
        log: []
    };

    bulkLog(`🚀 Starting bulk scrape: ${urls.length} profiles (delay: ${bulkState.delay}s)`, 'info');

    // Run async (don't await — caller should not block)
    runBulkQueue().catch(err => {
        bulkLog(`💥 Fatal error: ${err.message}`, 'error');
        bulkState.isRunning = false;
    });

    return { started: true, totalUrls: urls.length };
}

async function runBulkQueue() {
    let savedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < bulkState.queue.length; i++) {
        if (!bulkState.isRunning) {
            bulkLog(`⏹ Stopped at ${i}/${bulkState.queue.length}`, 'error');
            break;
        }

        bulkState.currentIndex = i;
        const url = bulkState.queue[i];
        bulkLog(`[${i + 1}/${bulkState.queue.length}] ${shortUrl(url)}`, 'info');

        let hadJobs = false;
        try {
            const profileData = await scrapeProfileInTab(url);

            if (!profileData) {
                bulkLog(`  ⚠️ No data — likely auth/private`, 'error');
                skippedCount++;
            } else {
                const name = profileData.fullName || 'Unknown';
                const jobsCount = profileData.hiringPosts?.length || 0;

                // ── SKIP profiles with 0 hiring jobs (don't save, no delay) ──
                if (jobsCount === 0) {
                    bulkLog(`  ⏭ ${name} — 0 jobs, skipping`, 'info');
                    // Delete the auto-save (saveProfile triggered when content.js posted)
                    await deleteProfile(url);
                    skippedCount++;
                } else {
                    bulkLog(`  ✅ ${name} — ${jobsCount} hiring jobs`, 'success');
                    hadJobs = true;
                    savedCount++;

                    // Optional enrichment (off by default for speed)
                    if (bulkState.enrichJobs && profileData.hiringPosts) {
                        for (let j = 0; j < profileData.hiringPosts.length; j++) {
                            if (!bulkState.isRunning) break;
                            const job = profileData.hiringPosts[j];
                            if (!job.jobUrl) continue;
                            bulkLog(`    → Enrich ${j + 1}/${profileData.hiringPosts.length}`, 'info');
                            try {
                                const jobDetails = await scrapeJobInTab(job.jobUrl);
                                if (jobDetails) Object.assign(job, jobDetails);
                            } catch {}
                            if (bulkState.isRunning) await sleep(2000 + Math.random() * 1500);
                        }
                        profileData.enriched = true;
                        await saveProfile(profileData);
                    }
                }
            }
        } catch (err) {
            bulkLog(`  ❌ ${err.message.substring(0, 60)}`, 'error');
            skippedCount++;
        }

        // ── SMART DELAY ──
        // Only wait full delay if profile had jobs (= we'll do same heavy work next)
        // For empty/failed profiles, skip with minimal pause (just enough to not spam LinkedIn)
        if (i < bulkState.queue.length - 1 && bulkState.isRunning) {
            const wait = hadJobs
                ? bulkState.delay * 1000 + Math.random() * 3000
                : 1500 + Math.random() * 1000;  // 1.5-2.5s for empty profiles
            if (hadJobs) {
                bulkLog(`  ⏱ Waiting ${Math.round(wait / 1000)}s...`, 'info');
            }
            await sleep(wait);
        }
    }

    bulkState.isRunning = false;
    bulkLog(`✅ Done! Saved ${savedCount}, skipped ${skippedCount} of ${bulkState.totalUrls}`, 'success');

    try {
        chrome.notifications?.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Bulk Scrape Complete',
            message: `Saved ${savedCount} profiles with hiring jobs (${skippedCount} skipped)`
        });
    } catch {}

    // ── Filter closed jobs (before AI ranking) ──
    try {
        const { aiSettings = {} } = await chrome.storage.local.get('aiSettings');
        if (aiSettings.filterClosed) {
            bulkLog('🚫 Filtering out closed jobs...', 'info');
            const stats = await filterClosedJobs();
            bulkLog(`🚫 Removed ${stats.removed} closed jobs (kept ${stats.kept})`, 'success');
        }
    } catch (err) {
        bulkLog(`⚠️ Closed-job filter error: ${err.message}`, 'error');
    }

    // ── AI top-job ranking (before n8n send) ──
    try {
        const { aiSettings = {} } = await chrome.storage.local.get('aiSettings');
        if (aiSettings.enabled && aiSettings.apiKey) {
            bulkLog('🤖 AI ranking top jobs per profile...', 'info');
            await rankTopJobsWithAI(aiSettings);
            bulkLog('✅ AI ranking complete.', 'success');
        }
    } catch (err) {
        bulkLog(`⚠️ AI ranking error: ${err.message}`, 'error');
    }

    // ── n8n auto-callback ──
    try {
        const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
        if (n8nSettings.autoSend && n8nSettings.callbackUrl) {
            await sendBulkResultsToN8n(n8nSettings, savedCount, skippedCount);
        }

        // ── stop-after-batch: disable auto-pull when batch completes ──
        if (n8nSettings.autoPull && n8nSettings.stopAfterBatch) {
            chrome.alarms.clear('auto-pull');
            n8nSettings.autoPull = false;
            await chrome.storage.local.set({ n8nSettings });
            bulkLog('⏹ Stop-after-batch triggered — auto-pull DISABLED.', 'info');
            updateBadge();
        }
    } catch (err) {
        bulkLog(`⚠️ n8n callback error: ${err.message}`, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// CLOSED-JOB FILTER
// Visits each job URL via fetch() and removes jobs showing
// "No longer accepting applications" / "This job is no longer available"
// ═══════════════════════════════════════════════════════════════════════

async function filterClosedJobs() {
    const profiles = await getAllProfiles();
    let removed = 0;
    let kept = 0;
    let errored = 0;

    for (const profile of profiles) {
        const posts = profile.hiringPosts || [];
        if (posts.length === 0) continue;

        const survivors = [];
        for (const job of posts) {
            if (!job.jobUrl) {
                survivors.push(job);
                continue;
            }

            try {
                const closed = await isJobClosed(job.jobUrl);
                if (closed) {
                    removed++;
                    bulkLog(`  ⏭ Closed:  ${(job.title || 'Untitled').substring(0, 70)}`, 'info');
                } else {
                    survivors.push(job);
                    kept++;
                    bulkLog(`  ✅ Live:    ${(job.title || 'Untitled').substring(0, 70)}`, 'success');
                }
            } catch (err) {
                // Network/parse error → keep the job (fail-open) but flag
                survivors.push(job);
                errored++;
                bulkLog(`  ⚠️ Check failed (kept): ${(job.title || 'Untitled').substring(0, 50)} — ${err.message.substring(0, 50)}`, 'error');
            }

            // Polite throttle
            await sleep(200);
        }

        profile.hiringPosts = survivors;
        profile.hiringPostsCount = survivors.length;
        await saveProfile(profile);
    }

    bulkLog(`🚫 Filter summary: kept ${kept}, removed ${removed}, errored ${errored}`, 'info');
    return { removed, kept, errored };
}

async function isJobClosed(jobUrl) {
    // Try the public guest endpoint FIRST — gives clean static HTML even when
    // the regular page returns SPA shell. Convert /jobs/view/<id> → /jobs-guest/jobs/api/jobPosting/<id>
    const idMatch = jobUrl.match(/\/jobs\/view\/(\d+)/);
    const jobId = idMatch?.[1];

    let html = '';
    let httpStatus = 0;

    // Attempt 1: guest API (no auth needed, returns rendered HTML)
    if (jobId) {
        try {
            const guestUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
            const r = await fetch(guestUrl, {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'text/html,application/xhtml+xml' }
            });
            httpStatus = r.status;
            if (r.ok) html = await r.text();
            else if (r.status === 404 || r.status === 410) return true;
        } catch (_) { /* fall through */ }
    }

    // Attempt 2: full job URL fallback
    if (!html) {
        try {
            const r = await fetch(jobUrl, {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'text/html' }
            });
            httpStatus = r.status;
            if (r.ok) html = await r.text();
            else if (r.status === 404 || r.status === 410) return true;
        } catch (_) { return false; }
    }

    if (!html) return false;

    // ── 1. Visible-text signals (rendered banners) ─────────────────────────
    const textSignals = [
        /no longer accepting applications/i,
        /this job is no longer available/i,
        /job is no longer accepting applications/i,
        /no longer accepting/i,
        /this position has been filled/i,
        /position has been filled/i,
        /this job has been removed/i,
        /this opening is no longer/i
    ];
    if (textSignals.some(rx => rx.test(html))) return true;

    // ── 2. Voyager / API JSON state signals ───────────────────────────────
    const jsonSignals = [
        /"jobState"\s*:\s*"(CLOSED|REMOVED|FILLED|EXPIRED|UNFILLED)"/i,
        /"acceptingApplications"\s*:\s*false/i,
        /"applyMethod"\s*:\s*"NONE"/i,
        /"jobApplicationLimitReached"\s*:\s*true/i,
        /"validThrough"\s*:\s*"(\d{4}-\d{2}-\d{2})/   // we'll re-verify the date below
    ];
    for (const rx of jsonSignals) {
        const m = html.match(rx);
        if (!m) continue;
        if (rx.source.includes('validThrough')) {
            // Only treat as closed if validThrough is in the past
            try {
                const d = new Date(m[1]);
                if (!isNaN(d) && d < new Date()) return true;
            } catch (_) {}
        } else {
            return true;
        }
    }

    // ── 3. DOM class signals ──────────────────────────────────────────────
    const domSignals = [
        /jobs-unified-top-card--closed/i,
        /job-state[^"']*closed/i,
        /data-test-job-state=["']closed["']/i,
        /class="[^"]*closed[^"]*"[^>]*>\s*Closed\s*</i
    ];
    if (domSignals.some(rx => rx.test(html))) return true;

    return false;
}

// ═══════════════════════════════════════════════════════════════════════
// AI TOP-JOB RANKING via OpenRouter
// Picks the most senior role per recruiter and tags it isTopJob: true
// ═══════════════════════════════════════════════════════════════════════

async function rankTopJobsWithAI(aiSettings) {
    const profiles = await getAllProfiles();
    const candidates = profiles.filter(p => (p.hiringPosts || []).length > 1);

    if (candidates.length === 0) {
        bulkLog('🤖 No profiles with 2+ jobs — skipping AI ranking.', 'info');
        // Still mark single-job profiles' only job as top
        for (const p of profiles) {
            if ((p.hiringPosts || []).length === 1) {
                p.hiringPosts[0].isTopJob = true;
                p.topJob = p.hiringPosts[0];
                await saveProfile(p);
            }
        }
        return;
    }

    bulkLog(`🤖 Ranking ${candidates.length} profiles with AI (model: ${aiSettings.model})...`, 'info');

    let success = 0;
    let failed = 0;

    for (const profile of candidates) {
        try {
            const titles = profile.hiringPosts.map((j, i) => `${i}. ${j.title || 'Untitled'}`);
            const topIdx = await callOpenRouterForTopJob(aiSettings, titles);

            // Tag jobs
            profile.hiringPosts.forEach((j, i) => { j.isTopJob = (i === topIdx); });
            profile.topJob = profile.hiringPosts[topIdx] || profile.hiringPosts[0];

            await saveProfile(profile);
            success++;
        } catch (err) {
            failed++;
            console.warn(`AI rank failed for ${profile.fullName}:`, err.message);
            // Fallback: mark first job as top
            if (profile.hiringPosts[0]) {
                profile.hiringPosts[0].isTopJob = true;
                profile.topJob = profile.hiringPosts[0];
                await saveProfile(profile);
            }
        }

        // Small delay between API calls (rate-limit polite)
        await sleep(150);
    }

    // Single-job profiles → automatically top
    for (const p of profiles) {
        if ((p.hiringPosts || []).length === 1 && !p.hiringPosts[0].isTopJob) {
            p.hiringPosts[0].isTopJob = true;
            p.topJob = p.hiringPosts[0];
            await saveProfile(p);
        }
    }

    bulkLog(`🤖 AI ranking: ${success} succeeded, ${failed} failed`, 'success');
}

async function callOpenRouterForTopJob(aiSettings, titles) {
    const systemPrompt = "You are a hiring intelligence analyst. Given a list of job titles, return ONLY the 0-based index of the MOST SENIOR role. Seniority order: C-level/Executive > VP > Director > Senior Manager > Manager > Senior IC > Mid > Junior > Intern. Respond with valid JSON only: {\"topIndex\": N, \"reasoning\": \"brief\"}";

    const userMsg = `Job titles:\n${titles.join('\n')}\n\nReturn JSON.`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${aiSettings.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/asadullah231/linkedin-recruiter-extension',
            'X-Title': 'LinkedIn Recruiter Intelligence'
        },
        body: JSON.stringify({
            model: aiSettings.model || 'google/gemini-flash-1.5',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMsg }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 100,
            temperature: 0
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter HTTP ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in AI response');

    let parsed;
    try {
        // Try direct parse
        parsed = JSON.parse(content);
    } catch {
        // Try extracting JSON from markdown code block
        const m = content.match(/\{[^}]+\}/s);
        if (m) parsed = JSON.parse(m[0]);
    }

    const idx = parsed?.topIndex;
    if (typeof idx !== 'number' || idx < 0 || idx >= titles.length) {
        throw new Error(`Invalid topIndex: ${idx}`);
    }
    return idx;
}

// ═══════════════════════════════════════════════════════════════════════
// n8n CALLBACK (auto-send after bulk completes)
// ═══════════════════════════════════════════════════════════════════════

async function sendBulkResultsToN8n(settings, savedCount, skippedCount) {
    const profiles = await getAllProfiles();

    // Build XLSX binary using SheetJS
    let xlsxBlob = null;
    try {
        if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
        xlsxBlob = buildXlsxBlob(profiles);
        bulkLog(`📊 Built XLSX (${(xlsxBlob.size / 1024).toFixed(1)} KB)`, 'info');
    } catch (err) {
        bulkLog(`⚠️ XLSX build failed: ${err.message}. Falling back to JSON.`, 'error');
    }

    const profileUrls = profiles.map(p => p.profileUrl).filter(Boolean);
    const meta = {
        source: 'linkedin-recruiter-extension',
        version: '0.11.0',
        timestamp: new Date().toISOString(),
        saved: savedCount,
        skipped: skippedCount,
        total: bulkState.totalUrls,
        profileUrls
    };

    bulkLog(`📤 Auto-sending results to n8n: ${settings.callbackUrl}`, 'info');

    let res;
    if (xlsxBlob) {
        // Multipart upload: file + meta JSON
        const formData = new FormData();
        formData.append('file', xlsxBlob, `jobs-${Date.now()}.xlsx`);
        formData.append('meta', JSON.stringify(meta));
        formData.append('profiles', JSON.stringify(profiles));

        const headers = {};
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

        res = await fetch(settings.callbackUrl, {
            method: 'POST',
            headers,
            body: formData
        });
    } else {
        // Fallback: JSON only (no XLSX)
        const headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
        res = await fetch(settings.callbackUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...meta, run: { saved: savedCount, skipped: skippedCount, total: bulkState.totalUrls }, profiles })
        });
    }

    if (res.ok) {
        bulkLog(`✅ n8n callback OK (HTTP ${res.status})`, 'success');
    } else {
        bulkLog(`⚠️ n8n callback HTTP ${res.status}`, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// XLSX BUILDER (uses SheetJS)
// ═══════════════════════════════════════════════════════════════════════

function buildXlsxBlob(profiles) {
    // Build flat rows: 1 row per (profile × job)
    const rows = [];
    for (const p of profiles) {
        const posts = p.hiringPosts || [];
        if (posts.length === 0) continue;

        for (const j of posts) {
            rows.push({
                'Profile URL':   p.profileUrl || '',
                'Full Name':     p.fullName || '',
                'First Name':    p.firstName || '',
                'Last Name':     p.lastName || '',
                'Job Title':     j.title || '',
                'Job URL':       j.jobUrl || '',
                'Job Location':  j.location || '',
                'Company':       j.companyName || j.company || p.currentCompany || '',
                'Headline':      p.headline || '',
                'Source':        j.source || 'hiring_badge',
                'Post URL':      j.postUrl || '',
                'Is Top Job':    j.isTopJob ? 'TRUE' : '',
                'Followers':     p.followers || '',
                'Connections':   p.connections || '',
                'Scraped At':    p.scrapedAt || ''
            });
        }
    }

    if (rows.length === 0) {
        rows.push({ 'Profile URL': '(no jobs scraped)' });
    }

    // Create workbook + sheet
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Jobs');

    // Auto-size columns (approximate)
    const headers = Object.keys(rows[0]);
    ws['!cols'] = headers.map(h => {
        const maxLen = Math.max(h.length, ...rows.map(r => String(r[h] || '').length));
        return { wch: Math.min(Math.max(maxLen + 2, 10), 60) };
    });

    // Write to ArrayBuffer
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
}

// ═══════════════════════════════════════════════════════════════════════
// TAB MANAGEMENT — open URL, wait for data, close
// ═══════════════════════════════════════════════════════════════════════

async function scrapeProfileInTab(url) {
    return new Promise(async (resolve) => {
        let tabId = null;
        const timeout = setTimeout(() => {
            if (tabId) chrome.tabs.remove(tabId).catch(() => {});
            bulkState.pendingProfileResolve = null;
            resolve(null);
        }, 60000); // 60s max

        bulkState.pendingProfileResolve = (data) => {
            clearTimeout(timeout);
            if (tabId) {
                setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1000);
            }
            resolve(data);
        };

        try {
            const tab = await chrome.tabs.create({ url, active: false });
            tabId = tab.id;
            bulkState.activeTabId = tabId;

            // Wait for page to load + content script to inject
            // Then auto-trigger save by injecting a click on the floating button
            await waitForTabComplete(tabId, 30000);
            await sleep(4000); // Extra time for SPA + voyager data

            // Trigger the save by executing a script that clicks the button
            await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const btn = document.getElementById('lri-save-button');
                    if (btn) btn.click();
                }
            });

            // Now wait for pendingProfileResolve to be called by the saveProfile message
        } catch (err) {
            clearTimeout(timeout);
            bulkState.pendingProfileResolve = null;
            if (tabId) chrome.tabs.remove(tabId).catch(() => {});
            resolve(null);
        }
    });
}

async function scrapeJobInTab(jobUrl) {
    return new Promise(async (resolve) => {
        let tabId = null;
        const timeout = setTimeout(() => {
            if (tabId) chrome.tabs.remove(tabId).catch(() => {});
            bulkState.pendingJobResolve = null;
            resolve(null);
        }, 30000);

        bulkState.pendingJobResolve = (data) => {
            clearTimeout(timeout);
            if (tabId) {
                setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 500);
            }
            resolve(data);
        };

        try {
            const tab = await chrome.tabs.create({ url: jobUrl, active: false });
            tabId = tab.id;

            await waitForTabComplete(tabId, 20000);
            await sleep(2000);

            // Inject job-scraper.js (which auto-extracts and sends message)
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['job-scraper.js']
            });
        } catch (err) {
            clearTimeout(timeout);
            bulkState.pendingJobResolve = null;
            if (tabId) chrome.tabs.remove(tabId).catch(() => {});
            resolve(null);
        }
    });
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(false);
        }, timeoutMs);

        const listener = (id, changeInfo) => {
            if (id === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve(true);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════

function bulkLog(message, type = 'info') {
    const entry = {
        time: new Date().toISOString(),
        message,
        type
    };
    bulkState.log.push(entry);
    if (bulkState.log.length > 200) bulkState.log = bulkState.log.slice(-100);
    console.log(`[BULK] ${message}`);

    // Update extension icon badge with progress
    updateBadge();

    // Notify popup if open
    chrome.runtime.sendMessage({
        action: 'bulkProgress',
        currentIndex: bulkState.currentIndex,
        totalUrls: bulkState.totalUrls,
        isRunning: bulkState.isRunning,
        latestLog: entry
    }).catch(() => {}); // Popup may not be open
}

function updateBadge() {
    try {
        if (bulkState.isRunning) {
            // Show "X/Y" or just current index
            const txt = `${bulkState.currentIndex + 1}/${bulkState.totalUrls}`;
            chrome.action.setBadgeText({ text: txt.length > 4 ? `${bulkState.currentIndex + 1}` : txt });
            chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });  // orange = scraping
            chrome.action.setTitle({ title: `🔄 Scraping ${bulkState.currentIndex + 1} of ${bulkState.totalUrls}...` });
        } else {
            chrome.storage.local.get('n8nSettings').then(({ n8nSettings = {} }) => {
                if (n8nSettings.autoPull) {
                    chrome.action.setBadgeText({ text: 'ON' });
                    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });  // green = auto-pull armed
                    chrome.action.setTitle({ title: '🤖 Auto-pull ON — checking n8n every 30s' });
                } else {
                    chrome.action.setBadgeText({ text: '' });
                    chrome.action.setTitle({ title: 'LinkedIn Recruiter Intelligence' });
                }
            });
        }
    } catch (err) {
        console.error('Badge update error:', err);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// STORAGE OPERATIONS (unchanged)
// ═══════════════════════════════════════════════════════════════════════

async function saveProfile(profileData) {
    if (!profileData || !profileData.profileUrl) {
        throw new Error('Invalid profile data — missing profileUrl');
    }

    const stored = await chrome.storage.local.get('profiles');
    const profiles = stored.profiles || {};
    profiles[profileData.profileUrl] = profileData;
    await chrome.storage.local.set({ profiles });

    const count = Object.keys(profiles).length;
    chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });

    return {
        savedAt: new Date().toISOString(),
        totalProfiles: count,
        profile: profileData.fullName
    };
}

async function getAllProfiles() {
    const stored = await chrome.storage.local.get('profiles');
    const profiles = stored.profiles || {};
    return Object.values(profiles).sort((a, b) =>
        new Date(b.scrapedAt) - new Date(a.scrapedAt)
    );
}

async function deleteProfile(profileUrl) {
    const stored = await chrome.storage.local.get('profiles');
    const profiles = stored.profiles || {};
    delete profiles[profileUrl];
    await chrome.storage.local.set({ profiles });
    const count = Object.keys(profiles).length;
    chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? '99+' : String(count)) : '' });
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shortUrl(url) {
    const m = url.match(/\/in\/([^/?]+)/);
    return m ? '/in/' + m[1] : url.substring(0, 60);
}

// Init badge on startup
chrome.runtime.onInstalled.addListener(async () => {
    const stored = await chrome.storage.local.get('profiles');
    const count = Object.keys(stored.profiles || {}).length;
    if (count > 0) {
        chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
    }
});
