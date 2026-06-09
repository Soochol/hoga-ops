import { useLivePageStore } from '../state/livePage';
import { LiveChartRoot } from './LiveChartRoot';
import { LiveEmptyState } from './LiveEmptyState';
import { LiveSidebar } from './LiveSidebar';
import type { RangeBundle } from '../api/types';
import type { LiveSeriesData } from '../api/liveSeries';

interface Props {
  activeCode: string | null;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. Full bundle (chart + live hoga overlay). */
  bundle: RangeBundle | null;
  /** Chart side only, stable across SSE ticks (2026-06-09 bundle-split). Threaded
   * to LiveChartRoot for the candle path. Optional → LiveChartRoot falls back to
   * `bundle`. */
  chartBundle?: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isExtending — 진행 루프 settle-effect 구동용. LiveChartRoot로 전달. */
  isExtending: boolean;
  /** Owned by LivePage's single useLiveSeries call. Threaded to LiveSidebar
   * so the LATEST mode reads the same SSE buffer that feeds useLiveBundle. */
  live: LiveSeriesData;
}

export function LiveWorkarea({
  activeCode,
  bundle,
  chartBundle,
  clampEngaged,
  isPastCandlesLoading,
  isExtending,
  live,
}: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);

  if (!activeCode) {
    return (
      <div data-testid="live-workarea" className="h-full flex">
        <div style={{ flex: 1 }}>
          <LiveEmptyState cause="no_active_code" />
        </div>
      </div>
    );
  }

  // Single chart owns all 5 panes; sidebar stays a sibling.
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
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <LiveChartRoot
          code={activeCode}
          timeframe={timeframe}
          bundle={bundle}
          chartBundle={chartBundle}
          clampEngaged={clampEngaged}
          isPastCandlesLoading={isPastCandlesLoading}
          isExtending={isExtending}
        />
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
        <LiveSidebar code={activeCode} live={live} />
      </div>
    </div>
  );
}
