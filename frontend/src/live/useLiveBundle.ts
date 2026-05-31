import { useEffect, useMemo, useRef } from 'react';
import type { LiveSeriesData } from '../api/liveSeries';
import { useLivePastCandles } from '../api/livePastCandles';
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import {
  TIMEFRAME_TO_MS,
  type Timeframe,
  type RangeBundle,
  type Candle,
} from '../api/types';
import { buildLiveBundle } from './buildLiveBundle';
import { aggregateCandles, aggregateCalendar } from './aggregateCandles';
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  subtractDaysKst,
  initialHistoricalDaysFor,
} from './liveDateTime';

const PAST_CANDLES_MAX_DAYS = 250;

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
  bundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
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
  const earliestAllowedMinute = subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);
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

  const computedBundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;

    const todaySession =
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) };

    const sseOb = isMinute ? live.ob : [];
    const sseTrade = isMinute ? live.trade : [];

    const built = buildLiveBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession,
      pastBundle: past.data ?? null,
      sseOb,
      sseTrade,
      kisCandles,
      bucketMs,
    });

    return built;
  }, [code, todayKstYyyymmdd, isMinute, live.initial, live.ob, live.trade, past.data, kisCandles, bucketMs]);

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
  const lastSettledBundleRef = useRef<RangeBundle | null>(null);
  const bundle = extending && lastSettledBundleRef.current
    ? lastSettledBundleRef.current
    : computedBundle;
  useEffect(() => {
    if (!extending) lastSettledBundleRef.current = computedBundle;
  }, [extending, computedBundle]);

  // Clamp is a minute-path concern only; the daily endpoint has no 250d cap.
  const clampEngaged = isMinute
    && historicalFromDate != null
    && historicalFromDate < earliestAllowedMinute;

  return {
    bundle,
    isLoading: live.isLoading || past.isLoading || pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
    error: live.error ?? past.error ?? pastCandlesQuery.error ?? pastDailyCandlesQuery.error ?? null,
    clampEngaged,
    isPastCandlesLoading: pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
  };
}
