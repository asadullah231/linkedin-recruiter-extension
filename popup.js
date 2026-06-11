/**
 * POPUP UI LOGIC v0.4.0
 * ─────────────────────
 * Tabs: Saved Profiles | n8n (pull + scrape) | Export
 */

let allProfiles = [];
let pendingUrls = [];   // populated by Pull from n8n

// Hardcoded n8n endpoints (no longer user-editable)
const N8N_PULL_URL = 'https://n8n.emergeautomation.tech/webhook/pull-urls';
const N8N_CALLBACK_URL = 'https://n8n.emergeautomation.tech/webhook/scrape-results';

// ═══════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    await loadProfiles();
    setupTabSwitching();
    setupEventListeners();

    // ── Hard-enforce minimum delay of 7s — snap back if user types less ──
    const delayInput = document.getElementById('opt-delay');
    if (delayInput) {
        delayInput.addEventListener('change', () => {
            if (parseInt(delayInput.value) < 7) {
                delayInput.value = 7;
            }
        });
        delayInput.addEventListener('blur', () => {
            if (parseInt(delayInput.value) < 7) {
                delayInput.value = 7;
            }
        });
    }
    await syncBulkState();
    setupBulkProgressListener();
    await loadN8nSettings();
    setupN8nListeners();
    await refreshStatusIndicator();
    setInterval(refreshStatusIndicator, 2000);  // every 2 sec while popup is open
});

// ═══════════════════════════════════════════════════════════════════════
// STATUS INDICATOR (header pill + live bar)
// ═══════════════════════════════════════════════════════════════════════

async function refreshStatusIndicator() {
    const pill = document.getElementById('status-pill');
    const text = document.getElementById('status-text');
    const liveBar = document.getElementById('live-status-bar');
    if (!pill || !text) return;

    const [{ n8nSettings = {} }, bulkRes] = await Promise.all([
        chrome.storage.local.get('n8nSettings'),
        chrome.runtime.sendMessage({ action: 'getBulkState' }).catch(() => null)
    ]);

    const state = bulkRes?.state;
    pill.classList.remove('status-idle', 'status-active', 'status-scraping', 'status-error');

    if (state?.isRunning) {
        // Currently scraping
        pill.classList.add('status-scraping');
        text.textContent = `Scraping ${state.currentIndex + 1}/${state.totalUrls}`;

        // Show live bar across tabs
        liveBar.style.display = 'flex';
        document.getElementById('ls-action').textContent = 'Scraping profiles';
        document.getElementById('ls-current').textContent = state.currentIndex + 1;
        document.getElementById('ls-total').textContent = state.totalUrls;
        const pct = state.totalUrls > 0 ? ((state.currentIndex + 1) / state.totalUrls) * 100 : 0;
        document.getElementById('ls-bar-fill').style.width = pct + '%';
        const lastLog = state.log?.[state.log.length - 1];
        document.getElementById('ls-detail').textContent = lastLog?.message || 'Working...';
    } else if (n8nSettings.autoPull) {
        // Auto-pull armed, waiting
        pill.classList.add('status-active');
        text.textContent = '🤖 Auto-pull ON';
        liveBar.style.display = 'none';
    } else {
        pill.classList.add('status-idle');
        text.textContent = 'Idle';
        liveBar.style.display = 'none';
    }
}

async function loadProfiles() {
    const response = await chrome.runtime.sendMessage({ action: 'getProfiles' });
    if (response.success) {
        allProfiles = response.profiles;
        renderProfiles(allProfiles);
        updateCount();
    }
}

function updateCount() {
    document.getElementById('profile-count').textContent = allProfiles.length;
}

// ═══════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════════════════

function setupTabSwitching() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════
// PROFILE LIST RENDER
// ═══════════════════════════════════════════════════════════════════════

function renderProfiles(profiles) {
    const container = document.getElementById('profile-list');
    const emptyState = document.getElementById('empty-state');

    if (profiles.length === 0) {
        container.innerHTML = '';
        container.appendChild(emptyState);
        emptyState.style.display = 'block';
        return;
    }

    emptyState.style.display = 'none';
    container.innerHTML = '';

    for (const p of profiles) {
        container.appendChild(createProfileCard(p));
    }
}

