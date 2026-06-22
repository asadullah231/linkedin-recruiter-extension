/**
 * CONTENT SCRIPT — SHARED HELPERS
 * ────────────────────────────────
 * Loaded FIRST (see manifest content_scripts order). Every other content
 * script file (content-profile.js, content-jobs.js, content-ui.js) relies on
 * the helpers defined here. Because content scripts injected for the same page
 * share one global scope, these declarations are visible everywhere.
 */

const q = (sel) => document.querySelector(sel);
const qq = (sel) => Array.from(document.querySelectorAll(sel));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractPublicIdentifier(url) {
    const match = url.match(/\/in\/([^/?#]+)/);
    return match ? match[1] : null;
}

function extractPicUrl(profilePicture) {
    if (!profilePicture) return null;
    if (typeof profilePicture === 'string') return profilePicture;
    // LinkedIn nested image structure
    const artifacts = profilePicture.displayImageReference?.vectorImage?.artifacts;
    if (artifacts && artifacts.length > 0) {
        const root = profilePicture.displayImageReference.vectorImage.rootUrl;
        const largest = artifacts[artifacts.length - 1];
        return root + largest.fileIdentifyingUrlPathSegment;
    }
    return null;
}

function cleanName(s) {
    return String(s).replace(/\s+/g, ' ').trim();
}

// Strip LinkedIn UI artefacts that bleed into name extraction:
//   "(1) Maria Robillard"          ← unread-notification counter on tab title
//   "(99+) John Doe"               ← capped counter variant
//   "•  Maria Robillard"           ← LinkedIn online-status dot
//   "  Maria Robillard •"          ← trailing dot
//   "Maria Robillard | LinkedIn"   ← page-title brand suffix slipped in
function normalizeProfileName(s) {
    if (!s) return null;
    let n = String(s).trim();
    // leading "(N)" or "(N+)" notification badge
    n = n.replace(/^\s*\(\s*\d+\+?\s*\)\s*/, '');
    // leading/trailing online-presence dots / pipes
    n = n.replace(/^[•·•|\s]+|[•·•|\s]+$/g, '');
    // strip trailing "| LinkedIn" or " - LinkedIn" if it slipped through
    n = n.replace(/\s*[-|]\s*LinkedIn\s*$/i, '');
    n = n.replace(/\s+/g, ' ').trim();
    return n || null;
}
