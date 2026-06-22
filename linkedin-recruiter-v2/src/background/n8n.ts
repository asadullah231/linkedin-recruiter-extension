/**
 * BACKGROUND — n8n INTEGRATION
 * ─────────────────────────────
 * Typed port of background/bg-n8n.js.
 *  - streamProfileToN8n(): push a single scraped profile to n8n immediately
 *    (live NocoDB row updates, one at a time).
 *  - sendBulkResultsToN8n(): legacy batch XLSX → n8n upload (kept for the
 *    manual "Send Now" flow; the live stream above is the default path).
 */

import { getResolvedN8nSettings, N8N_PROFILE_DONE_URL } from '../utils/settings';
import { getAllProfiles } from '../utils/storage';
import { buildXlsxBlob } from './exporter';
import { bulkLog } from './utils';
import { bulkState } from './state';
import type { RecruiterProfile } from '../types/profile';
import type { ResolvedN8nSettings, N8nSettings } from '../types/settings';

/** Version stamp sent on n8n payloads (kept from v0.19.0). */
const PROFILE_DONE_VERSION = '0.19.0';
const BULK_RESULTS_VERSION = '0.11.0';

/** Profile payload accepted by the stream — either a full profile or a "done" marker. */
type StreamProfile =
  | RecruiterProfile
  | {
      profileUrl: string;
      status: RecruiterProfile['status'];
      scrapedAt: string;
    };

/** Push a single scraped profile (or completion marker) to n8n immediately. */
export async function streamProfileToN8n(profileData: StreamProfile): Promise<unknown> {
  const settings = await getResolvedN8nSettings();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

  const res = await fetch(N8N_PROFILE_DONE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'linkedin-recruiter-extension',
      version: PROFILE_DONE_VERSION,
      owner: settings.owner || '', // ← who scraped this (for result tagging)
      timestamp: new Date().toISOString(),
      profile: profileData,
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

/** Legacy batch upload: build an XLSX of all saved profiles and POST to the callback URL. */
export async function sendBulkResultsToN8n(
  settings: ResolvedN8nSettings | (N8nSettings & { callbackUrl: string }),
  savedCount: number,
  skippedCount: number,
): Promise<void> {
  const profiles = await getAllProfiles();

  // Build XLSX binary (now via proper dynamic import in exporter.ts)
  let xlsxBlob: Blob | null = null;
  try {
    xlsxBlob = await buildXlsxBlob(profiles);
    bulkLog(`📊 Built XLSX (${(xlsxBlob.size / 1024).toFixed(1)} KB)`, 'info');
  } catch (err) {
    bulkLog(
      `⚠️ XLSX build failed: ${(err as Error).message}. Falling back to JSON.`,
      'error',
    );
  }

  const profileUrls = profiles.map((p) => p.profileUrl).filter(Boolean);
  const meta = {
    source: 'linkedin-recruiter-extension' as const,
    version: BULK_RESULTS_VERSION,
    timestamp: new Date().toISOString(),
    saved: savedCount,
    skipped: skippedCount,
    total: bulkState.totalUrls,
    profileUrls,
  };

  bulkLog(`📤 Auto-sending results to n8n: ${settings.callbackUrl}`, 'info');

  let res: Response;
  if (xlsxBlob) {
    // Multipart upload: file + meta JSON
    const formData = new FormData();
    formData.append('file', xlsxBlob, `jobs-${Date.now()}.xlsx`);
    formData.append('meta', JSON.stringify(meta));
    formData.append('profiles', JSON.stringify(profiles));

    const headers: Record<string, string> = {};
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;

    res = await fetch(settings.callbackUrl, { method: 'POST', headers, body: formData });
  } else {
    // Fallback: JSON only (no XLSX)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
    res = await fetch(settings.callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...meta,
        run: { saved: savedCount, skipped: skippedCount, total: bulkState.totalUrls },
        profiles,
      }),
    });
  }

  if (res.ok) {
    bulkLog(`✅ n8n callback OK (HTTP ${res.status})`, 'success');
  } else {
    bulkLog(`⚠️ n8n callback HTTP ${res.status}`, 'error');
  }
}
