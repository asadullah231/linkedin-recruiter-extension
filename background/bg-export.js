/**
 * BACKGROUND — XLSX EXPORT (SheetJS)
 * ───────────────────────────────────
 * Builds a one-row-per-profile XLSX (top job only) from saved profiles.
 * Relies on the global XLSX from lib/xlsx.full.min.js (loaded via
 * importScripts in background.js). pickTopJob() lives here because it is
 * only used to choose which job each profile's row represents.
 */

// Pick the single most senior / "top" job from a recruiter's hiring posts.
// 1. AI-flagged isTopJob wins outright.
// 2. Otherwise score titles by seniority keywords.
// 3. Fall back to the first post.
function pickTopJob(posts) {
    if (!posts || posts.length === 0) return null;
    if (posts.length === 1) return posts[0];

    // 1. AI-tagged
    const aiTop = posts.find(p => p.isTopJob === true);
    if (aiTop) return aiTop;

    // 2. Heuristic scoring (higher = more senior)
    const tiers = [
        [/\b(chief|c[eofitm]o|founder|partner)\b/i,                    100],
        [/\b(vp|vice\s*president|svp|evp)\b/i,                          80],
        [/\b(director|head\s+of)\b/i,                                   65],
        [/\b(senior\s+manager|sr\.?\s+manager|principal)\b/i,           50],
        [/\b(manager|lead|architect|staff)\b/i,                         35],
        [/\b(senior|sr\.?)\b/i,                                         25],
        [/\b(specialist|consultant|engineer|developer|designer|analyst)\b/i, 10],
        [/\b(junior|jr\.?|associate|entry|intern|trainee|graduate)\b/i, -10]
    ];

    let bestIdx = 0, bestScore = -1000;
    posts.forEach((p, i) => {
        const t = (p.title || '').toLowerCase();
        let score = 0;
        for (const [rx, val] of tiers) {
            if (rx.test(t)) { score = val; break; }
        }
        if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    return posts[bestIdx];
}

function buildXlsxBlob(profiles) {
    // Lazy-load XLSX only when export is triggered — skips 952KB on every SW startup
    if (typeof XLSX === 'undefined') {
        try { importScripts('lib/xlsx.full.min.js'); } catch(e) { throw new Error('XLSX load failed: ' + e.message); }
    }

    // 1 row PER PROFILE — only the top job (no more multiple rows for the same recruiter)
    const rows = [];
    for (const p of profiles) {
        const posts = p.hiringPosts || [];
        if (posts.length === 0) continue;

        const j = pickTopJob(posts) || posts[0];

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
            'Total Jobs':    posts.length,   // for context — how many we found in total
            'Followers':     p.followers || '',
            'Connections':   p.connections || '',
            'Scraped At':    p.scrapedAt || ''
        });
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
