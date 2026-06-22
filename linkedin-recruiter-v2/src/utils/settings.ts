/**
 * STORAGE LAYER — SETTINGS
 * ─────────────────────────
 * Typed access to the user's n8n + AI settings. URLs and behaviour flags are
 * fixed in code (see v0.19.0 popup.js loadN8nSettings); only owner/apiKey/
 * autoPull are user-controlled. `getResolvedN8nSettings()` merges the stored
 * values with the fixed endpoint URLs.
 */

import { storage } from 'wxt/storage';
import type {
  N8nSettings,
  ResolvedN8nSettings,
  AiSettings,
} from '../types/settings';

/** Fixed n8n endpoints — not user-editable. */
export const N8N_PULL_URL = 'https://n8n.emergeautomation.tech/webhook/pull-urls';
export const N8N_CALLBACK_URL = 'https://n8n.emergeautomation.tech/webhook/scrape-results';
export const N8N_PROFILE_DONE_URL = 'https://n8n.emergeautomation.tech/webhook/profile-done';

/** Default OpenRouter model when none is set. */
export const DEFAULT_AI_MODEL = 'google/gemini-flash-1.5';

export const n8nSettingsStore = storage.defineItem<N8nSettings>('local:n8nSettings', {
  fallback: {},
});

export const aiSettingsStore = storage.defineItem<AiSettings>('local:aiSettings', {
  fallback: {},
});

/** Raw stored n8n settings. */
export async function getN8nSettings(): Promise<N8nSettings> {
  return n8nSettingsStore.getValue();
}

/** Merge stored n8n settings with fixed URLs and normalised owner. stopAfterBatch is always on. */
export async function getResolvedN8nSettings(): Promise<ResolvedN8nSettings> {
  const stored = await n8nSettingsStore.getValue();
  return {
    pullUrl: N8N_PULL_URL,
    callbackUrl: N8N_CALLBACK_URL,
    apiKey: stored.apiKey ?? '',
    owner: (stored.owner ?? '').trim().toLowerCase(),
    autoPull: !!stored.autoPull,
    stopAfterBatch: true,
  };
}

/** Patch stored n8n settings, normalising owner to a trimmed lower-case string. */
export async function updateN8nSettings(patch: Partial<N8nSettings>): Promise<N8nSettings> {
  const current = await n8nSettingsStore.getValue();
  const merged: N8nSettings = { ...current, ...patch };
  if (typeof merged.owner === 'string') {
    merged.owner = merged.owner.trim().toLowerCase();
  }
  await n8nSettingsStore.setValue(merged);
  return merged;
}

/** Toggle the auto-pull flag (the one user-controlled scheduling switch). */
export async function setAutoPull(enabled: boolean): Promise<void> {
  await updateN8nSettings({ autoPull: enabled });
}

/** Stored AI settings, with the default model filled in when unset. */
export async function getAiSettings(): Promise<AiSettings> {
  const stored = await aiSettingsStore.getValue();
  return { ...stored, model: stored.model || DEFAULT_AI_MODEL };
}

/** Patch stored AI settings. */
export async function updateAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const current = await aiSettingsStore.getValue();
  const merged: AiSettings = { ...current, ...patch };
  await aiSettingsStore.setValue(merged);
  return merged;
}
