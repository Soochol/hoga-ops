import { useLivePageStore } from '../state/livePage';
import { LiveCandlePane } from './LiveCandlePane';
import { LiveIndicatorPane } from './LiveIndicatorPane';
import { LiveEmptyState } from './LiveEmptyState';

interface Props {
  activeCode: string | null;
  watchlistEmpty: boolean;
}

export function LiveWorkarea({ activeCode, watchlistEmpty }: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);

  if (watchlistEmpty) {
    return (
      <div data-testid="live-workarea" className="h-full">
        <LiveEmptyState cause="watchlist_empty" />
      </div>
    );
  }
  if (!activeCode) {
    return (
      <div data-testid="live-workarea" className="h-full">
        <LiveEmptyState cause="no_active_code" />
      </div>
    );
  }

  return (
    <div
      data-testid="live-workarea"
      className="grid h-full"
      style={{ gridTemplateColumns: '1fr var(--sidebar-w)', background: 'var(--bg)' }}
    >
      <div
        className="grid"
        style={{
          gridTemplateRows: '1fr 1fr',
          minWidth: 0,
        }}
      >
        <LiveCandlePane timeframe={timeframe} />
        <LiveIndicatorPane timeframe={timeframe} />
      </div>
      <div
        id="live-watchlist-panel"
        role="complementary"
        aria-label="Live Sidebar"
        style={{
          borderLeft: '1px solid var(--border)',
          padding: 'var(--space-md)',
          color: 'var(--fg-dim)',
        }}
      >
        Live Sidebar (Stage 11)
      </div>
    </div>
  );
}
