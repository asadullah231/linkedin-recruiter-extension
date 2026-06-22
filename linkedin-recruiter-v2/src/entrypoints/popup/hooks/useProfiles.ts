/** POPUP HOOK — saved profiles (load / delete / clear via background messages). */
import { useCallback, useEffect, useState } from 'react';
import { send } from '../lib/messaging';
import type { ScrapedProfile } from '@/types/extraction';

export function useProfiles() {
  const [profiles, setProfiles] = useState<ScrapedProfile[]>([]);

  const reload = useCallback(async () => {
    const res = await send({ action: 'getProfiles' });
    if (res?.success) setProfiles(res.profiles);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = useCallback(
    async (profileUrl: string) => {
      await send({ action: 'deleteProfile', profileUrl });
      await reload();
    },
    [reload],
  );

  const clearAll = useCallback(async () => {
    await send({ action: 'clearAll' });
    await reload();
  }, [reload]);

  return { profiles, reload, remove, clearAll };
}
