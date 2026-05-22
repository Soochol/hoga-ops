import { useEffect } from 'react';
import { HistogramSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import { type Segment, realToVirtual, isWithinSessions } from '../util/time';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = {
  up: ['--up', '#22C55E'],
  down: ['--down', '#F43F5E'],
} as const;

type Props = {
  chart: IChartApi;
  bundle: SessionBundle;
  segments: Segment[];
  /** Pane index for multi-pane split. Defaults to 0. */
  paneIndex?: number;
};

/**
 * FillStrengthPane — paints buy/sell fill strength as two stacked
 * HistogramSeries on the shared chart instance. Buys are rendered with
 * positive values (above the 0 baseline, up color); sells are rendered
 * with NEGATIVE values so they appear mirrored below the 0 baseline using
 * the down color. Both series share the same priceScale via `base: 0`.
 *
 * Multi-day x-axis stitching is handled by mapping each point's real
 * Unix-ms timestamp through `realToVirtual(segments, …)`.
 */
export default function FillStrengthPane({ chart, bundle, segments, paneIndex = 0 }: Props) {
  useEffect(() => {
    const { up, down } = resolveTokens(TOKEN_SPEC);
    // Custom integer-comma formatter matches CandlePane / VolumePane. The buy
    // series owns the price-axis labels for this pane (sell renders below the
    // 0 baseline using mirrored negative values), but we apply the same format
    // to both so crosshair / tooltips stay consistent. `Math.abs` so the sell
    // baseline label shows e.g. "1,200" not "-1,200".
    const histOpts = {
      base: 0,
      priceFormat: {
        type: 'custom' as const,
        formatter: (v: number) => Math.round(Math.abs(v)).toLocaleString('ko-KR'),
        minMove: 1,
      },
    };
    const buy = chart.addSeries(HistogramSeries, { color: up, ...histOpts } as any, paneIndex);
    const sell = chart.addSeries(HistogramSeries, { color: down, ...histOpts } as any, paneIndex);
    // Drop pre-open auction points and any others outside the regular-session
    // segments. Without this filter, multiple pre-session points collapse to
    // virtual-time=0 and lightweight-charts.setData throws "data must be asc
    // ordered by time". The filtered list is shared between buy and sell so
    // we only run isWithinSessions once. See util/time.ts:isWithinSessions.
    const inSession = bundle.fill_strength.points.filter((p) =>
      isWithinSessions(segments, p.t),
    );
    // Backend (build_fill_strength_slice) now buckets on linear ms-from-midnight
    // and guarantees strictly-ascending unique timestamps per ADR-0010.
    // sortAndDedupeByTime in util/time.ts remains available as defense-in-depth.
    buy.setData(
      inSession.map((p) => ({
        // lightweight-charts uses UTCTimestamp (seconds) on the time axis.
        // The `as any` cast keeps us free of the library's branded `Time`
        // type without dragging it into the public API.
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: p.buy_qty,
      })),
    );
    sell.setData(
      inSession.map((p) => ({
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: -p.sell_qty, // negative — renders below the 0 baseline
      })),
    );
    return () => {
      // Guard: see RatioPane.tsx for the unwind-order rationale.
      try {
        chart.removeSeries(buy);
      } catch {
        // chart already torn down
      }
      try {
        chart.removeSeries(sell);
      } catch {
        // chart already torn down
      }
    };
  }, [chart, bundle, segments, paneIndex]);
  return null;
}
