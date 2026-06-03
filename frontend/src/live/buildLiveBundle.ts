import type { RangeBundle, RangeSegment, Candle, VolumeProfile } from '../api/types';
import {
  bucketHogaSeries,
  type ObSnapshot,
  type TradeSnapshot,
} from './bucketHogaSeries';
import {
  realMsToYyyymmdd,
  regularSessionOpenMs,
  regularSessionCloseMs,
} from './liveDateTime';
import { AUCTION_WINDOW_LENGTH_MS } from '../util/sessionTime';

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
   * (quote_ratio, fill_strength) and segments only —
   * `pastBundle.candles` is intentionally ignored. */
  pastBundle: RangeBundle | null;
  sseOb: readonly ObSnapshot[];
  sseTrade: readonly TradeSnapshot[];
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
  const pastQRPoints = pastBundle?.quote_ratio.points ?? [];
  const pastFSPoints = pastBundle?.fill_strength.points ?? [];

  // ADR-0049 / spec §3 — filter (not clip) past points whose t escapes
  // the Live Session end so a backend encoding regression cannot block SSE
  // merge. Why filter not Math.min: clipping leaves pastMaxQrT at
  // close+30min, strictly greater than every SSE timestamp during the
  // session, so `incrementalQR.filter(p => p.t > pastMaxQrT)` would reject
  // ALL SSE points. Filter drops corrupt past entries from pastMax calc
  // AND from the wire output, so SSE merges naturally and renders stay
  // consistent with VirtualAxis (which filters out-of-segment points
  // anyway). Ceiling = close_ms + 30min (Live Session end incl. After-Hours
  // Trading, ADR-0044 / CONTEXT.md "Live Session"). Healthy past always
  // passes — no-op for normal bundles.
  const AFTER_HOURS_END_MS = todaySession.close_ms + 30 * 60 * 1000;
  const validPastQR = pastQRPoints.filter((p) => p.t <= AFTER_HOURS_END_MS);
  const validPastFS = pastFSPoints.filter((p) => p.t <= AFTER_HOURS_END_MS);
  const pastMaxQrT = validPastQR.length > 0
    ? validPastQR[validPastQR.length - 1].t
    : 0;
  const pastMaxFsT = validPastFS.length > 0
    ? validPastFS[validPastFS.length - 1].t
    : 0;

  // Today's straddle bucket (3m/15m/30m) must not pull the 15:20+ closing-
  // auction book into its 호가비·총잔량 value. session bound is today's
  // close − 10min. (Known limitation: today's close_ms falls back to 15:30 on
  // half-days — see the 2026-06-03 spec Risks; backend handles past dates.)
  const auctionStartMs = todaySession.close_ms - AUCTION_WINDOW_LENGTH_MS;
  const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs, auctionStartMs);
  const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
  const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);

  // Today segment marker — present if we have any signal for today.
  const todaySegments: RangeSegment[] = [];
  const pastHasTodaySegment = pastSegments.some((s) => s.date === todayDate);
  if (!pastHasTodaySegment) {
    const hasTodaySignal =
      pastQRPoints.some((p) => realMsToYyyymmdd(p.t) === todayDate) ||
      incrementalQR.length > 0 ||
      sseOb.length > 0 ||
      kisCandles.some((c) => c.ts_ms >= todaySession.open_ms);
    if (hasTodaySignal) {
      todaySegments.push({
        date: todayDate,
        session_open_ms: todaySession.open_ms,
        session_close_ms: todaySession.close_ms,
        source: 'kis_live',
      });
    }
  }

  // Synthesize segments for past dates that KIS has candles for but /api/range
  // doesn't cover (e.g., hogaplay never captured that date). Without this, the
  // VirtualAxis built from segments alone wouldn't `contain` those candles and
  // the candle/volume projectors would filter them out — bug surfaced by
  // /investigate 2026-05-28 (ADR-0040 intent is KIS candle independence from
  // hogaplay coverage; we honor it by extending segments, not by skipping the
  // filter). Today and past-covered dates are already handled above; here we
  // fill the gap of "past dates with KIS candles but no hoga segment".
  const knownDates = new Set([
    ...pastSegments.map((s) => s.date),
    ...todaySegments.map((s) => s.date),
  ]);
  const kisOnlyDates = new Set<string>();
  for (const c of kisCandles) {
    const d = realMsToYyyymmdd(c.ts_ms);
    if (!knownDates.has(d)) kisOnlyDates.add(d);
  }
  const kisOnlySegments: RangeSegment[] = Array.from(kisOnlyDates)
    .sort()
    .map((d) => ({
      date: d,
      session_open_ms: regularSessionOpenMs(d),
      session_close_ms: regularSessionCloseMs(d),
      source: 'kis_live',
    }));

  const pastFromDate = pastBundle?.from_date ?? todayDate;
  // Order matters for the VirtualAxis (date-ascending). pastSegments are
  // already sorted; kisOnlySegments are sorted; todaySegments is the
  // single today entry which is strictly the latest.
  const allPastLike = [...pastSegments, ...kisOnlySegments].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const segments = [...allPastLike, ...todaySegments];

  return {
    code,
    from_date: pastFromDate,
    to_date: todayDate,
    bucket_ms: bucketMs,
    segments,
    candles: kisCandles,
    quote_ratio: {
      bucket_ms: bucketMs,
      points: [...validPastQR, ...incrementalQR],
    },
    fill_strength: {
      bucket_ms: bucketMs,
      points: [...validPastFS, ...incrementalFS],
    },
    volume_profile_range: EMPTY_VOLUME_PROFILE,
    volume_profile_by_day: [],
    // Investor net-buy is fetched separately and merged by useLiveBundle; this
    // builder never sees it, so default to empty and let the caller override.
    investorPoints: [],
  };
}
