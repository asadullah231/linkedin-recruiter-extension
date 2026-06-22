/**
 * STORAGE LAYER — PROFILES
 * ─────────────────────────
 * Typed replacement for background/bg-storage.js. Profiles are stored as a
 * record keyed by profileUrl under `local:profiles`, via WXT's storage
 * composable. Keeps the toolbar badge count in sync, exactly like v0.19.0.
 */

import { storage } from 'wxt/storage';
import type { RecruiterProfile } from '../types/profile';

/** Result returned by saveProfile, mirroring the v0.19.0 ack shape. */
export interface SaveProfileResult {
  /** ISO 8601 timestamp of the save. */
  savedAt: string;
  totalProfiles: number;
  /** fullName of the saved profile. */
  profile: string;
}

/** All profiles, keyed by profileUrl. */
export const profileStore = storage.defineItem<Record<string, RecruiterProfile>>(
  'local:profiles',
  { fallback: {} },
);

/** Format a profile count for the toolbar badge (caps at "99+", "" when 0). */
function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/** Push the current profile count to the toolbar badge. */
function syncBadge(count: number): void {
  chrome.action.setBadgeText({ text: badgeText(count) });
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
  }
}

/** Save (or overwrite) a profile, keyed by its profileUrl. */
export async function saveProfile(profile: RecruiterProfile): Promise<SaveProfileResult> {
  if (!profile?.profileUrl) {
    throw new Error('Invalid profile data — missing profileUrl');
  }

  const profiles = await profileStore.getValue();
  profiles[profile.profileUrl] = profile;
  await profileStore.setValue(profiles);

  const count = Object.keys(profiles).length;
  syncBadge(count);

  return {
    savedAt: new Date().toISOString(),
    totalProfiles: count,
    profile: profile.fullName,
  };
}

/** All saved profiles, newest scrape first. */
export async function getAllProfiles(): Promise<RecruiterProfile[]> {
  const profiles = await profileStore.getValue();
  return Object.values(profiles).sort(
    (a, b) => new Date(b.scrapedAt).getTime() - new Date(a.scrapedAt).getTime(),
  );
}

/** Delete a profile by its profileUrl and resync the badge. */
export async function deleteProfile(profileUrl: string): Promise<void> {
  const profiles = await profileStore.getValue();
  delete profiles[profileUrl];
  await profileStore.setValue(profiles);
  syncBadge(Object.keys(profiles).length);
}

/** Subscribe to profile changes (e.g. for live popup refresh). Returns an unwatch fn. */
export function watchProfiles(
  cb: (profiles: Record<string, RecruiterProfile>) => void,
): () => void {
  return profileStore.watch((value) => cb(value ?? {}));
}
