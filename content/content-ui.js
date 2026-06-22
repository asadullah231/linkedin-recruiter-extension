/**
 * CONTENT SCRIPT — UI + LIFECYCLE
 * ────────────────────────────────
 * Loaded LAST. Injects the floating "Save Profile" button, wires the save
 * handler (which calls extractProfileData() from content-profile.js), and
 * re-injects the button as LinkedIn's SPA navigates between profiles.
 */

console.log('🟢 LinkedIn Recruiter Intelligence: Content script loaded');

// ═══════════════════════════════════════════════════════════════════════
// FLOATING ACTION BUTTON — Profile pe save button add karo
// ═══════════════════════════════════════════════════════════════════════

function injectFloatingButton() {
    if (document.getElementById('lri-save-button')) return; // already exists

    const button = document.createElement('div');
    button.id = 'lri-save-button';
    button.className = 'lri-fab';
    button.innerHTML = `
        <div class="lri-fab-icon">📥</div>
        <div class="lri-fab-text">Save Profile</div>
    `;

    button.addEventListener('click', handleSaveProfile);
    document.body.appendChild(button);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN SAVE HANDLER
// ═══════════════════════════════════════════════════════════════════════

async function handleSaveProfile() {
    const button = document.getElementById('lri-save-button');
    if (!button) return;

    // Show loading state
    button.classList.add('lri-loading');
    button.querySelector('.lri-fab-text').textContent = 'Capturing...';

    try {
        const data = await extractProfileData();

        // Save to chrome storage
        await chrome.runtime.sendMessage({
            action: 'saveProfile',
            data: data
        });

        // Success state
        button.classList.remove('lri-loading');
        button.classList.add('lri-success');
        button.querySelector('.lri-fab-icon').textContent = '✅';
        button.querySelector('.lri-fab-text').textContent = `Saved! ${data.hiringPosts?.length || 0} jobs found`;

        setTimeout(() => {
            button.classList.remove('lri-success');
            button.querySelector('.lri-fab-icon').textContent = '📥';
            button.querySelector('.lri-fab-text').textContent = 'Save Profile';
        }, 3000);

    } catch (err) {
        console.error('LRI Error:', err);
        button.classList.remove('lri-loading');
        button.classList.add('lri-error');
        button.querySelector('.lri-fab-icon').textContent = '❌';
        button.querySelector('.lri-fab-text').textContent = 'Failed: ' + err.message.substring(0, 30);

        setTimeout(() => {
            button.classList.remove('lri-error');
            button.querySelector('.lri-fab-icon').textContent = '📥';
            button.querySelector('.lri-fab-text').textContent = 'Save Profile';
        }, 5000);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// INIT — wait for page to settle, then inject button
// ═══════════════════════════════════════════════════════════════════════

function init() {
    // Wait for LinkedIn's SPA to render
    setTimeout(() => {
        injectFloatingButton();
    }, 1500);
}

// LinkedIn is SPA — listen for URL changes
let lastUrl = window.location.href;
new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // Remove old button, inject new one if on profile page
        const oldBtn = document.getElementById('lri-save-button');
        if (oldBtn) oldBtn.remove();
        if (window.location.href.match(/\/in\//)) {
            setTimeout(injectFloatingButton, 1500);
        }
    }
}).observe(document, { subtree: true, childList: true });

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
