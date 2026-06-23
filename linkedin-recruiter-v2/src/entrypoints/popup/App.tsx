/**
 * POPUP APP — Root Component (WXT)
 * ─────────────────────────────────
 * React rebuild of popup.js + popup.html. Two tabs (Saved | n8n), header
 * status pill, and the across-tabs live status bar. Visual parity with
 * v0.19.0 via the ported popup.css.
 */
import { useState } from 'react';
import { useProfiles } from './hooks/useProfiles';
import { useBulkState } from './hooks/useBulkState';
import { useSettings } from './hooks/useSettings';
import { StatusPill } from './components/StatusPill';
import { LiveStatusBar } from './components/LiveStatusBar';
import { ProfilesTab } from './components/ProfilesTab';
import { N8nTab } from './components/N8nTab';
import { send } from './lib/messaging';

type Tab = 'profiles' | 'n8n';

export default function App() {
  const { profiles, reload, remove, clearAll } = useProfiles();
  const { snap, status, setStatus } = useBulkState(reload); // reload profiles when a run completes
  const settings = useSettings();
  const [tab, setTab] = useState<Tab>('profiles');

  const stopFromBar = async () => {
    await send({ action: 'stopBulk' });
    setStatus('Stopped');
  };

  return (
    <>
      <header>
        <div className="logo">
          <span className="logo-icon">🎯</span>
          <h1>Recruiter Intel</h1>
        </div>
        <div className="header-right">
          <StatusPill
            isRunning={snap.isRunning}
            currentIndex={snap.currentIndex}
            totalUrls={snap.totalUrls}
            autoPull={settings.autoPull}
          />
          <div className="stats">
            <span id="profile-count">{profiles.length}</span>
          </div>
        </div>
      </header>

      <LiveStatusBar snap={snap} onStop={stopFromBar} />

      <nav className="tabs">
        <button className={`tab-btn ${tab === 'profiles' ? 'active' : ''}`} onClick={() => setTab('profiles')}>
          📋 Saved
        </button>
        <button className={`tab-btn ${tab === 'n8n' ? 'active' : ''}`} onClick={() => setTab('n8n')}>
          🔗 n8n
        </button>
      </nav>

      <ProfilesTab active={tab === 'profiles'} profiles={profiles} onDelete={remove} />
      <N8nTab
        active={tab === 'n8n'}
        profiles={profiles}
        settings={settings}
        bulk={{ snap, status, setStatus }}
        onClearAll={clearAll}
      />

      <footer>
        <p>LinkedIn Recruiter Intelligence v0.20.0 · 👥 Multi-tenant</p>
      </footer>
    </>
  );
}
