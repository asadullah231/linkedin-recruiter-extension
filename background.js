/**
 * BACKGROUND SERVICE WORKER — ENTRY POINT
 * ────────────────────────────────────────
 * This file is intentionally thin. All the real logic lives in the
 * background/*.js modules, loaded below via importScripts() (classic service
 * worker — all modules share this global scope, so no import/export needed).
 *
 * Responsibilities kept here:
 *  - load the SheetJS lib + every bg-*.js module
 *  - register the chrome.* event listeners (messages, alarms, install/startup)
 *
 * Module map:
 *  bg-state.js    → bulkState, shared constants
 *  bg-storage.js  → saveProfile / getAllProfiles / deleteProfile
 *  bg-utils.js    → sleep, shortUrl, extractUrls, bulkLog, updateBadge
 *  bg-scrape.js   → scrapeProfileInTab / scrapeJobInTab / waitForTabComplete
 *  bg-ai.js       → filterClosedJobs, isJobClosed, rankTopJobsWithAI, ...
 *  bg-n8n.js      → streamProfileToN8n, sendBulkResultsToN8n
 *  bg-export.js   → pickTopJob, buildXlsxBlob
 *  bg-bulk.js     → startBulkScrape, runBulkQueue
 */

// XLSX is lazy-loaded inside buildXlsxBlob() — saves 952KB on every SW startup.
// Do NOT importScripts xlsx.full.min.js here.

// Load the background modules (order: state first, then leaf helpers, then
// higher-level orchestration). Function/var references resolve at call time,
// so listeners registered below always see fully-loaded modules.
importScripts(
    'background/bg-state.js',
    'background/bg-storage.js',
    'background/bg-utils.js',
    'background/bg-scrape.js',
    'background/bg-ai.js',
    'background/bg-n8n.js',
    'background/bg-export.js',
    'background/bg-bulk.js'
);

console.log('🟢 LRI Background v0.19.0 loaded');

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
    // ── SW KEEPALIVE: just waking up prevents the service worker sleeping mid-batch ──
    if (alarm.name === 'sw-keepalive') {
        console.log('💓 SW keepalive tick');
        return;
    }

    if (alarm.name !== 'auto-pull') return;
    if (bulkState.isRunning) {
        console.log('🤖 Auto-pull skipped: scrape already running');
        return;
    }

    try {
        const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
        if (!n8nSettings.autoPull || !n8nSettings.pullUrl) return;
        if (!n8nSettings.owner) {
            console.warn('🤖 Auto-pull skipped: Team ID (owner) not set');
            return;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (n8nSettings.apiKey) headers['Authorization'] = `Bearer ${n8nSettings.apiKey}`;

        // ── Scope the pull to THIS teammate only (multi-tenant) ──
        const pullUrl = `${n8nSettings.pullUrl}?owner=${encodeURIComponent(n8nSettings.owner)}`;
        const res = await fetch(pullUrl, { method: 'GET', headers });
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
        await startBulkScrape(urls, { delay: 7, enrichJobs: false });
    } catch (err) {
        console.error('🤖 Auto-pull error:', err);
    }
});

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

// Init badge on startup
chrome.runtime.onInstalled.addListener(async () => {
    const stored = await chrome.storage.local.get('profiles');
    const count = Object.keys(stored.profiles || {}).length;
    if (count > 0) {
        chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
    }
});
