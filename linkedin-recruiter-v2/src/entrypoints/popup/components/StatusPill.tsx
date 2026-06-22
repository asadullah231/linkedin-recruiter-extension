/** POPUP — header status pill (idle / auto-pull armed / scraping). */
interface Props {
  isRunning: boolean;
  currentIndex: number;
  totalUrls: number;
  autoPull: boolean;
}

export function StatusPill({ isRunning, currentIndex, totalUrls, autoPull }: Props) {
  let cls = 'status-idle';
  let text = 'Idle';
  if (isRunning) {
    cls = 'status-scraping';
    text = `Scraping ${currentIndex + 1}/${totalUrls}`;
  } else if (autoPull) {
    cls = 'status-active';
    text = '🤖 Auto-pull ON';
  }
  return (
    <div className={`status-pill ${cls}`}>
      <span className="status-dot" />
      <span>{text}</span>
    </div>
  );
}
