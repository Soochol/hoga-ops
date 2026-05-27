import type { RangeBundle, RangeSegment, Candle } from '../api/types';
import type { LiveCandle } from '../api/liveCandles';
import {
  bucketHogaSeries,
  type ObSnapshot,
  type TradeSnapshot,
} from './bucketHogaSeries';

export interface BuildLiveBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  /** Past stock-dates fetched via /api/range. null when no fetch has happened
   * yet or the request returned empty. */
  pastBundle: RangeBundle | null;
  sseOb: ObSnapshot[];
  sseTrade: TradeSnapshot[];
  /** Today's candles from useLiveCandles (already client-side aggregated to
   * the display timeframe). */
  todayCandles: LiveCandle[];
  bucketMs: number;
}

/** Spec Section 2 — assemble a merged RangeBundle by stitching the past
 * bundle (from /api/range) and today's live state (SSE buffer + candle hook).
 *
 * Today segment resolution (Section 2 step 1-4):
 *   - If pastBundle.segments includes today → use that (promoted Parquet won;
 *     SSE buffer is intentionally ignored to avoid double-counting).
 *   - Else if SSE buffer + candles have anything → build today segment from
 *     them, tagged source='kis_live'.
 *   - Else → no today segment (chart shows today as empty).
 */
export function buildLiveBundle(input: BuildLiveBundleInput): RangeBundle {
  const {
    code,
    todayDate,
    todaySession,
    pastBundle,
    sseOb,
    sseTrade,
    todayCandles,
    bucketMs,
  } = input;

  const pastSegments = pastBundle?.segments ?? [];
  const pastHasToday = pastSegments.some((s) => s.date === todayDate);

  // ----- Today segment -----
  const todaySegments: RangeSegment[] = [];
  const todayCandlesRow: Candle[] = [];
  // Bucket once; destructure into the two series we feed into the bundle.
  // When past covers today we skip the call entirely (no sort + walk).
  const todayBuckets = pastHasToday
    ? { quoteRatioPoints: [], fillStrengthPoints: [] }
    : bucketHogaSeries(sseOb, sseTrade, bucketMs);
  const todayQuotePoints = todayBuckets.quoteRatioPoints;
  const todayFillPoints = todayBuckets.fillStrengthPoints;

  if (!pastHasToday) {
    const hasAnyData =
      sseOb.length > 0 || sseTrade.length > 0 || todayCandles.length > 0;
    if (hasAnyData) {
      todaySegments.push({
        date: todayDate,
        session_open_ms: todaySession.open_ms,
        session_close_ms: todaySession.close_ms,
        source: 'kis_live',
      });
      for (const c of todayCandles) {
        todayCandlesRow.push({
          ts_ms: c.t_ms,
          open: c.open,
          close: c.close,
          high: c.high,
          low: c.low,
          vol_a: c.volume,
          vol_b: 0,
        });
      }
    }
  }

  // ----- Merge -----
  const pastFromDate = pastBundle?.from_date ?? todayDate;
  const segments = [...pastSegments, ...todaySegments];
  const candles = [...(pastBundle?.candles ?? []), ...todayCandlesRow];
  const quoteRatioPoints = [...(pastBundle?.quote_ratio.points ?? []), ...todayQuotePoints];
  const fillStrengthPoints = [...(pastBundle?.fill_strength.points ?? []), ...todayFillPoints];

  return {
    code,
    from_date: pastFromDate,
    to_date: todayDate,
    bucket_ms: bucketMs,
    segments,
    candles,
    quote_ratio: { bucket_ms: bucketMs, points: quoteRatioPoints },
    fill_strength: { bucket_ms: bucketMs, points: fillStrengthPoints },
    volume_profile_range: {
      bin_count: 0,
      price_min: 0,
      price_max: 0,
      bin_width: 0,
      bins: [],
    },
    volume_profile_by_day: [],
    excluded_dates: pastBundle?.excluded_dates,
    data_warnings: pastBundle?.data_warnings,
  };
}
