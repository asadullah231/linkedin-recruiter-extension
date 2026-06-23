/**
 * POPUP HOOK — n8n + AI settings.
 * Loads via the typed M2 settings layer, enforces the fixed flags
 * (stopAfterBatch / filterClosed always on), and persists user changes.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getN8nSettings,
  updateN8nSettings,
  getAiSettings,
  updateAiSettings,
  setAutoPull as persistAutoPull,
  DEFAULT_AI_MODEL,
} from '@/utils/settings';
import { send } from '../lib/messaging';
import type { AiSettings } from '@/types/settings';

export function useSettings() {
  const [owner, setOwnerState] = useState('');
  const [autoPull, setAutoPullState] = useState(false);
  const [ai, setAiState] = useState<AiSettings>({ apiKey: '', model: DEFAULT_AI_MODEL, enabled: false });

  const reload = useCallback(async () => {
    const [n8n, aiSettings] = await Promise.all([getN8nSettings(), getAiSettings()]);
    setOwnerState((n8n.owner ?? '').trim().toLowerCase());
    setAutoPullState(!!n8n.autoPull);
    setAiState({
      apiKey: aiSettings.apiKey ?? '',
      model: aiSettings.model || DEFAULT_AI_MODEL,
      enabled: !!aiSettings.enabled,
    });
    // Enforce always-on flags (mirrors v0.19.0 loadN8nSettings)
    await updateN8nSettings({ stopAfterBatch: true });
    await updateAiSettings({ filterClosed: true });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveOwner = useCallback(async (value: string) => {
    const normalized = value.trim().toLowerCase();
    setOwnerState(normalized);
    await updateN8nSettings({ owner: normalized });
  }, []);

  const toggleAutoPull = useCallback(async (enabled: boolean) => {
    setAutoPullState(enabled);
    await persistAutoPull(enabled);
    await send({ action: 'setAutoPull', enabled });
  }, []);

  const saveAi = useCallback(async (patch: Partial<AiSettings>) => {
    setAiState((prev) => ({ ...prev, ...patch }));
    await updateAiSettings({ ...patch, filterClosed: true });
  }, []);

  return { owner, autoPull, ai, reload, saveOwner, toggleAutoPull, saveAi };
}
