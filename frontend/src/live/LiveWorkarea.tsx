import { useLivePageStore } from '../state/livePage';
import { LiveChartRoot } from './LiveChartRoot';
import { LiveEmptyState } from './LiveEmptyState';
import { LiveSidebar } from './LiveSidebar';
import { WatchlistPanel } from './WatchlistPanel';
import InvariantOutcomesBanner from '../replay/InvariantOutcomesBanner';
import type { RangeBundle } from '../api/types';

interface Props {
  activeCode: string | null;
  /** Today's date in YYYYMMDD KST format, drilled from LivePage so LiveSidebar
   * can pass it to the cursor-spot hooks (useLiveOrderbookAtCursor etc.).
   * Source: todayKstYyyymmdd() called once in LivePage. */
  date: string;
  watchlistEmpty: boolean;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. */
  bundle: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
}

export function LiveWorkarea({
  activeCode,
  date,
  watchlistEmpty,
  bundle,
  clampEngaged,
  isPastCandlesLoading,
}: Props) {
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

  // Single chart owns all 5 panes; sidebar + optional watchlist stay siblings.
  return (
    <div
      data-testid="live-workarea"
      className="h-full flex"
      style={{
        background: 'var(--bg)',
        // minHeight: 0 + overflow: hidden close the runaway-chart-height
        // feedback loop (see 67c527a). The chart canvas's intrinsic size
        // would otherwise push the flex container's height.
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {bundle && (
          <InvariantOutcomesBanner
            excluded={bundle.excluded_dates ?? []}
            warnings={bundle.data_warnings ?? []}
          />
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <LiveChartRoot
            code={activeCode}
            timeframe={timeframe}
            bundle={bundle}
            clampEngaged={clampEngaged}
            isPastCandlesLoading={isPastCandlesLoading}
          />
        </div>
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
        <LiveSidebar code={activeCode} date={date} />
      </div>
      {watchlistOpen && <WatchlistPanel />}
    </div>
  );
}
