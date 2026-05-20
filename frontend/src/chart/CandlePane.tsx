import { useEffect } from 'react';
import { CandlestickSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import { type Segment, realToVirtual } from '../util/time';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = {
  up: ['--up', '#22C55E'],
  down: ['--down', '#F43F5E'],
  muted: ['--fg-dim', '#94A3B8'],
} as const;

type Props = {
  chart: IChartApi;
  bundle: SessionBundle;
  segments: Segment[];
  /** Pane index for multi-pane split. Defaults to 0 (top pane). */
  paneIndex?: number;
};

/**
 * CandlePane — mounts a CandlestickSeries onto the shared chart instance and
 * paints the session's OHLC bars. Candles in the auction / after-hours window
 * (≥ session_open + 6h 20m, i.e. KST 15:20 onward) are rendered muted so the
 * regular-session structure stays visually dominant.
 *
 * The pane does not render any DOM — it only acts as a controller for the
 * series lifecycle (add on mount, remove on unmount). Multi-day x-axis
 * stitching is handled by mapping each candle's real Unix-ms timestamp
 * through `realToVirtual(segments, …)`.
 */
export default function CandlePane({ chart, bundle, segments, paneIndex = 0 }: Props) {
  useEffect(() => {
    const { up, down, muted } = resolveTokens(TOKEN_SPEC);
    const series = chart.addSeries(
      CandlestickSeries,
      {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
      },
      paneIndex,
    );
    // After-hours / auction-window threshold: regular session_close is at
    // 15:30 KST. Spec §1 defines after-hours / auction-window as anything
    // after 15:20 (auction starts at 15:20). Compute the threshold as
    // session_open_ms + (6h 20m) so auction + after-hours candles render muted.
    const auctionThresholdMs = bundle.session_open_ms + (6 * 3600 + 20 * 60) * 1000;
    const data = bundle.candles.map((c) => {
      const inAuctionOrAfter = c.ts_ms >= auctionThresholdMs;
      const color = inAuctionOrAfter ? muted : c.close >= c.open ? up : down;
      return {
        // lightweight-charts uses UTCTimestamp (seconds) on the time axis.
        // The `as any` cast keeps us free of the library's branded `Time`
        // type without dragging it into the public API.
        time: (realToVirtual(segments, c.ts_ms) / 1000) as any,
        open: c.open,
        close: c.close,
        high: c.high,
        low: c.low,
        color,
        borderColor: color,
        wickColor: color,
      };
    });
    series.setData(data);
    return () => {
      chart.removeSeries(series);
    };
  }, [chart, bundle, segments, paneIndex]);
  return null;
}
