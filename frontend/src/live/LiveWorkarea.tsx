import { useLivePageStore } from '../state/livePage';
import { LiveCandlePane } from './LiveCandlePane';
import { LiveIndicatorPane } from './LiveIndicatorPane';
import { LiveEmptyState } from './LiveEmptyState';
import { LiveSidebar } from './LiveSidebar';
import { WatchlistPanel } from './WatchlistPanel';

interface Props {
  activeCode: string | null;
  watchlistEmpty: boolean;
}

export function LiveWorkarea({ activeCode, watchlistEmpty }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const watchlistOpen = useLivePageStore((s) => s.watchlistPanelOpen);

  if (watchlistEmpty) {
    return (
      <div data-testid="live-workarea" className="h-full">
        <LiveEmptyState cause="watchlist_empty" />
      </div>
    );
  }
  if (!activeCode) {
    return (
      <div data-testid="live-workarea" className="h-full flex">
        <div style={{ flex: 1 }}>
          <LiveEmptyState cause="no_active_code" />
        </div>
        {watchlistOpen && <WatchlistPanel />}
      </div>
    );
  }

  // Three-column layout: chart stack | LiveSidebar | optional WatchlistPanel
  return (
    <div
      data-testid="live-workarea"
      className="h-full flex"
      style={{ background: 'var(--bg)' }}
    >
      <div
        className="grid"
        style={{
          flex: 1,
          minWidth: 0,
          gridTemplateRows: '1fr 1fr',
        }}
      >
        <LiveCandlePane code={activeCode} timeframe={timeframe} />
        <LiveIndicatorPane code={activeCode} timeframe={timeframe} />
      </div>
      <div
        role="complementary"
        aria-label="Live Sidebar"
        style={{
          width: 'var(--sidebar-w)',
          flexShrink: 0,
          borderLeft: '1px solid var(--border)',
        }}
      >
        <LiveSidebar code={activeCode} />
      </div>
      {watchlistOpen && <WatchlistPanel />}
    </div>
  );
}
