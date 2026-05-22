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
 * VolumePane — mounts a HistogramSeries onto the shared chart instance and
 * paints per-candle total volume (vol_a + vol_b) tinted by candle direction:
 * green for up candles (close ≥ open), red for down candles.
 *
 * The pane does not render any DOM — it only acts as a controller for the
 * series lifecycle (add on mount, remove on unmount). Multi-day x-axis
 * stitching is handled by mapping each candle's real Unix-ms timestamp
 * through `realToVirtual(segments, …)`.
 */
export default function VolumePane({ chart, bundle, segments, paneIndex = 0 }: Props) {
  useEffect(() => {
    const { up, down } = resolveTokens(TOKEN_SPEC);
    const series = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'volume' },
        priceScaleId: 'right',
      },
      paneIndex,
    );
    const data = bundle.candles
      .filter((c) => isWithinSessions(segments, c.ts_ms))
      .map((c) => ({
        // lightweight-charts uses UTCTimestamp (seconds) on the time axis.
        // The `as any` cast keeps us free of the library's branded `Time`
        // type without dragging it into the public API.
        time: (realToVirtual(segments, c.ts_ms) / 1000) as any,
        value: c.vol_a + c.vol_b,
        color: c.close >= c.open ? up : down,
      }));
    series.setData(data);
    return () => {
      // Guard: see CandlePane.tsx for the unwind-order rationale.
      try {
        chart.removeSeries(series);
      } catch {
        // chart already torn down
      }
    };
  }, [chart, bundle, segments, paneIndex]);
  return null;
}
