import { useEffect, useMemo, useRef } from 'react';
import type { LiveSeriesData } from '../api/liveSeries';
import { useLivePastCandles } from '../api/livePastCandles';
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';
import { useLivePastInvestorNet } from '../api/livePastInvestorNet';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import {
  TIMEFRAME_TO_MS,
  type Timeframe,
  type RangeBundle,
  type Candle,
  type InvestorNetPoint,
} from '../api/types';
import { buildChartBundle, buildHogaSeries, type HogaSeries } from './buildLiveBundle';
import { aggregateCandles, aggregateCalendar } from './aggregateCandles';
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  subtractDaysKst,
  initialHistoricalDaysFor,
  earliestAllowedMinuteDate,
} from './liveDateTime';

function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}

function kisBarToCandle(b: { t_ms: number; open: number; high: number; low: number; close: number; volume: number }): Candle {
  return {
    ts_ms: b.t_ms,
    open: b.open,
    close: b.close,
    high: b.high,
    low: b.low,
    vol_a: b.volume,
    vol_b: 0,
  };
}

export interface UseLiveBundleResult {
  /** Full bundle = stable chart side + live hoga overlay. Consumed by hoga
   * panes (ratio/quoteTotals/fillStrength), LiveStatusBar, LiveSidebar. New ref
   * on every SSE tick. */
  bundle: RangeBundle | null;
  /** Chart side only (candles + segments + investor), STABLE across SSE ticks.
   * Consumed by the candle/volume panes + axis + candle overlays so a tick
   * doesn't churn the candle path (2026-06-09 bundle-split, Phase A). Shares
   * `bundle`'s segments/candles refs (bundle spreads it). */
  chartBundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** 좌측 팬 한 스텝이 진행 중(placeholderData+isFetching). false-edge = 스텝 settle.
   * LiveChartRoot 진행 루프가 이 falling edge에 반응해 다음 스텝을 dispatch한다. */
  isExtending: boolean;
}

/** Orchestrate live SSE + KIS past-candles + /api/range hoga indicators into a
 * single RangeBundle for LiveChartRoot. ADR-0040 — KIS candles are the single
 * candle source via the dedicated `/api/live/past-candles` endpoint.
 *
 * ADR-0048: D/W/M timeframes route through `/api/live/past-daily-candles`
 * (direct daily backfill) instead of aggregating from 1m bars. Only the minute
 * branch is subject to the 250-day clamp; the daily branch has no clamp.
 */
