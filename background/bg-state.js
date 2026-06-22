/**
 * BACKGROUND — SHARED STATE & CONSTANTS
 * ──────────────────────────────────────
 * Loaded FIRST via importScripts() (see background.js). Holds the in-memory
 * bulk-scrape state and shared endpoint constants. Because importScripts'd
 * files share the service worker's global scope, these are visible to every
 * other bg-*.js module.
 */

// In-memory bulk scrape state (resets on service worker restart)
let bulkState = {
    isRunning: false,
    queue: [],
    totalUrls: 0,
    currentIndex: 0,
    delay: 7,
    enrichJobs: true,
    activeTabId: null,
    pendingProfileResolve: null,
    pendingJobResolve: null,
    log: []
};

// Streaming endpoint — push every scraped profile to n8n immediately
// (so the NocoDB row updates live, one at a time)
const N8N_PROFILE_DONE_URL = 'https://n8n.emergeautomation.tech/webhook/profile-done';
