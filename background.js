/**
 * BACKGROUND SERVICE WORKER — V0.2.0
 * ───────────────────────────────────
 * Manages:
 *  - Single profile saves (manual button click)
 *  - Bulk profile scraping queue
 *  - Job page enrichment (visits each hiring post URL)
 *  - Progress tracking + notifications to popup
 */

console.log('🟢 LRI Background v0.6.0 loaded');

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
        if (urls.length === 0) {
            console.log('🤖 Auto-pull: no pending URLs');
            return;
        }

        console.log(`🤖 Auto-pull: ${urls.length} URLs received → starting scrape`);
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
            url = item['Profile URL'] || item.profileUrl || item.url
                || item['LinkedIn-Profile'] || item.linkedinUrl;
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

// Re-arm alarm on service worker startup
chrome.runtime.onStartup.addListener(async () => {
    const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
    if (n8nSettings.autoPull) {
        chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
        console.log('🤖 Auto-pull re-armed on startup');
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
    if (n8nSettings.autoPull) {
        chrome.alarms.create('auto-pull', { periodInMinutes: 0.5 });
        console.log('🤖 Auto-pull armed after install/update');
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

    // ── n8n auto-callback ──
    try {
        const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');
        if (n8nSettings.autoSend && n8nSettings.callbackUrl) {
            await sendBulkResultsToN8n(n8nSettings, savedCount, skippedCount);
        }
    } catch (err) {
        bulkLog(`⚠️ n8n callback error: ${err.message}`, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// n8n CALLBACK (auto-send after bulk completes)
// ═══════════════════════════════════════════════════════════════════════

async function sendBulkResultsToN8n(settings, savedCount, skippedCount) {
    const profiles = await getAllProfiles();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

    const payload = {
        source: 'linkedin-recruiter-extension',
        version: '0.3.0',
        timestamp: new Date().toISOString(),
        run: {
            saved: savedCount,
            skipped: skippedCount,
            total: bulkState.totalUrls
        },
        profiles
    };

    bulkLog(`📤 Auto-sending results to n8n: ${settings.callbackUrl}`, 'info');
    const res = await fetch(settings.callbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (res.ok) {
        bulkLog(`✅ n8n callback OK (HTTP ${res.status})`, 'success');
    } else {
        bulkLog(`⚠️ n8n callback HTTP ${res.status}`, 'error');
    }
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
