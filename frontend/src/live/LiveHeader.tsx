import { useLivePageStore } from '../state/livePage';

export function LiveHeader() {
  const open = useLivePageStore((s) => s.watchlistPanelOpen);
  const toggle = useLivePageStore((s) => s.toggleWatchlistPanel);
  return (
    <div
      data-testid="live-header"
      className="flex items-center justify-between border-b px-3"
      style={{ height: 'var(--h-live-header)', borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
    >
      <h1 className="font-semibold" style={{ fontSize: 'var(--text-md)', color: 'var(--fg)' }}>
        Live
      </h1>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="live-watchlist-panel"
        aria-label="관심종목 패널 토글"
        className="px-2 py-1 rounded"
        style={{
          background: open ? 'var(--tint-selection)' : 'transparent',
          color: open ? 'var(--accent)' : 'var(--fg-dim)',
          fontSize: 'var(--text-base)',
        }}
      >
        {open ? '★' : '☆'}
      </button>
    </div>
  );
}