function createProfileCard(p) {
    const card = document.createElement('div');
    card.className = 'profile-card';

    const initials = p.fullName
        ? p.fullName.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
        : '??';

    const avatar = p.profilePic
        ? `<img class="profile-avatar" src="${escapeHtml(p.profilePic)}" alt="${escapeHtml(p.fullName || '?')}" />`
        : `<div class="profile-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;color:#6b7280">${initials}</div>`;

    const enrichedBadge = p.enriched
        ? '<span style="background:#dcfce7;color:#166534;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:600">✨ enriched</span>'
        : '';

    let hiringJobsHtml = '';
    if (p.hiringPosts && p.hiringPosts.length > 0) {
        hiringJobsHtml = '<div class="hiring-jobs-list">';
        for (const job of p.hiringPosts.slice(0, 5)) {
            hiringJobsHtml += `
                <div class="hiring-job-item">
                    <strong>${escapeHtml(job.title || 'Untitled')}</strong>
                    ${job.location ? ` · ${escapeHtml(job.location)}` : ''}
                    ${job.applicantsCount ? ` · ${escapeHtml(job.applicantsCount)}` : ''}
                </div>
            `;
        }
        if (p.hiringPosts.length > 5) {
            hiringJobsHtml += `<div class="hiring-job-item" style="color:#6b7280;font-style:italic">+ ${p.hiringPosts.length - 5} more</div>`;
        }
        hiringJobsHtml += '</div>';
    }

    card.innerHTML = `
        <div class="profile-header">
            ${avatar}
            <div class="profile-info">
                <div class="profile-name">${escapeHtml(p.fullName || 'Unknown')} ${enrichedBadge}</div>
                <div class="profile-headline">${escapeHtml(p.headline || 'No headline')}</div>
                <div class="profile-meta">
                    ${p.location ? `<span class="meta-item">📍 ${escapeHtml(p.location)}</span>` : ''}
                    ${p.currentCompany ? `<span class="meta-item">🏢 ${escapeHtml(p.currentCompany)}</span>` : ''}
                </div>
            </div>
        </div>
        ${p.hasHiringBadge ? `<div class="hiring-badge">🔥 ${p.hiringPostsCount || 0} active hiring posts</div>` : ''}
        ${hiringJobsHtml}
        <div class="profile-actions">
            <button class="action-btn" data-action="open" data-url="${escapeHtml(p.profileUrl)}">↗️ Open</button>
            <button class="action-btn" data-action="copy" data-profile-url="${escapeHtml(p.profileUrl)}">📋 JSON</button>
            <button class="action-btn action-btn-danger" data-action="delete" data-profile-url="${escapeHtml(p.profileUrl)}">🗑️</button>
        </div>
    `;

    card.querySelector('[data-action="open"]').addEventListener('click', (e) => {
        chrome.tabs.create({ url: e.target.dataset.url });
    });
    card.querySelector('[data-action="copy"]').addEventListener('click', async (e) => {
        const profile = allProfiles.find(x => x.profileUrl === e.target.dataset.profileUrl);
        if (profile) {
            await navigator.clipboard.writeText(JSON.stringify(profile, null, 2));
            e.target.textContent = '✅';
            setTimeout(() => { e.target.textContent = '📋 JSON'; }, 1500);
        }
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        if (confirm('Delete this profile?')) {
            await chrome.runtime.sendMessage({ action: 'deleteProfile', profileUrl: e.target.dataset.profileUrl });
            await loadProfiles();
        }
    });

    return card;
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════

function setupEventListeners() {
    // Search
    document.getElementById('search-input').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        if (!q) { renderProfiles(allProfiles); return; }
        const filtered = allProfiles.filter(p => {
            const haystack = [
                p.fullName, p.headline, p.location, p.currentCompany,
                ...(p.hiringPosts || []).map(j => `${j.title} ${j.location} ${j.companyName}`)
            ].join(' ').toLowerCase();
            return haystack.includes(q);
        });
        renderProfiles(filtered);
    });

    document.getElementById('btn-clear').addEventListener('click', async () => {
        if (allProfiles.length === 0) return;
        if (confirm(`Delete all ${allProfiles.length} saved profiles? This cannot be undone.`)) {
            await chrome.runtime.sendMessage({ action: 'clearAll' });
            await loadProfiles();
        }
    });

    // ── SCRAPE QUEUE (lives inside n8n tab) ──
    document.getElementById('btn-bulk-start').addEventListener('click', startBulkScrape);
    document.getElementById('btn-bulk-stop').addEventListener('click', stopBulkScrape);
}

