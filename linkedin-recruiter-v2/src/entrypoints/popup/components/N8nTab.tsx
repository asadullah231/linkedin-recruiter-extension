/** POPUP — "n8n" tab: team ID, auto mode, manual run, bulk progress, AI, activity log. */
import { useEffect, useState } from 'react';
import { send } from '../lib/messaging';
import { pullFromN8n, sendToN8n, testN8nConnection } from '../lib/popupN8n';
import type { RecruiterProfile } from '@/types/profile';
import type { BulkStateSnapshot } from '@/types/messages';
import type { useSettings } from '../hooks/useSettings';

type LogLevel = 'info' | 'success' | 'error';
interface LogLine {
  message: string;
  type: LogLevel;
  stamp: string;
}

interface Props {
  active: boolean;
  profiles: RecruiterProfile[];
  settings: ReturnType<typeof useSettings>;
  bulk: { snap: BulkStateSnapshot; status: string; setStatus: (s: string) => void };
  onClearAll: () => void;
}

const MIN_DELAY = 7;

export function N8nTab({ active, profiles, settings, bulk, onClearAll }: Props) {
  const { owner, autoPull, ai, saveOwner, toggleAutoPull, saveAi } = settings;
  const { snap, status, setStatus } = bulk;

  const [ownerDraft, setOwnerDraft] = useState(owner);
  const [pendingUrls, setPendingUrls] = useState<string[]>([]);
  const [delay, setDelay] = useState(MIN_DELAY);
  const [enrichJobs, setEnrichJobs] = useState(false);
  const [log, setLog] = useState<LogLine[]>([
    { message: 'Idle. Configure URLs and save above.', type: 'info', stamp: '' },
  ]);

  // keep owner draft in sync when settings load after mount
  useEffect(() => {
    setOwnerDraft(owner);
  }, [owner]);

  const addLog = (message: string, type: LogLevel = 'info') =>
    setLog((prev) => [...prev, { message, type, stamp: new Date().toLocaleTimeString() }]);

  const onPull = async () => {
    addLog(`📥 Fetching ${owner || '(no owner)'}'s URLs...`, 'info');
    const res = await pullFromN8n();
    if (res.ok) setPendingUrls(res.urls);
    addLog(res.message, res.ok ? 'success' : 'error');
  };

  const onStart = async () => {
    if (pendingUrls.length === 0) {
      alert('No URLs in queue. Click "📥 Pull URLs" first to fetch from n8n.');
      return;
    }
    const urls = pendingUrls.slice();
    if (urls.length > 200) {
      if (!confirm(`${urls.length} URLs queued. This will take ~${Math.round(urls.length * 0.5)} hours. Continue?`)) return;
    }
    const finalDelay = Math.max(MIN_DELAY, delay || MIN_DELAY);
    setDelay(finalDelay);
    setStatus('Starting...');
    await send({ action: 'startBulk', urls, options: { delay: finalDelay, enrichJobs } });
  };

  const onStop = async () => {
    await send({ action: 'stopBulk' });
    setStatus('Stopped');
  };

  const onSend = async () => {
    if (profiles.length === 0) {
      addLog('⚠️ No profiles to send.', 'error');
      return;
    }
    addLog(`📤 Sending ${profiles.length} profiles to n8n...`, 'info');
    const msg = await sendToN8n(profiles);
    addLog(msg, msg.startsWith('✅') ? 'success' : 'error');
  };

  const onTest = async () => {
    const lines = await testN8nConnection();
    for (const l of lines) addLog(l.message, l.ok ? 'success' : 'error');
  };

  const onClear = () => {
    if (profiles.length === 0) return;
    if (confirm(`Delete all ${profiles.length} saved profiles? This cannot be undone.`)) onClearAll();
  };

  const onToggle = async (checked: boolean) => {
    await toggleAutoPull(checked);
    addLog(checked ? '🟢 Auto Mode ENABLED — extension will pull every 30s.' : '⏸ Auto Mode PAUSED.', checked ? 'success' : 'info');
  };

  const showProgress = snap.isRunning || snap.log.length > 0;
  const pct = snap.totalUrls > 0 ? ((snap.currentIndex + 1) / snap.totalUrls) * 100 : 0;
  const queueText = pendingUrls.length === 0 ? '📭 No URLs pulled yet.' : `📋 ${pendingUrls.length} URLs ready to scrape.`;

  return (
    <div className={`tab-pane ${active ? 'active' : ''}`} id="tab-n8n">
      <div className="bulk-section">
        {/* TEAM IDENTITY */}
        <div className="input-group" style={{ marginBottom: 12 }}>
          <label>👤 Your Team ID (owner):</label>
          <input
            type="text"
            placeholder="e.g. mahmoud, usman"
            autoComplete="off"
            value={ownerDraft}
            onChange={(e) => setOwnerDraft(e.target.value)}
            onBlur={() => {
              void saveOwner(ownerDraft);
              addLog(ownerDraft.trim() ? `👤 Team ID set: ${ownerDraft.trim().toLowerCase()}` : '⚠️ Team ID cleared — pull will be unscoped!', ownerDraft.trim() ? 'success' : 'error');
            }}
          />
          <small className="hint-small">Only your URLs will be pulled, and results are tagged to your name. (all lowercase, no spaces)</small>
        </div>

        {/* AUTO MODE */}
        <div className={`auto-mode-banner ${autoPull ? 'running' : 'paused'}`}>
          <div className="auto-mode-header">
            <div className="auto-mode-title">🤖 <strong>Auto Mode</strong></div>
            <label className="toggle-switch">
              <input type="checkbox" checked={autoPull} onChange={(e) => void onToggle(e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="auto-mode-list">
            ✅ Auto-pull every 30s &nbsp;·&nbsp; ✅ Stop after batch &nbsp;·&nbsp; ✅ Auto-send results &nbsp;·&nbsp; ✅ Skip closed jobs
          </div>
          <div className="auto-mode-state">
            {autoPull ? '🟢 Running — pulling every 30 seconds' : '⏸ Paused — flip the switch to start'}
          </div>
          <div className="auto-mode-action">
            <button className="btn btn-primary" onClick={() => void onTest()}>🔌 Test Connection</button>
          </div>
        </div>

        <hr className="divider" />

        {/* MANUAL CONTROL */}
        <h3>🎮 Manual Run <span className="badge-optional">optional</span></h3>
        <p className="hint">Trigger a scrape on demand. Results still auto-upload to Slack.</p>

        <div className="settings-row">
          <label>⏱️ Delay between profiles:</label>
          <input
            type="number"
            value={delay}
            min={MIN_DELAY}
            max={60}
            style={{ width: 60 }}
            onChange={(e) => setDelay(parseInt(e.target.value) || MIN_DELAY)}
            onBlur={() => setDelay((d) => Math.max(MIN_DELAY, d))}
          />{' '}
          <small>seconds (lower = faster but more risk)</small>
        </div>

        <div className="settings-row">
          <label>
            <input type="checkbox" checked={enrichJobs} onChange={(e) => setEnrichJobs(e.target.checked)} /> Enrich each job page (visit each job → slower but more detail)
          </label>
        </div>

        <div className="actions">
          <button className="btn btn-primary" onClick={() => void onPull()}>📥 Pull URLs</button>
          {!snap.isRunning ? (
            <button className="btn btn-success" onClick={() => void onStart()}>🚀 Start Scrape</button>
          ) : (
            <button className="btn btn-danger" onClick={() => void onStop()}>⏹ Stop</button>
          )}
        </div>

        <div className="queue-status">{queueText}</div>

        {/* LIVE PROGRESS */}
        {showProgress && (
          <div style={{ display: 'block', marginTop: 12 }}>
            <strong style={{ fontSize: 12 }}>📊 Scraping progress:</strong>
            <div className="progress-bar-wrap" style={{ marginTop: 6 }}>
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-text">
              <span>{snap.isRunning || snap.totalUrls ? snap.currentIndex + 1 : 0}</span> / <span>{snap.totalUrls}</span> profiles · <span>{status}</span>
            </div>
            <div className="progress-log">
              {snap.log.map((entry, i) => (
                <div className={`log-line log-${entry.type}`} key={i}>
                  {entry.message}
                </div>
              ))}
            </div>
          </div>
        )}

        <hr className="divider" />

        {/* AI RANKING */}
        <details className="advanced-section">
          <summary>🤖 AI Top-Job Ranking <span className="badge-optional">advanced · optional</span></summary>
          <div style={{ paddingTop: 8 }}>
            <p className="hint-small">Use AI to pick the most senior role per recruiter. Adds 'Is Top Job' tag in CSV.</p>
            <div className="input-group">
              <label>OpenRouter API Key:</label>
              <input
                type="password"
                placeholder="sk-or-v1-..."
                value={ai.apiKey ?? ''}
                onChange={(e) => void saveAi({ apiKey: e.target.value })}
              />
            </div>
            <div className="input-group">
              <label>Model:</label>
              <select
                style={{ width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}
                value={ai.model}
                onChange={(e) => void saveAi({ model: e.target.value })}
              >
                <option value="google/gemini-flash-1.5">Gemini Flash 1.5 (fastest, cheapest) ⭐</option>
                <option value="openai/gpt-4o-mini">GPT-4o-mini (balanced)</option>
                <option value="anthropic/claude-3-haiku">Claude Haiku (accurate)</option>
              </select>
            </div>
            <div className="settings-row">
              <label>
                <input type="checkbox" checked={!!ai.enabled} onChange={(e) => void saveAi({ enabled: e.target.checked })} /> Enable AI ranking
              </label>
            </div>
          </div>
        </details>

        <hr className="divider" />

        {/* ACTIVITY LOG */}
        <h3>📜 Activity Log</h3>
        <div className="progress-log" style={{ minHeight: 60 }}>
          {log.map((l, i) => (
            <div className={`log-line log-${l.type}`} key={i}>
              {l.stamp ? `[${l.stamp}] ${l.message}` : l.message}
            </div>
          ))}
        </div>

        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => void onSend()}>📤 Send Saved Profiles Now</button>
          <button className="btn btn-danger" onClick={onClear}>🗑️ Clear Local Data</button>
        </div>
      </div>
    </div>
  );
}
