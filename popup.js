/**
 * POPUP UI LOGIC v0.2.0
 * ─────────────────────
 * Tabs: Saved Profiles | Bulk Mode | Export
 */

let allProfiles = [];

// ═══════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    await loadProfiles();
    setupTabSwitching();
    setupEventListeners();
    await syncBulkState();
    setupBulkProgressListener();
});

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

    // ── EXPORT BUTTONS ──
    document.getElementById('btn-export-jobs-csv').addEventListener('click', () => {
        if (allProfiles.length === 0) return alert('No profiles to export!');
        const csv = '﻿' + buildJobsCsv(allProfiles);
        downloadFile(csv, `linkedin-jobs-${Date.now()}.csv`, 'text/csv;charset=utf-8');
    });

    document.getElementById('btn-export-profiles-csv').addEventListener('click', () => {
        if (allProfiles.length === 0) return alert('No profiles to export!');
        const csv = '﻿' + buildProfilesCsv(allProfiles);
        downloadFile(csv, `linkedin-profiles-${Date.now()}.csv`, 'text/csv;charset=utf-8');
    });

    document.getElementById('btn-export-json').addEventListener('click', () => {
        if (allProfiles.length === 0) return alert('No profiles to export!');
        const json = JSON.stringify(allProfiles, null, 2);
        downloadFile(json, `linkedin-data-${Date.now()}.json`, 'application/json');
    });

    document.getElementById('btn-clear').addEventListener('click', async () => {
        if (allProfiles.length === 0) return;
        if (confirm(`Delete all ${allProfiles.length} saved profiles? This cannot be undone.`)) {
            await chrome.runtime.sendMessage({ action: 'clearAll' });
            await loadProfiles();
        }
    });

    // ── BULK MODE ──
    document.getElementById('btn-bulk-start').addEventListener('click', startBulkScrape);
    document.getElementById('btn-bulk-stop').addEventListener('click', stopBulkScrape);

    document.getElementById('bulk-file').addEventListener('change', handleFileUpload);
}

// ═══════════════════════════════════════════════════════════════════════
// BULK MODE
// ═══════════════════════════════════════════════════════════════════════

async function startBulkScrape() {
    const text = document.getElementById('bulk-urls').value.trim();
    if (!text) {
        alert('Please paste at least one LinkedIn URL!');
        return;
    }

    const urls = parseUrls(text);
    if (urls.length === 0) {
        alert('No valid LinkedIn profile URLs found! Make sure they look like https://www.linkedin.com/in/username');
        return;
    }

    if (urls.length > 200) {
        if (!confirm(`Found ${urls.length} URLs. This will take ~${Math.round(urls.length * 0.5)} hours. Continue?`)) return;
    }

    const delay = parseInt(document.getElementById('opt-delay').value) || 15;
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

function parseUrls(text) {
    const lines = text.split(/[\r\n,;]+/).map(l => l.trim()).filter(Boolean);
    const urls = [];
    const seen = new Set();
    for (const line of lines) {
        // Extract URL from each line (handles CSV cells too)
        const match = line.match(/https?:\/\/[\w.]*linkedin\.com\/in\/[^\s,"'<>]+/i);
        if (match) {
            const url = match[0].replace(/\/$/, '');
            if (!seen.has(url)) {
                seen.add(url);
                urls.push(url);
            }
        } else if (line.match(/^[\w-]+$/)) {
            // Just a username
            const url = `https://www.linkedin.com/in/${line}`;
            if (!seen.has(url)) {
                seen.add(url);
                urls.push(url);
            }
        }
    }
    return urls;
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        document.getElementById('bulk-urls').value = evt.target.result;
    };
    reader.readAsText(file);
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
        'Job Location'
    ];

    const rows = [headers.map(csvEscape).join(',')];

    for (const profile of profiles) {
        const posts = profile.hiringPosts || [];
        if (posts.length === 0) continue;

        for (const job of posts) {
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
                job.location || ''
            ];
            rows.push(row.map(csvEscape).join(','));
        }
    }

    return rows.join('\n');
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

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    if (chrome.downloads && chrome.downloads.download) {
        chrome.downloads.download({ url, filename, saveAs: true }, () => {
            if (chrome.runtime.lastError) fallbackDownload(url, filename);
            else setTimeout(() => URL.revokeObjectURL(url), 60000);
        });
    } else {
        fallbackDownload(url, filename);
    }
}

function fallbackDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 1000);
}
