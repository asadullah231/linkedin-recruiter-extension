/**
 * BACKGROUND — CLOSED-JOB FILTER + AI TOP-JOB RANKING
 * ────────────────────────────────────────────────────
 *  - filterClosedJobs(): visits each job URL and drops the ones LinkedIn
 *    marks as closed / no-longer-accepting.
 *  - rankTopJobsWithAI(): asks OpenRouter to pick the most senior role per
 *    recruiter and tags it isTopJob: true.
 */

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

        // ── CONCURRENT: check up to 5 jobs in parallel (5× faster than sequential) ──
        const BATCH = 5;
        const results = [];

        for (let i = 0; i < posts.length; i += BATCH) {
            const batch = posts.slice(i, i + BATCH);
            const batchResults = await Promise.all(batch.map(async (job) => {
                if (!job.jobUrl) return { job, closed: false };
                try {
                    const closed = await isJobClosed(job.jobUrl);
                    return { job, closed };
                } catch (err) {
                    return { job, closed: false, hadError: true, errMsg: err.message };
                }
            }));
            results.push(...batchResults);
            // Small pause between batches — polite to LinkedIn
            if (i + BATCH < posts.length) await sleep(300);
        }

        const survivors = [];
        for (const { job, closed, hadError, errMsg } of results) {
            if (hadError) {
                survivors.push(job); // fail-open
                errored++;
                bulkLog(`  ⚠️ Check failed (kept): ${(job.title || 'Untitled').substring(0, 50)} — ${(errMsg || '').substring(0, 50)}`, 'error');
            } else if (closed) {
                removed++;
                bulkLog(`  ⏭ Closed:  ${(job.title || 'Untitled').substring(0, 70)}`, 'info');
            } else {
                survivors.push(job);
                kept++;
                bulkLog(`  ✅ Live:    ${(job.title || 'Untitled').substring(0, 70)}`, 'success');
            }
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
    // Be conservative — only match phrases LinkedIn actually shows in the
    // closed banner, not generic substrings that could appear in body copy.
    const textSignals = [
        /no longer accepting applications/i,
        /this job is no longer available/i,
        /job is no longer accepting applications/i,
        /this position has been filled/i,
        /this job has been removed/i,
        /this job posting is no longer/i
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
