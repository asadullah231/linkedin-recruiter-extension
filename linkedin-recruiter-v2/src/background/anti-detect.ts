/**
 * BACKGROUND — ANTI-DETECTION HARDENING
 * ──────────────────────────────────────
 * All LinkedIn anti-blocking logic lives here in one auditable, typed file so
 * the timing can be tuned without touching the bulk-queue logic.
 *
 * Three concerns:
 *   1. computeDelay()      — humanised inter-profile pacing (floor + jitter).
 *   2. maybeCircuitBreak() — back off when LinkedIn starts erroring on us.
 *   3. sessionGuard        — hard cap of N profiles per rolling time window;
 *                            disarms auto-pull when the cap is hit.
 *
 * Previously the delay + circuit breaker were inlined in bulk.ts; M6 lifts them
 * out so there is a single place to audit/adjust the detection-avoidance knobs.
 */

import { storage } from 'wxt/storage';
import { bulkLog, sleep, updateBadge } from './utils';
import { updateN8nSettings } from '../utils/settings';

/** Tunable knobs for every anti-detection behaviour. */
export interface AntiDetectConfig {
  /** Floor for the inter-profile wait when a profile had jobs (the heavy path). */
  minDelayMs: number; // 10000 (10s)
  /** Random extra added on top of the floor, 0..maxJitterMs. */
  maxJitterMs: number; // 5000 (5s)
  /** Consecutive errors that trigger a short cooldown (45–75s). */
  cooldownAfterErrors: number; // 3
  /** Consecutive errors that trigger a hard stop (3–4 min) + error reset. */
  hardStopAfterErrors: number; // 5
  /** [min, max] wait for empty/0-job profiles (the light path). */
  emptyProfileDelayMs: [number, number]; // [2000, 3500]
  /** Max profiles allowed per rolling session window. */
  sessionLimit: number; // 150
  /** Rolling window length for the session limit. */
  sessionWindowMs: number; // 4h
}

