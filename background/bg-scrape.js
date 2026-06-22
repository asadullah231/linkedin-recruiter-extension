/**
 * BACKGROUND — TAB MANAGEMENT / SCRAPING
 * ───────────────────────────────────────
 * Opens (and reuses) background tabs, waits for them to load, triggers the
 * content script's save flow, and waits for the resulting message. Resolution
 * happens via bulkState.pendingProfileResolve / pendingJobResolve, which the
 * message handler in background.js fires.
 */

async function scrapeProfileInTab(url) {
    return new Promise(async (resolve) => {
        // ── TAB REUSE: don't close tab on resolve — we navigate it to the next URL ──
        const timeout = setTimeout(() => {
            bulkState.pendingProfileResolve = null;
            resolve(null);
        }, 60000); // 60s max

        bulkState.pendingProfileResolve = (data) => {
            clearTimeout(timeout);
            // NOTE: we do NOT remove the tab here — it gets reused for next profile
            resolve(data);
        };

        try {
            // ── Reuse existing tab if still alive, else create a fresh one ──
            let tabId = bulkState.activeTabId;
            if (tabId) {
                try {
                    await chrome.tabs.get(tabId);           // throws if tab was closed
                    await chrome.tabs.update(tabId, { url }); // navigate instead of new tab
                } catch {
                    tabId = null; // tab gone — fall through to create
                }
            }
            if (!tabId) {
                const tab = await chrome.tabs.create({ url, active: false });
                tabId = tab.id;
                bulkState.activeTabId = tabId;
            }

            // Wait for page to load + content script to inject
            await waitForTabComplete(tabId, 30000);
            await sleep(2000); // ✂ Reduced 4s → 2s (SPA + voyager data loads faster)

            // Trigger save — wait for button to actually appear (up to 5s extra)
            await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    return new Promise((resolve) => {
                        const tryClick = (attempts) => {
                            const btn = document.getElementById('lri-save-button');
                            if (btn) {
                                btn.click();
                                return resolve('clicked');
                            }
                            if (attempts <= 0) return resolve('timeout');
                            setTimeout(() => tryClick(attempts - 1), 300);
                        };
                        tryClick(16); // up to 4.8s extra wait
                    });
                }
            });

            // Wait for pendingProfileResolve to be called by the saveProfile message
        } catch (err) {
            clearTimeout(timeout);
            bulkState.pendingProfileResolve = null;
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
