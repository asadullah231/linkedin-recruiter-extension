/**
 * POPUP — typed message helper
 * Thin wrapper around chrome.runtime.sendMessage for the background contract.
 */
import type { RuntimeMessage, BulkStateSnapshot } from '@/types/messages';
import type { ScrapedProfile } from '@/types/extraction';

interface Responses {
  getProfiles: { success: boolean; profiles: ScrapedProfile[] };
  getBulkState: { success: boolean; state: BulkStateSnapshot };
  startBulk: { success: boolean; started?: boolean; totalUrls?: number; error?: string };
  deleteProfile: { success: boolean };
  clearAll: { success: boolean };
  stopBulk: { success: boolean };
  setAutoPull: { success: boolean };
  saveProfile: { success: boolean };
  jobScraped: { success: boolean };
}

export async function send<A extends RuntimeMessage['action']>(
  message: Extract<RuntimeMessage, { action: A }>,
): Promise<Responses[A] | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as Responses[A];
  } catch {
    return null;
  }
}