export function useLiveBundle(
  code: string | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
  live: LiveSeriesData,
): UseLiveBundleResult {
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // 250-day clamp at the bundle layer so /api/range's 90-day cap and
  // /api/live/past-candles' 250-day cap can stay independent. Applies to
  // the minute path only — the daily endpoint has no equivalent cap.
  const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, initialHistoricalDaysFor(timeframe));
  const earliestAllowedMinute = earliestAllowedMinuteDate(todayKstYyyymmdd);
  const minutePastFrom = laterDate(seedFrom, earliestAllowedMinute);
  // Includes today so post-promote disk data (hogaplay/snapshots.parquet,
  // ADR-0037 v2 layout) feeds today's hoga indicators. Before this, today's
  // quote_ratio/fill_strength came only from the in-memory SSE buffer, which
  // is volatile across backend restarts. buildLiveBundle's pastHasTodaySegment
  // check + the t > pastMaxQrT incremental filter already handle the dedup
  // with the SSE tail (buildLiveBundle.ts:67, 72).
  const minutePastTo = todayKstYyyymmdd;

  // Minute-only gate: both /api/range (hoga indicators) and
  // /api/live/past-candles fire on the same condition.
  const enableMinute = !!(code && isMinute && minutePastFrom <= minutePastTo);
  const past = useRange(
    enableMinute ? code : null,
    enableMinute ? minutePastFrom : null,
    enableMinute ? minutePastTo : null,
    enableMinute ? (timeframe as Timeframe) : null,
    undefined,
    // /live's minutePastTo is always today (line 83), so this enables the
    // 5-min refetch that advances pastMaxQrT (review C1 — seam hole). The gate
    // lives in rangeFreshnessOptions: past-only callers (no todayKst) stay
    // frozen. A periodic refetch keeps the same query key → no placeholderData
    // swap → does not set isExtending, so today's right edge is untouched.
    todayKstYyyymmdd,
  );
  const pastCandlesQuery = useLivePastCandles(
    enableMinute ? code : null,
    enableMinute ? minutePastFrom : null,
    enableMinute ? minutePastTo : null,
  );

  // KIS daily past-candles — only enabled for D/W/M timeframes (ADR-0048).
  const enableDaily = !!(code && !isMinute);
  const dailyPastFrom = seedFrom;
  const dailyPastTo = todayKstYyyymmdd;
  const pastDailyCandlesQuery = useLivePastDailyCandles(
    enableDaily ? code : null,
    enableDaily ? dailyPastFrom : null,
    enableDaily ? dailyPastTo : null,
  );

  // Investor net-buy (foreign/institution) — 'D' (일봉) ONLY. KIS
  // investor-trade-by-stock-daily (FHPTJ04160001) walks back the requested
  // [from, to] range by date cursor. ADR-0055.
  // Why daily-only, not all calendar frames: investor points are daily-anchored
  // (09:00 KST), but W/M aggregate candles into week/month segments, so most
  // daily points would fall outside axis.contains and render a near-empty pane.
  // Kept out of isLoading/error: it's an optional overlay, so a missing or
  // failed investor fetch must not block the candle chart from rendering.
  const enableInvestor = !!(code && timeframe === 'D');
  const investorQuery = useLivePastInvestorNet(
    enableInvestor ? code : null,
    enableInvestor ? dailyPastFrom : null,
    enableInvestor ? dailyPastTo : null,
  );
  const investorPoints = useMemo<InvestorNetPoint[]>(
    () => (enableInvestor ? investorQuery.data?.points ?? [] : []),
    [enableInvestor, investorQuery.data],
  );

  const kisCandles = useMemo<Candle[]>(() => {
    if (isMinute) {
      const raw = pastCandlesQuery.data?.candles ?? [];
      if (raw.length === 0) return [];
      // Minute timeframes: epoch-floor bucket via aggregateCandles (also dedupes
      // within-bucket duplicates from pre-f63ed15 KIS cache files).
      const bars = aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000);
      return bars.map(kisBarToCandle);
    }
    // D/W/M: bars come from the daily endpoint. For 'D' the call is
    // identity-ish (one bucket per bar); for 'W'/'M' aggregateCalendar groups
    // by ISO week / calendar month using the bar's first 1m bar t_ms so
    // axis.contains admits it inside that Segment.
    const raw = pastDailyCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return [];
    const bars = timeframe === 'D' ? raw : aggregateCalendar(raw, timeframe as 'W' | 'M');
    return bars.map(kisBarToCandle);
  }, [isMinute, timeframe, pastCandlesQuery.data, pastDailyCandlesQuery.data]);

  // Session bounds — shared by both bundle halves. Depends only on live.initial
  // (stable across SSE ticks), so it never drives a tick-time rebuild.
  const todaySession = useMemo(
    () =>
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) },
    [live.initial, todayKstYyyymmdd],
  );

  // CHART side (candles + segments + investor). Deps deliberately EXCLUDE the
  // ob/trade arrays — the only today-signal input is the `hasTodayObSignal`
  // boolean, which flips false→true once on the first push and then stays put.
  // So an SSE tick (new live.ob ref, same length>0) does NOT re-run this memo →
  // `chartBundle` ref stays STABLE across ticks → the candle/volume panes + axis
  // never re-setData on a tick (2026-06-09 bundle-split design, Phase A).
  const hasTodayObSignal = isMinute && live.ob.length > 0;
  // Last content-distinct segments array — see the stabilization block below.
  const prevSegmentsRef = useRef<RangeBundle['segments'] | null>(null);
  const computedChartBundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;
    const built = buildChartBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession,
      pastBundle: past.data ?? null,
      kisCandles,
      bucketMs,
      hasTodayObSignal,
      investorPoints,
    });

    // Segments-identity stabilization (eng review C1): buildChartBundle allocates
    // a fresh `segments` array each call even when no trading date changed.
    // LiveChartRoot memoises the VirtualAxis on this array's REFERENCE and the
    // KST behavior's `cacheKey` bumps its label-cache generation on axis
    // identity — so reuse the previous array when content-equal; it only changes
    // identity on a genuine mapping change (new date appended / leftward-pan
    // prepend).
    const prev = prevSegmentsRef.current;
    const sameSegments =
      prev !== null &&
      prev.length === built.segments.length &&
      built.segments.every(
        (s, i) =>
          s.date === prev[i].date &&
          s.session_open_ms === prev[i].session_open_ms &&
          s.session_close_ms === prev[i].session_close_ms,
      );
    if (sameSegments) {
      built.segments = prev;
    } else {
      prevSegmentsRef.current = built.segments;
    }

    return built;
  }, [code, todayKstYyyymmdd, todaySession, past.data, kisCandles, bucketMs, hasTodayObSignal, investorPoints]);

  // HOGA side (quote_ratio / fill_strength). Deps INCLUDE ob/trade — this is the
  // ONLY half that rebuilds on an SSE tick.
  const hogaSeries = useMemo<HogaSeries>(
    () =>
      buildHogaSeries({
        todaySession,
        pastBundle: past.data ?? null,
        sseOb: isMinute ? live.ob : [],
        sseTrade: isMinute ? live.trade : [],
        bucketMs,
      }),
    [todaySession, past.data, isMinute, live.ob, live.trade, bucketMs],
  );

  // Atomize the historical-prepend across the two independent past sources.
  // A leftward pan changes `historicalFromDate`, which re-keys BOTH past
  // queries (candles via /api/live/past-candles, hoga via /api/range). They
  // resolve in SEPARATE commits, so without gating the bundle would rebuild
  // twice — once with new candles + stale hoga, then with both — landing the
  // prepend in two paints. That splits LiveChartRoot's viewport shift across two
  // commits (a visible ~60ms jump-then-correct flicker) and makes the first
  // shift see a candles-only union (wrong inserted-index count). All three
  // queries keep the previous response as `placeholderData` during a same-code
  // re-key, so `isPlaceholderData` is true for exactly the window where one
  // source has the new range and the other does not. Hold the last fully-settled
  // bundle until BOTH are fresh, so the prepend swaps in ONE commit. SSE-only
  // and periodic-refetch updates do NOT set isPlaceholderData, so today's live
  // ticks are not gated.
  // Atomize ONLY a genuine historical extension (a leftward pan), keyed on
  // historicalFromDate != null. A pan re-keys BOTH past queries (candles via
  // /api/live/past-candles, hoga via /api/range), which resolve in SEPARATE
  // commits; without gating, the bundle rebuilds twice (new candles + stale
  // hoga, then both), splitting LiveChartRoot's viewport shift across two paints
  // and feeding the first shift a candles-only union (wrong inserted-index
  // count). Hold the last fully-settled bundle until BOTH sources are fresh so
  // the prepend swaps in ONE commit.
  //
  // The historicalFromDate gate is what scopes this to extensions: setActiveCode
  // and setCandleTimeframe reset it to null, so a code OR timeframe switch — both
  // of which ALSO re-key the past queries (useRange embeds bucketMs;
  // useLivePastCandles' from embeds initialHistoricalDaysFor(timeframe)) — is NOT
  // gated and falls straight through to computedBundle, instead of stalling on
  // the previous code/timeframe's bundle. SSE / periodic refetches never set
  // isPlaceholderData, so today's live ticks are not gated either.
  //
  // `&& isFetching` releases the hold if a re-keyed query goes
  // pending-but-NOT-fetching (paused/offline, or `enabled` flipped mid-flight),
  // which would otherwise freeze the bundle with no fetch in flight; a settled
  // error drops isPlaceholderData on its own (status leaves 'pending'). The hold
  // lasts as long as the slower past-fetch (bounded by the global retry:1),
  // pausing today's right edge — acceptable because the user is panned into
  // history, not watching the live edge.
  const extending = historicalFromDate != null && (isMinute
    ? (past.isPlaceholderData && past.isFetching) ||
      (pastCandlesQuery.isPlaceholderData && pastCandlesQuery.isFetching)
    : pastDailyCandlesQuery.isPlaceholderData && pastDailyCandlesQuery.isFetching);
  // The gate holds the CHART side (candle/segment prepend atomicity is what it
  // protects — the viewport shift is candle-index-based). The hoga overlay
  // follows via the spread below; its points don't drive the viewport, so
  // letting them settle a beat later than the held chart is harmless.
  const lastSettledChartRef = useRef<RangeBundle | null>(null);
  const chartBundle = extending && lastSettledChartRef.current
    ? lastSettledChartRef.current
    : computedChartBundle;
  useEffect(() => {
    if (!extending) lastSettledChartRef.current = computedChartBundle;
  }, [extending, computedChartBundle]);

  // Full bundle = stable chart side + live hoga overlay. Spreading chartBundle
  // shares its segments/candles refs, so the VirtualAxis stays single-build and
  // hoga panes (which read bundle.segments / bundle.bucket_ms in fillStrength)
  // see the same coordinate system as the candle path.
  const bundle = useMemo<RangeBundle | null>(
    () =>
      chartBundle
        ? { ...chartBundle, quote_ratio: hogaSeries.quote_ratio, fill_strength: hogaSeries.fill_strength }
        : null,
    [chartBundle, hogaSeries],
  );

  // Clamp is a minute-path concern only; the daily endpoint has no 250d cap.
  const clampEngaged = isMinute
    && historicalFromDate != null
    && historicalFromDate <= earliestAllowedMinute;

  return {
    bundle,
    chartBundle,
    isLoading: live.isLoading || past.isLoading || pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
    error: live.error ?? past.error ?? pastCandlesQuery.error ?? pastDailyCandlesQuery.error ?? null,
    clampEngaged,
    isPastCandlesLoading: pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
    isExtending: extending,
  };
}
