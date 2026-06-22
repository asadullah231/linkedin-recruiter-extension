/**
 * TYPE CONTRACTS — USER SETTINGS
 * ───────────────────────────────
 * Settings persisted in chrome.storage.local under `n8nSettings` and
 * `aiSettings`. URLs and behaviour flags are fixed in code; only the fields
 * below are user-controlled (see popup.js loadN8nSettings / saveOwner).
 */

/** n8n integration + team scoping settings (storage key: `n8nSettings`). */
export interface N8nSettings {
  /** Optional bearer token sent on n8n requests. */
  apiKey?: string;
  /** Team member identity, lower-cased — scopes pulls and tags results. */
  owner?: string;
  /** User toggle: auto-pull URLs on a schedule (default false). */
  autoPull?: boolean;
  /** Always ON — disable auto-pull once a batch completes. */
  stopAfterBatch?: boolean;
}

/** Resolved n8n settings merged with the fixed endpoint URLs. */
export interface ResolvedN8nSettings extends N8nSettings {
  /** Endpoint to pull queued profile URLs from. */
  pullUrl: string;
  /** Endpoint to push bulk results back to. */
  callbackUrl: string;
}

/** AI ranking/filtering settings (storage key: `aiSettings`). */
export interface AiSettings {
  /** Master switch for AI ranking + closed-job filtering. */
  enabled?: boolean;
  /** OpenRouter API key. */
  apiKey?: string;
  /** OpenRouter model id (default 'google/gemini-flash-1.5'). */
  model?: string;
  /** Remove posts detected as closed/expired before ranking. */
  filterClosed?: boolean;
}
