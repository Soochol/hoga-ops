import type { RangeBundle, RangeSegment, Candle, VolumeProfile } from '../api/types';
import {
  bucketHogaSeries,
  type ObSnapshot,
  type TradeSnapshot,
} from './bucketHogaSeries';

/** /live never mounts VolumeProfileOverlay; the bundle ships an empty profile
 * that satisfies the RangeBundle type without claiming any data. */
const EMPTY_VOLUME_PROFILE: VolumeProfile = {
  bin_count: 0,
  price_min: 0,
  price_max: 0,
  bin_width: 0,
  bins: [],
};

export interface BuildLiveBundleInput {
  code: string;
  todayDate: string;
  todaySession: { open_ms: number; close_ms: number };
  /** Past stock-dates fetched via /api/range. Used for hoga indicators
   * (quote_ratio, fill_strength), segments, and excluded_dates only —
   * `pastBundle.candles` is intentionally ignored. */
  pastBundle: RangeBundle | null;
  sseOb: ObSnapshot[];
  sseTrade: TradeSnapshot[];
  /** Candles from /api/live/past-candles (KIS dailychartprice), already
   * client-side aggregated to the display timeframe and converted to wire
   * Candle shape. Single source of truth for the bundle's candle array
   * (ADR-0040 — Live Candle Backfill). */
  kisCandles: Candle[];
  bucketMs: number;
}

export function buildLiveBundle(input: BuildLiveBundleInput): RangeBundle {
  const {
    code,
    todayDate,
    todaySession,
    pastBundle,
    sseOb,
    sseTrade,
    kisCandles,
    bucketMs,
  } = input;

  const pastSegments = pastBundle?.segments ?? [];
  const pastHasToday = pastSegments.some((s) => s.date === todayDate);

  // Today hoga indicators from SSE buffer. When promoted past covers today
  // we skip the SSE bucket to avoid double-counting.
  const todayBuckets = pastHasToday
    ? { quoteRatioPoints: [], fillStrengthPoints: [] }
    : bucketHogaSeries(sseOb, sseTrade, bucketMs);

  // Today segment marker — present if we have any signal for today.
  const todaySegments: RangeSegment[] = [];
  if (!pastHasToday) {
    const hasToday =
      sseOb.length > 0 ||
      sseTrade.length > 0 ||
      kisCandles.some((c) => c.ts_ms >= todaySession.open_ms);
    if (hasToday) {
      todaySegments.push({
        date: todayDate,
        session_open_ms: todaySession.open_ms,
        session_close_ms: todaySession.close_ms,
        source: 'kis_live',
      });
    }
  }

  const pastFromDate = pastBundle?.from_date ?? todayDate;
  const segments = [...pastSegments, ...todaySegments];

  return {
    code,
    from_date: pastFromDate,
    to_date: todayDate,
    bucket_ms: bucketMs,
    segments,
    candles: kisCandles,
    quote_ratio: {
      bucket_ms: bucketMs,
      points: [...(pastBundle?.quote_ratio.points ?? []), ...todayBuckets.quoteRatioPoints],
    },
    fill_strength: {
      bucket_ms: bucketMs,
      points: [...(pastBundle?.fill_strength.points ?? []), ...todayBuckets.fillStrengthPoints],
    },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    excluded_dates: pastBundle?.excluded_dates,
    data_warnings: pastBundle?.data_warnings,
  };
}
