/**
 * BACKGROUND — HELPERS, LOGGING, BADGE, URL EXTRACTION
 * ─────────────────────────────────────────────────────
 * Small shared utilities used across the bg-*.js modules.
 */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function shortUrl(url) {
    const m = url.match(/\/in\/([^/?]+)/);
    return m ? '/in/' + m[1] : url.substring(0, 60);
}

// Parse a variety of n8n payload shapes down to a clean list of LinkedIn
// profile URLs (used by the auto-pull alarm).
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
