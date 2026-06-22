/**
 * BACKGROUND — BULK SCRAPE ORCHESTRATOR
 * ──────────────────────────────────────
 * startBulkScrape() seeds bulkState and kicks off runBulkQueue(), which walks
 * the URL queue: scrape each profile, (optionally) enrich jobs, stream the
 * result to n8n, then post-process (closed-job filter + AI ranking) at the end.
 */

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
        delay: options.delay || 10,       // 10s default (was 7s) — safer against LinkedIn detection
        enrichJobs: options.enrichJobs !== false,
        activeTabId: null,
        pendingProfileResolve: null,
        pendingJobResolve: null,
        consecutiveErrors: 0,             // circuit breaker counter
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

    // ── SW KEEPALIVE: ping every 25s so service worker never sleeps mid-batch ──
    chrome.alarms.create('sw-keepalive', { periodInMinutes: 25 / 60 });

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
                bulkState.consecutiveErrors++;
            } else {
                const name = profileData.fullName || 'Unknown';
                const jobsCount = profileData.hiringPosts?.length || 0;

                // ── SKIP profiles with 0 hiring jobs (don't save, no delay) ──
                if (jobsCount === 0) {
                    bulkLog(`  ⏭ ${name} — 0 jobs, skipping`, 'info');
                    // Delete the auto-save (saveProfile triggered when content.js posted)
                    await deleteProfile(url);
                    skippedCount++;
                    bulkState.consecutiveErrors = 0; // data returned = LinkedIn not blocking us
                    // 🔁 Stream: tell n8n this URL is done with no jobs (mark complete in NocoDB)
                    streamProfileToN8n({
                        profileUrl: url,
                        status: 'complete_no_jobs',
                        scrapedAt: new Date().toISOString()
                    }).catch(() => {});
                } else {
                    bulkLog(`  ✅ ${name} — ${jobsCount} hiring jobs`, 'success');
                    hadJobs = true;
                    savedCount++;
                    bulkState.consecutiveErrors = 0; // success → reset circuit breaker

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

                    // 🔁 Stream: push this single profile's result to n8n NOW
                    //    (no waiting for batch — NocoDB row updates live)
                    try {
                        await streamProfileToN8n(profileData);
                        bulkLog(`    📤 Pushed to NocoDB`, 'success');
                    } catch (err) {
                        bulkLog(`    ⚠️ Push failed: ${err.message.substring(0, 60)}`, 'error');
                    }
                }
            }
        } catch (err) {
            bulkLog(`  ❌ ${err.message.substring(0, 60)}`, 'error');
            skippedCount++;
            bulkState.consecutiveErrors++;
        }

        // ── CIRCUIT BREAKER: LinkedIn rate-limit / block detection ──
        // If consecutive failures pile up, take an escalating cooling break.
        // This protects the LinkedIn account from a hard block.
        if (bulkState.consecutiveErrors >= 5) {
            const coolMs = 3 * 60 * 1000 + Math.random() * 60 * 1000; // 3-4 min
            bulkLog(`🚨 5 consecutive errors — cooling ${Math.round(coolMs/1000)}s to avoid LinkedIn block`, 'error');
            await sleep(coolMs);
            bulkState.consecutiveErrors = 0;
        } else if (bulkState.consecutiveErrors >= 3) {
            const coolMs = 45 * 1000 + Math.random() * 30 * 1000; // 45-75s
            bulkLog(`⚠️ 3 consecutive errors — pausing ${Math.round(coolMs/1000)}s`, 'error');
            await sleep(coolMs);
        }

        // ── SMART DELAY ──
        // Jitter range is wider so scraping pattern looks more human.
        // Only wait full delay if profile had jobs (= we'll do same heavy work next)
        if (i < bulkState.queue.length - 1 && bulkState.isRunning) {
            const jitter = Math.random() * 5000; // 0-5s random extra (was 0-3s)
            const wait = hadJobs
                ? bulkState.delay * 1000 + jitter
                : 2000 + Math.random() * 1500;  // 2-3.5s for empty profiles (was 1.5-2.5s)
            if (hadJobs) {
                bulkLog(`  ⏱ Waiting ${Math.round(wait / 1000)}s...`, 'info');
            }
            await sleep(wait);
        }
    }

    // ── Close the reused tab when batch is fully done ──
    if (bulkState.activeTabId) {
        chrome.tabs.remove(bulkState.activeTabId).catch(() => {});
        bulkState.activeTabId = null;
    }

    // ── Stop keepalive alarm ──
    chrome.alarms.clear('sw-keepalive');

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

    // ── BATCH XLSX FLOW DISABLED ──
    // Profiles are now pushed live to /webhook/profile-done as they finish.
    // The bulk XLSX → Slack flow stays available for the manual "Send Now" button only.
    // (was: sendBulkResultsToN8n)
    bulkLog(`📊 Streaming mode: ${savedCount} profile(s) pushed live to NocoDB.`, 'info');

    try {
        const { n8nSettings = {} } = await chrome.storage.local.get('n8nSettings');

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
