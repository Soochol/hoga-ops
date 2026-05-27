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
      style={{
        background: 'var(--bg)',
        // minHeight: 0 + overflow: hidden close the loop where a chart
        // canvas's intrinsic size pushes the flex container's height,
        // which then pushes the parent grid track, which then re-resizes
        // the chart — runaway up to ~700k px in practice.
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        className="grid"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          // minmax(0, 1fr) prevents the row track from being pushed by the
          // chart canvas's intrinsic size — without the explicit 0 min,
          // CSS Grid defaults to `min-content` and lightweight-charts'
          // height-grows-with-data behavior expands the row to >600k px.
          gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)',
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
