import { useEffect } from 'react';
import { HistogramSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import { type Segment, realToVirtual } from '../util/time';

/**
 * Resolves DESIGN.md up/down color tokens from `:root` to concrete strings.
 * lightweight-charts paints to a canvas and cannot interpret `var(--…)`, so
 * we resolve once on mount and pass concrete hex values to the series.
 * Tokens live in `src/styles/tokens.css`.
 */
function resolveTokens(): { up: string; down: string } {
  if (typeof document === 'undefined') {
    return { up: '#22C55E', down: '#F43F5E' };
  }
  const cs = getComputedStyle(document.documentElement);
  return {
    up: cs.getPropertyValue('--up').trim() || '#22C55E',
    down: cs.getPropertyValue('--down').trim() || '#F43F5E',
  };
}

type Props = { chart: IChartApi; bundle: SessionBundle; segments: Segment[] };

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
export default function FillStrengthPane({ chart, bundle, segments }: Props) {
  useEffect(() => {
    const { up, down } = resolveTokens();
    const buy = chart.addSeries(HistogramSeries, { color: up, base: 0 } as any);
    const sell = chart.addSeries(HistogramSeries, { color: down, base: 0 } as any);
    buy.setData(
      bundle.fill_strength.points.map((p) => ({
        // lightweight-charts uses UTCTimestamp (seconds) on the time axis.
        // The `as any` cast keeps us free of the library's branded `Time`
        // type without dragging it into the public API.
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: p.buy_qty,
      })),
    );
    sell.setData(
      bundle.fill_strength.points.map((p) => ({
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: -p.sell_qty, // negative — renders below the 0 baseline
      })),
    );
    return () => {
      chart.removeSeries(buy);
      chart.removeSeries(sell);
    };
  }, [chart, bundle, segments]);
  return null;
}
