/**
 * POPUP HOOK — live bulk-scrape state.
 * Seeds from getBulkState, listens for `bulkProgress` broadcasts, and polls
 * every 2s (covers runs started by the background auto-pull alarm). Calls
 * onComplete when a run finishes so the caller can reload the profile list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { send } from '../lib/messaging';
import type { BulkStateSnapshot, BulkProgressMessage } from '@/types/messages';

const EMPTY: BulkStateSnapshot = { isRunning: false, currentIndex: 0, totalUrls: 0, log: [] };

export function useBulkState(onComplete?: () => void) {
  const [snap, setSnap] = useState<BulkStateSnapshot>(EMPTY);
  const [status, setStatus] = useState('Ready');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    const res = await send({ action: 'getBulkState' });
    if (res?.success) {
      setSnap(res.state);
      setStatus((s) => (res.state.isRunning ? 'Running...' : res.state.log.length ? (s === 'Ready' ? 'Done' : s) : s));
      if (wasRunning.current && !res.state.isRunning) onCompleteRef.current?.();
      wasRunning.current = res.state.isRunning;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 2000);

    const listener = (msg: unknown) => {
      const m = msg as BulkProgressMessage;
      if (m?.action !== 'bulkProgress') return;
      setSnap((s) => ({
        isRunning: m.isRunning,
        currentIndex: m.currentIndex,
        totalUrls: m.totalUrls,
        log: m.latestLog ? [...s.log, m.latestLog] : s.log,
      }));
      setStatus(m.isRunning ? 'Running...' : '✅ Complete');
      if (wasRunning.current && !m.isRunning) onCompleteRef.current?.();
      wasRunning.current = m.isRunning;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      clearInterval(interval);
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refresh]);

  return { snap, status, setStatus, refresh };
}
