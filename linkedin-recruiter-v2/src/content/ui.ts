/**
 * CONTENT SCRIPT — UI + LIFECYCLE
 * ────────────────────────────────
 * Typed port of content/content-ui.js. Injects the floating "Save Profile"
 * button, wires the save handler (extractProfileData → saveProfile message),
 * and re-injects the button as LinkedIn's SPA navigates between profiles.
 */

import { extractProfileData } from './profile-extractor';
import type { RuntimeMessage } from '../types/messages';

// ═══════════════════════════════════════════════════════════════════════
// FLOATING ACTION BUTTON
// ═══════════════════════════════════════════════════════════════════════

export function injectFloatingButton(): void {
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

const fabIcon = (btn: HTMLElement) => btn.querySelector<HTMLElement>('.lri-fab-icon');
const fabText = (btn: HTMLElement) => btn.querySelector<HTMLElement>('.lri-fab-text');

// ═══════════════════════════════════════════════════════════════════════
// MAIN SAVE HANDLER
// ═══════════════════════════════════════════════════════════════════════

async function handleSaveProfile(): Promise<void> {
  const button = document.getElementById('lri-save-button');
  if (!button) return;

  button.classList.add('lri-loading');
  const text = fabText(button);
  const icon = fabIcon(button);
  if (text) text.textContent = 'Capturing...';

  try {
    const data = await extractProfileData();

    const message: RuntimeMessage = { action: 'saveProfile', data };
    await chrome.runtime.sendMessage(message);

    button.classList.remove('lri-loading');
    button.classList.add('lri-success');
    if (icon) icon.textContent = '✅';
    if (text) text.textContent = `Saved! ${data.hiringPosts?.length || 0} jobs found`;

    setTimeout(() => {
      button.classList.remove('lri-success');
      if (icon) icon.textContent = '📥';
      if (text) text.textContent = 'Save Profile';
    }, 3000);
  } catch (err) {
    console.error('LRI Error:', err);
    button.classList.remove('lri-loading');
    button.classList.add('lri-error');
    if (icon) icon.textContent = '❌';
    if (text) text.textContent = 'Failed: ' + (err as Error).message.substring(0, 30);

    setTimeout(() => {
      button.classList.remove('lri-error');
      if (icon) icon.textContent = '📥';
      if (text) text.textContent = 'Save Profile';
    }, 5000);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LIFECYCLE — settle, inject, and watch SPA navigation
// ═══════════════════════════════════════════════════════════════════════

function init(): void {
  // Wait for LinkedIn's SPA to render
  setTimeout(() => injectFloatingButton(), 1500);
}

/** Watch for SPA URL changes and re-inject the button on profile pages. */
export function observeNavigation(): void {
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const oldBtn = document.getElementById('lri-save-button');
      if (oldBtn) oldBtn.remove();
      if (window.location.href.match(/\/in\//)) {
        setTimeout(injectFloatingButton, 1500);
      }
    }
  }).observe(document, { subtree: true, childList: true });
}

/** Entry point called by the content-script entrypoint. */
export function initContentScript(): void {
  console.log('🟢 LinkedIn Recruiter Intelligence: Content script loaded');
  observeNavigation();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