// ═══════════════════════════════════════════════════════════════════════
// BULK MODE
// ═══════════════════════════════════════════════════════════════════════

async function startBulkScrape() {
    if (pendingUrls.length === 0) {
        alert('No URLs in queue. Click "📥 Pull URLs" first to fetch from n8n.');
        return;
    }

    const urls = pendingUrls.slice();
    if (urls.length > 200) {
        if (!confirm(`${urls.length} URLs queued. This will take ~${Math.round(urls.length * 0.5)} hours. Continue?`)) return;
    }

    const MIN_DELAY = 7;
    const delay = Math.max(MIN_DELAY, parseInt(document.getElementById('opt-delay').value) || MIN_DELAY);
    document.getElementById('opt-delay').value = delay; // snap back if user typed less than 7
    const enrichJobs = document.getElementById('opt-enrich-jobs').checked;

    // Show progress UI
    document.getElementById('bulk-progress').style.display = 'block';
    document.getElementById('btn-bulk-start').style.display = 'none';
    document.getElementById('btn-bulk-stop').style.display = 'block';
    document.getElementById('progress-total').textContent = urls.length;
    document.getElementById('progress-current').textContent = '0';
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('progress-status').textContent = 'Starting...';
    document.getElementById('progress-log').innerHTML = '';

    // Start bulk scrape
    await chrome.runtime.sendMessage({
        action: 'startBulk',
        urls,
        options: { delay, enrichJobs }
    });
}

async function stopBulkScrape() {
    await chrome.runtime.sendMessage({ action: 'stopBulk' });
    document.getElementById('btn-bulk-start').style.display = 'block';
    document.getElementById('btn-bulk-stop').style.display = 'none';
    document.getElementById('progress-status').textContent = 'Stopped';
}

async function syncBulkState() {
    const r = await chrome.runtime.sendMessage({ action: 'getBulkState' });
    if (!r?.success) return;
    const { state } = r;
    if (state.isRunning || state.log.length > 0) {
        document.getElementById('bulk-progress').style.display = 'block';
        document.getElementById('progress-current').textContent = state.currentIndex + 1;
        document.getElementById('progress-total').textContent = state.totalUrls;
        const pct = state.totalUrls > 0 ? ((state.currentIndex + 1) / state.totalUrls) * 100 : 0;
        document.getElementById('progress-bar').style.width = pct + '%';
        document.getElementById('progress-status').textContent = state.isRunning ? 'Running...' : 'Done';

        if (state.isRunning) {
            document.getElementById('btn-bulk-start').style.display = 'none';
            document.getElementById('btn-bulk-stop').style.display = 'block';
        }

        // Render log
        const logContainer = document.getElementById('progress-log');
        logContainer.innerHTML = '';
        for (const entry of state.log) {
            appendLogLine(entry, logContainer);
        }
        logContainer.scrollTop = logContainer.scrollHeight;
    }
}

function setupBulkProgressListener() {
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'bulkProgress') {
            document.getElementById('progress-current').textContent = msg.currentIndex + 1;
            document.getElementById('progress-total').textContent = msg.totalUrls;
            const pct = msg.totalUrls > 0 ? ((msg.currentIndex + 1) / msg.totalUrls) * 100 : 0;
            document.getElementById('progress-bar').style.width = pct + '%';
            document.getElementById('progress-status').textContent = msg.isRunning ? 'Running...' : '✅ Complete';

            const logContainer = document.getElementById('progress-log');
            if (msg.latestLog) {
                appendLogLine(msg.latestLog, logContainer);
                logContainer.scrollTop = logContainer.scrollHeight;
            }

            if (!msg.isRunning) {
                document.getElementById('btn-bulk-start').style.display = 'block';
                document.getElementById('btn-bulk-stop').style.display = 'none';
                // Reload profile list (new ones added)
                loadProfiles();
            }
        }
    });
}

