/** POPUP — amber live status bar shown across all tabs while scraping. */
import type { BulkStateSnapshot } from '@/types/messages';

interface Props {
  snap: BulkStateSnapshot;
  onStop: () => void;
}

export function LiveStatusBar({ snap, onStop }: Props) {
  if (!snap.isRunning) return null;
  const pct = snap.totalUrls > 0 ? ((snap.currentIndex + 1) / snap.totalUrls) * 100 : 0;
  const detail = snap.log[snap.log.length - 1]?.message || 'Working...';

  return (
    <div className="live-status-bar" style={{ display: 'flex' }}>
      <div className="ls-icon">🔄</div>
      <div className="ls-content">
        <div className="ls-title">
          <span>Scraping profiles</span>
          <span className="ls-progress">
            <span>{snap.currentIndex + 1}</span>/<span>{snap.totalUrls}</span>
          </span>
        </div>
        <div className="ls-bar">
          <div className="ls-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="ls-detail">{detail}</div>
      </div>
      <button
        className="btn btn-danger"
        style={{ marginLeft: 10, padding: '6px 12px', fontSize: 12 }}
        onClick={onStop}
      >
        ⏹ STOP
      </button>
    </div>
  );
}
