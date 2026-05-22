import { useEffect } from 'react';
import { CandlestickSeries, type IChartApi } from 'lightweight-charts';
import type { SessionBundle } from '../api/types';
import {
  type Segment,
  findSegmentByReal,
  isWithinSessions,
  realToVirtual,
} from '../util/time';
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
 * paints the Regular Session's OHLC bars. Candles inside the closing
 * Auction Window or After-Hours Trading (≥ session_open + 6h 20m, i.e. KST
 * 15:20 onward) are rendered muted so the continuous-trading structure
 * stays visually dominant.
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
        // KRX equities are integer-won. Use a custom formatter so the price
        // axis renders "25,600" (with a thousands separator) instead of the
        // built-in "25.6k" abbreviation that lightweight-charts falls back to
        // at higher magnitudes. minMove=1 keeps the price grid stepping on
        // whole-won increments (the smallest KRX tick).
        priceFormat: {
          type: 'custom',
          formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
          minMove: 1,
        },
      },
      paneIndex,
    );
    // Auction Window / After-Hours Trading threshold (PER SEGMENT — ADR-0013):
    // the Regular Session closes at 15:30 KST and the closing Auction Window
    // runs 15:20–15:30 (CONTEXT.md). For each candle, find its owning segment
    // and compute the threshold as that segment's session_open_ms + (6h 20m)
    // so candles inside the closing Auction Window or After-Hours Trading
    // render muted (continuous-trading candles inside the Regular Session keep
    // their up/down color). The previous single-day formula (bundle.session_open_ms
    // + 6h20m) over-muted every day after the first when N>1.
    const AUCTION_WINDOW_OFFSET_MS = (6 * 3600 + 20 * 60) * 1000;
    // Drop pre-open auction candles (8:30-9:00 KST) and any other points that
    // fall outside the regular-session segments — they would all collapse to
    // virtual-time=0 and lightweight-charts.setData would throw "asc ordered
    // by time" on the duplicate. See util/time.ts:isWithinSessions docs.
    const data = bundle.candles
      .filter((c) => isWithinSessions(segments, c.ts_ms))
      .map((c) => {
        const segIdx = findSegmentByReal(segments, c.ts_ms);
        const seg = segments[segIdx];
        const threshold = seg.sessionOpenMs + AUCTION_WINDOW_OFFSET_MS;
        const inAuctionOrAfter = c.ts_ms >= threshold;
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
      // Guard: when a sibling pane throws and ChartErrorBoundary unmounts
      // ChartStage, the parent's chart.remove() may run before this cleanup,
      // leaving the series handle dangling. lightweight-charts then throws
      // "Value is undefined" inside removeSeries. Matches IntensityPane.
      try {
        chart.removeSeries(series);
      } catch {
        // chart already torn down
      }
    };
  }, [chart, bundle, segments, paneIndex]);
  return null;
}