function appendLogLine(entry, container) {
    const line = document.createElement('div');
    line.className = `log-line log-${entry.type}`;
    line.textContent = entry.message;
    container.appendChild(line);
}

function updateQueueInfo() {
    const el = document.getElementById('queue-info');
    if (!el) return;
    if (pendingUrls.length === 0) {
        el.textContent = 'No URLs pulled yet.';
    } else {
        el.textContent = `📋 ${pendingUrls.length} URLs ready to scrape.`;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORT — JOB-CENTRIC CSV (the format user wants)
// ═══════════════════════════════════════════════════════════════════════

function buildJobsCsv(profiles) {
    // MINIMAL FORMAT — only what user wants:
    // Job URL, Email, Company LinkedIn URL, Company Name,
    // Job Poster Name, First Name, Last Name, Job Poster Profile URL
    const headers = [
        'Job URL',
        'Email (guessed)',
        'Company LinkedIn URL',
        'Company Name',
        'Job Poster Name',
        'First Name',
        'Last Name',
        'Job Poster Profile URL',
        'Job Title',
        'Job Location',
        'Source',
        'Post URL',
        'Total Jobs'
    ];

    const rows = [headers.map(csvEscape).join(',')];

    for (const profile of profiles) {
        const posts = profile.hiringPosts || [];
        if (posts.length === 0) continue;

        // Pick exactly ONE job per profile (top by AI flag, else heuristic, else first)
        const job = pickTopJobLocal(posts) || posts[0];
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
            posts.length
        ];
        rows.push(row.map(csvEscape).join(','));
    }

    return rows.join('\n');
}

// Same heuristic as background.js — kept local for popup.js to use
function pickTopJobLocal(posts) {
    if (!posts || posts.length === 0) return null;
    if (posts.length === 1) return posts[0];
    const aiTop = posts.find(p => p.isTopJob === true);
    if (aiTop) return aiTop;
    const tiers = [
        [/\b(chief|c[eofitm]o|founder|partner)\b/i, 100],
        [/\b(vp|vice\s*president|svp|evp)\b/i, 80],
        [/\b(director|head\s+of)\b/i, 65],
        [/\b(senior\s+manager|sr\.?\s+manager|principal)\b/i, 50],
        [/\b(manager|lead|architect|staff)\b/i, 35],
        [/\b(senior|sr\.?)\b/i, 25],
        [/\b(specialist|consultant|engineer|developer|designer|analyst)\b/i, 10],
        [/\b(junior|jr\.?|associate|entry|intern|trainee|graduate)\b/i, -10]
    ];
    let bestIdx = 0, bestScore = -1000;
    posts.forEach((p, i) => {
        const t = (p.title || '').toLowerCase();
        let score = 0;
        for (const [rx, val] of tiers) { if (rx.test(t)) { score = val; break; } }
        if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    return posts[bestIdx];
}

function buildProfilesCsv(profiles) {
    // Each row = one recruiter
    const headers = [
        'fullName', 'firstName', 'lastName', 'headline', 'location',
        'currentCompany', 'profileUrl',
        'followers', 'connections', 'hasHiringBadge', 'hiringPostsCount',
        'profilePic', 'about', 'isVerified', 'enriched',
        'hiringJobsList', 'scrapedAt'
    ];

    const rows = [headers.map(csvEscape).join(',')];

    for (const p of profiles) {
        const hiringList = (p.hiringPosts || [])
            .map(j => `${j.title || ''} (${j.location || 'N/A'})`)
            .join(' | ');

        const row = headers.map(h => {
            if (h === 'hiringJobsList') return hiringList;
            return p[h] || '';
        });
        rows.push(row.map(csvEscape).join(','));
    }

    return rows.join('\n');
}

function guessEmail(profile, job) {
    if (!profile.firstName || !profile.lastName) return '';
    const company = job.companyName || job.company || profile.currentCompany || '';
    if (!company && !job.companyLinkedinUrl) return '';

    // Domain priority:
    // 1. Actual company website (only available if enrichment was on)
    // 2. LinkedIn company slug — most reliable proxy
    // 3. Cleaned company name
    let domain = null;

    if (job.companyWebsite) {
        const m = job.companyWebsite.match(/^(?:https?:\/\/)?(?:www\.)?([^/]+)/i);
        if (m) domain = m[1].toLowerCase();
    }

    if (!domain && job.companyLinkedinUrl) {
        const m = job.companyLinkedinUrl.match(/\/company\/([^/?#]+)/);
        if (m) {
            domain = m[1].toLowerCase().replace(/[^a-z0-9-]/g, '') + '.com';
        }
    }

    if (!domain && company) {
        const cleaned = company.toLowerCase()
            .replace(/\s+(europe|emea|gmbh|inc|ltd|llc|corp|company|co\.|sa|ag|se|kg|group)$/i, '')
            .replace(/[^a-z0-9]/g, '');
        if (cleaned) domain = cleaned + '.com';
    }

    if (!domain) return '';

    const first = profile.firstName.toLowerCase().replace(/[^a-z]/g, '');
    const last = profile.lastName.toLowerCase().replace(/[^a-z]/g, '');
    return `${first}.${last}@${domain}`;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function csvEscape(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return `"${s}"`;
}

// ═══════════════════════════════════════════════════════════════════════
// n8n INTEGRATION
// ═══════════════════════════════════════════════════════════════════════

async function loadN8nSettings() {
    const stored = await chrome.storage.local.get(['n8nSettings', 'aiSettings']);
    const n8nSettings = stored.n8nSettings || {};
    const aiSettings = stored.aiSettings || {};

    // n8n side — URLs + behaviour flags are fixed, only autoPull is user-controlled
    const merged = {
        pullUrl: N8N_PULL_URL,
        callbackUrl: N8N_CALLBACK_URL,
        apiKey: n8nSettings.apiKey || '',
        owner: (n8nSettings.owner || '').trim().toLowerCase(),  // ← teammate identity
        autoPull: !!n8nSettings.autoPull,   // ← user toggle (default false)
        autoSend: true,                      // always ON
        stopAfterBatch: true                 // always ON
    };
    await chrome.storage.local.set({ n8nSettings: merged });

    // ── Team ID (owner) field ──
    const ownerEl = document.getElementById('owner-id');
    if (ownerEl) ownerEl.value = merged.owner;

    // Closed-jobs filter is always ON
    aiSettings.filterClosed = true;
    await chrome.storage.local.set({ aiSettings });

    // ── Master toggle UI ──
    const toggleEl = document.getElementById('auto-mode-toggle');
    if (toggleEl) {
        toggleEl.checked = merged.autoPull;
        updateAutoModeBannerState(merged.autoPull);
    }

    // AI settings UI (still user-editable in collapsed advanced section)
    const aiKeyEl = document.getElementById('ai-api-key');
    const aiModelEl = document.getElementById('ai-model');
    const aiEnabledEl = document.getElementById('ai-enabled');
    if (aiKeyEl) aiKeyEl.value = aiSettings.apiKey || '';
    if (aiModelEl) aiModelEl.value = aiSettings.model || 'google/gemini-flash-1.5';
    if (aiEnabledEl) aiEnabledEl.checked = !!aiSettings.enabled;
}

function updateAutoModeBannerState(isOn) {
    const banner = document.getElementById('auto-mode-banner');
    const state = document.getElementById('auto-mode-state');
    if (!banner || !state) return;

    if (isOn) {
        banner.classList.remove('paused');
        banner.classList.add('running');
        state.textContent = '🟢 Running — pulling every 30 seconds';
    } else {
        banner.classList.remove('running');
        banner.classList.add('paused');
        state.textContent = '⏸ Paused — flip the switch to start';
    }
}

async function handleAutoModeToggle(e) {
    const enabled = e.target.checked;

    // Persist the choice
    const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
    n8nSettings.autoPull = enabled;
    await chrome.storage.local.set({ n8nSettings });

    // Tell background to start/stop the alarm
    await chrome.runtime.sendMessage({ action: 'setAutoPull', enabled }).catch(() => {});

    // Update UI
    updateAutoModeBannerState(enabled);
    n8nLog(enabled ? '🟢 Auto Mode ENABLED — extension will pull every 30s.' : '⏸ Auto Mode PAUSED.', enabled ? 'success' : 'info');
    refreshStatusIndicator();
}

function setupN8nListeners() {
    const toggleEl = document.getElementById('auto-mode-toggle');
    if (toggleEl) toggleEl.addEventListener('change', handleAutoModeToggle);

    const saveBtn = document.getElementById('btn-n8n-save');
    if (saveBtn) saveBtn.addEventListener('click', saveN8nSettings);

    const pullBtn = document.getElementById('btn-n8n-pull');
    if (pullBtn) pullBtn.addEventListener('click', pullFromN8n);

    const sendBtn = document.getElementById('btn-n8n-send');
    if (sendBtn) sendBtn.addEventListener('click', sendToN8n);

    const testBtn = document.getElementById('btn-n8n-test');
    if (testBtn) testBtn.addEventListener('click', testN8nConnection);

    const emergencyBtn = document.getElementById('btn-emergency-stop');
    if (emergencyBtn) emergencyBtn.addEventListener('click', emergencyStop);

    const ownerEl = document.getElementById('owner-id');
    if (ownerEl) ownerEl.addEventListener('change', saveOwner);

    // Save AI section automatically when its inputs change (since the dedicated Save button is gone)
    const aiInputs = ['ai-api-key', 'ai-model', 'ai-enabled'];
    for (const id of aiInputs) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveN8nSettings);
    }
}

async function emergencyStop() {
    // Auto-mode is fixed ON, so we only halt the in-progress scrape.
    // Auto-pull will resume on the next alarm tick (30s later).
    await chrome.runtime.sendMessage({ action: 'stopBulk' }).catch(() => {});
    n8nLog('🛑 EMERGENCY STOP — current scrape halted. Auto-pull will resume in 30s.', 'error');
    refreshStatusIndicator();
}

async function saveN8nSettings() {
    // n8n side is fixed (auto-pull / auto-send / stop-after-batch always ON).
    // Only AI section is user-editable now.
    const aiSettings = {
        apiKey: document.getElementById('ai-api-key')?.value.trim() || '',
        model: document.getElementById('ai-model')?.value || 'google/gemini-flash-1.5',
        enabled: document.getElementById('ai-enabled')?.checked || false,
        filterClosed: true
    };
    await chrome.storage.local.set({ aiSettings });
    n8nLog(`💾 AI settings saved.${aiSettings.enabled ? ' 🤖 AI ranking ENABLED.' : ''}`, 'success');
}

async function saveOwner() {
    const owner = (document.getElementById('owner-id')?.value || '').trim().toLowerCase();
    const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
    n8nSettings.owner = owner;
    await chrome.storage.local.set({ n8nSettings });
    n8nLog(owner ? `👤 Team ID set: ${owner}` : '⚠️ Team ID cleared — pull will be unscoped!', owner ? 'success' : 'error');
}

function getN8nSettings() {
    return {
        pullUrl: N8N_PULL_URL,
        callbackUrl: N8N_CALLBACK_URL,
        apiKey: document.getElementById('n8n-api-key')?.value.trim() || '',
        owner: (document.getElementById('owner-id')?.value || '').trim().toLowerCase()
    };
}

function buildN8nHeaders(apiKey, contentType = 'application/json') {
    const h = { 'Content-Type': contentType };
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
    return h;
}

async function pullFromN8n() {
    const { pullUrl, apiKey, owner } = getN8nSettings();
    if (!pullUrl) {
        n8nLog('❌ Pull URL not configured.', 'error');
        return;
    }
    if (!owner) {
        n8nLog('❌ Team ID (owner) is empty — please set your Team ID first.', 'error');
        return;
    }

    const scopedUrl = `${pullUrl}?owner=${encodeURIComponent(owner)}`;
    n8nLog(`📥 Fetching ${owner}'s URLs from ${pullUrl}...`, 'info');

    try {
        const res = await fetch(scopedUrl, {
            method: 'GET',
            headers: buildN8nHeaders(apiKey)
        });

        if (!res.ok) {
            n8nLog(`❌ HTTP ${res.status}: ${res.statusText}`, 'error');
            return;
        }

        const data = await res.json();
        const urls = extractUrlsFromN8nPayload(data);

        if (urls.length === 0) {
            n8nLog('⚠️ No LinkedIn URLs found in response.', 'error');
            updateQueueInfo();
            return;
        }

        pendingUrls = urls;
        updateQueueInfo();
        n8nLog(`✅ Pulled ${urls.length} URLs. Click 🚀 Start Scrape.`, 'success');
    } catch (err) {
        n8nLog(`❌ ${err.message}`, 'error');
    }
}

function extractUrlsFromN8nPayload(data) {
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
            url = item['Profile URL'] || item.profileUrl || item.url
                || item['LinkedIn-Profile'] || item.linkedinUrl
                || item.ProfileURL || item.ProfileUrl || item['Profile Url']
                || item.profile_url || item['profile-url']
                || item.Url || item.URL;
            if (!url) {
                // Fallback: scan ALL string fields for any LinkedIn URL
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
            if (!seen.has(clean)) {
                seen.add(clean);
                urls.push(clean);
            }
        }
    }
    return urls;
}

async function sendToN8n() {
    const { callbackUrl, apiKey } = getN8nSettings();
    if (!callbackUrl) {
        n8nLog('❌ Callback URL not configured.', 'error');
        return;
    }

    if (allProfiles.length === 0) {
        n8nLog('⚠️ No profiles to send.', 'error');
        return;
    }

    n8nLog(`📤 Sending ${allProfiles.length} profiles to n8n...`, 'info');

    const jobsCsv = buildJobsCsv(allProfiles);
    const profilesCsv = buildProfilesCsv(allProfiles);

    const payload = {
        source: 'linkedin-recruiter-extension',
        version: '0.3.0',
        timestamp: new Date().toISOString(),
        counts: {
            profiles: allProfiles.length,
            jobs: allProfiles.reduce((n, p) => n + (p.hiringPosts?.length || 0), 0)
        },
        profiles: allProfiles,
        csv: {
            jobs: jobsCsv,
            profiles: profilesCsv
        }
    };

    try {
        const res = await fetch(callbackUrl, {
            method: 'POST',
            headers: buildN8nHeaders(apiKey),
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            n8nLog(`❌ HTTP ${res.status}: ${res.statusText}`, 'error');
            return;
        }
        n8nLog(`✅ Sent ${allProfiles.length} profiles to n8n.`, 'success');
    } catch (err) {
        n8nLog(`❌ ${err.message}`, 'error');
    }
}

async function testN8nConnection() {
    const { pullUrl, callbackUrl, apiKey } = getN8nSettings();
    if (!pullUrl && !callbackUrl) {
        n8nLog('❌ Configure at least one URL.', 'error');
        return;
    }

    if (pullUrl) {
        n8nLog(`🔌 Testing pull URL...`, 'info');
        try {
            const r = await fetch(pullUrl, { method: 'GET', headers: buildN8nHeaders(apiKey) });
            n8nLog(`  Pull → HTTP ${r.status}`, r.ok ? 'success' : 'error');
        } catch (e) { n8nLog(`  Pull failed: ${e.message}`, 'error'); }
    }

    if (callbackUrl) {
        n8nLog(`🔌 Testing callback URL...`, 'info');
        try {
            const r = await fetch(callbackUrl, {
                method: 'POST',
                headers: buildN8nHeaders(apiKey),
                body: JSON.stringify({ test: true, source: 'linkedin-recruiter-extension' })
            });
            n8nLog(`  Callback → HTTP ${r.status}`, r.ok ? 'success' : 'error');
        } catch (e) { n8nLog(`  Callback failed: ${e.message}`, 'error'); }
    }
}

function n8nLog(message, type = 'info') {
    const container = document.getElementById('n8n-status');
    const line = document.createElement('div');
    line.className = `log-line log-${type}`;
    const stamp = new Date().toLocaleTimeString();
    line.textContent = `[${stamp}] ${message}`;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
}