/** Production defaults — mirror the v0.19.0 hand-tuned timings, hardened. */
export const DEFAULT_ANTI_DETECT_CONFIG: AntiDetectConfig = {
  minDelayMs: 10_000,
  maxJitterMs: 5_000,
  cooldownAfterErrors: 3,
  hardStopAfterErrors: 5,
  emptyProfileDelayMs: [2_000, 3_500],
  sessionLimit: 150,
  sessionWindowMs: 4 * 60 * 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════════
// 1. SMART DELAY
// ═══════════════════════════════════════════════════════════════════════

/**
 * How long to wait before the next profile.
 *
 * - hadJobs   → heavy path: max(user-set base delay, minDelayMs) + 0..maxJitterMs.
 *               The user's configured `delay` is honoured but floored at
 *               `minDelayMs` so nobody can dial the gap below the safe minimum.
 * - !hadJobs  → light path: a short random pause in the emptyProfileDelayMs band.
 *
 * @param hadJobs     Did the just-scraped profile actually yield hiring jobs?
 * @param baseDelayMs The user-configured base delay in ms (bulkState.delay * 1000).
 */
export function computeDelay(
  hadJobs: boolean,
  baseDelayMs: number,
  config: AntiDetectConfig = DEFAULT_ANTI_DETECT_CONFIG,
): number {
  if (!hadJobs) {
    const [min, max] = config.emptyProfileDelayMs;
    return min + Math.random() * (max - min);
  }
  const floor = Math.max(baseDelayMs, config.minDelayMs);
  return floor + Math.random() * config.maxJitterMs;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Back off when LinkedIn is erroring on us (likely rate-limiting / blocking).
 *
 * - >= hardStopAfterErrors → pause 3–4 min, then signal the caller to reset the
 *   counter (returns true).
 * - >= cooldownAfterErrors → pause 45–75s, counter left intact (returns false).
 * - otherwise              → no-op (returns false).
 *
 * @returns whether the caller should reset `consecutiveErrors` to 0.
 */
export async function maybeCircuitBreak(
  consecutiveErrors: number,
  config: AntiDetectConfig = DEFAULT_ANTI_DETECT_CONFIG,
): Promise<boolean> {
  if (consecutiveErrors >= config.hardStopAfterErrors) {
    const coolMs = 3 * 60 * 1000 + Math.random() * 60 * 1000; // 3–4 min
    bulkLog(
      `🚨 ${consecutiveErrors} consecutive errors — cooling ${Math.round(
        coolMs / 1000,
      )}s to avoid LinkedIn block`,
      'error',
    );
    await sleep(coolMs);
    return true; // caller resets the counter
  }

  if (consecutiveErrors >= config.cooldownAfterErrors) {
    const coolMs = 45 * 1000 + Math.random() * 30 * 1000; // 45–75s
    bulkLog(
      `⚠️ ${consecutiveErrors} consecutive errors — pausing ${Math.round(coolMs / 1000)}s`,
      'error',
    );
    await sleep(coolMs);
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// 3. SESSION GUARD — hard cap of N profiles per rolling window
// ═══════════════════════════════════════════════════════════════════════

/**
 * Timestamps (ms epoch) of recent profile scrapes, persisted so the cap holds
 * across service-worker restarts within the window.
 */
const scrapeTimestampsStore = storage.defineItem<number[]>('local:antiDetectScrapeLog', {
  fallback: [],
});

/** Drop timestamps that have aged out of the rolling window. */
function prune(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

export interface SessionUsage {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Per-session rate limiter. Enforces `sessionLimit` profiles per
 * `sessionWindowMs` rolling window and disarms auto-pull when the cap is hit.
 */
export const sessionGuard = {
  /** Record one profile scrape against the rolling window. */
  async record(config: AntiDetectConfig = DEFAULT_ANTI_DETECT_CONFIG): Promise<void> {
    const now = Date.now();
    const pruned = prune(await scrapeTimestampsStore.getValue(), config.sessionWindowMs, now);
    pruned.push(now);
    await scrapeTimestampsStore.setValue(pruned);
  },

  /** Current usage within the window. */
  async usage(config: AntiDetectConfig = DEFAULT_ANTI_DETECT_CONFIG): Promise<SessionUsage> {
    const now = Date.now();
    const pruned = prune(await scrapeTimestampsStore.getValue(), config.sessionWindowMs, now);
    const used = pruned.length;
    return { used, limit: config.sessionLimit, remaining: Math.max(0, config.sessionLimit - used) };
  },

  /** True while there is still room in the window. */
  async hasCapacity(config: AntiDetectConfig = DEFAULT_ANTI_DETECT_CONFIG): Promise<boolean> {
    return (await this.usage(config)).remaining > 0;
  },

  /**
   * Gate a scrape on the session limit. If the cap is hit, disarms auto-pull
   * (clears the alarm + persists autoPull:false) and logs a warning so the run
   * stops cleanly instead of hammering LinkedIn.
   *
   * @returns true if scraping may proceed, false if the cap is reached.
   */
  async enforce(config: AntiDetectConfig = DEFAULT_ANTI_DETECT_CONFIG): Promise<boolean> {
    const { used, limit, remaining } = await this.usage(config);
    if (remaining > 0) return true;

    const windowHrs = Math.round(config.sessionWindowMs / (60 * 60 * 1000));
    bulkLog(
      `🛑 Session limit reached: ${used}/${limit} profiles in ${windowHrs}h — pausing auto-pull to stay safe`,
      'error',
    );
    try {
      chrome.alarms.clear('auto-pull');
      await updateN8nSettings({ autoPull: false });
      void updateBadge();
    } catch (err) {
      console.error('SessionGuard: failed to disarm auto-pull', err);
    }
    return false;
  },

  /** Clear the rolling window (e.g. manual reset / testing). */
  async reset(): Promise<void> {
    await scrapeTimestampsStore.setValue([]);
  },
};
