/**
 * POPUP — n8n client (pull URLs, send saved profiles, test connection).
 * Typed port of the n8n functions from popup.js. URLs are fixed code
 * constants (M2); only the owner/apiKey scope each request.
 */
import { N8N_PULL_URL, N8N_CALLBACK_URL, getResolvedN8nSettings } from '@/utils/settings';
import { buildJobsCsv, buildProfilesCsv } from './csv';
import type { RecruiterProfile } from '@/types/profile';
import type { PullUrlResponse } from '@/types/n8n';

function headers(apiKey?: string, contentType = 'application/json'): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': contentType };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  return h;
}

/** Parse an n8n pull response down to a clean, de-duplicated list of /in/ URLs. */
export function extractUrlsFromN8nPayload(data: PullUrlResponse): string[] {
  let items: unknown[] = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.urls)) items = data.urls;
  else if (Array.isArray(data?.data)) items = data.data;
  else if (Array.isArray(data?.items)) items = data.items;

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let url: string | null = null;
    if (typeof item === 'string') {
      url = item;
    } else if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const candidate =
        rec['Profile URL'] ?? rec.profileUrl ?? rec.url ?? rec['LinkedIn-Profile'] ?? rec.linkedinUrl ??
        rec.ProfileURL ?? rec.ProfileUrl ?? rec['Profile Url'] ?? rec.profile_url ?? rec['profile-url'] ??
        rec.Url ?? rec.URL;
      if (typeof candidate === 'string') url = candidate;
      if (!url) {
        for (const k of Object.keys(rec)) {
          const v = rec[k];
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
      if (!seen.has(clean)) {
        seen.add(clean);
        urls.push(clean);
      }
    }
  }
  return urls;
}

export interface PullResult {
  ok: boolean;
  urls: string[];
  message: string;
}

/** Pull this owner's queued URLs from n8n. */
export async function pullFromN8n(): Promise<PullResult> {
  const { apiKey, owner } = await getResolvedN8nSettings();
  if (!owner) {
    return { ok: false, urls: [], message: '❌ Team ID (owner) is empty — please set your Team ID first.' };
  }
  const scopedUrl = `${N8N_PULL_URL}?owner=${encodeURIComponent(owner)}`;
  try {
    const res = await fetch(scopedUrl, { method: 'GET', headers: headers(apiKey) });
    if (!res.ok) return { ok: false, urls: [], message: `❌ HTTP ${res.status}: ${res.statusText}` };
    const data = (await res.json()) as PullUrlResponse;
    const urls = extractUrlsFromN8nPayload(data);
    if (urls.length === 0) return { ok: false, urls: [], message: '⚠️ No LinkedIn URLs found in response.' };
    return { ok: true, urls, message: `✅ Pulled ${urls.length} URLs. Click 🚀 Start Scrape.` };
  } catch (err) {
    return { ok: false, urls: [], message: `❌ ${(err as Error).message}` };
  }
}

/** POST all saved profiles (+ derived CSV) to the n8n callback URL. */
export async function sendToN8n(profiles: RecruiterProfile[]): Promise<string> {
  if (profiles.length === 0) return '⚠️ No profiles to send.';
  const { apiKey } = await getResolvedN8nSettings();

  const payload = {
    source: 'linkedin-recruiter-extension',
    version: '0.3.0',
    timestamp: new Date().toISOString(),
    counts: {
      profiles: profiles.length,
      jobs: profiles.reduce((n, p) => n + (p.hiringPosts?.length || 0), 0),
    },
    profiles,
    csv: { jobs: buildJobsCsv(profiles), profiles: buildProfilesCsv(profiles) },
  };

  try {
    const res = await fetch(N8N_CALLBACK_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(payload),
    });
    if (!res.ok) return `❌ HTTP ${res.status}: ${res.statusText}`;
    return `✅ Sent ${profiles.length} profiles to n8n.`;
  } catch (err) {
    return `❌ ${(err as Error).message}`;
  }
}

/** Ping both endpoints; returns a list of log lines. */
export async function testN8nConnection(): Promise<{ message: string; ok: boolean }[]> {
  const { apiKey } = await getResolvedN8nSettings();
  const out: { message: string; ok: boolean }[] = [];

  out.push({ message: '🔌 Testing pull URL...', ok: true });
  try {
    const r = await fetch(N8N_PULL_URL, { method: 'GET', headers: headers(apiKey) });
    out.push({ message: `  Pull → HTTP ${r.status}`, ok: r.ok });
  } catch (e) {
    out.push({ message: `  Pull failed: ${(e as Error).message}`, ok: false });
  }

  out.push({ message: '🔌 Testing callback URL...', ok: true });
  try {
    const r = await fetch(N8N_CALLBACK_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ test: true, source: 'linkedin-recruiter-extension' }),
    });
    out.push({ message: `  Callback → HTTP ${r.status}`, ok: r.ok });
  } catch (e) {
    out.push({ message: `  Callback failed: ${(e as Error).message}`, ok: false });
  }
  return out;
}
