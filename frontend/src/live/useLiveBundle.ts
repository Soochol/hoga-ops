import { useMemo } from 'react';
import { useLiveSeries } from '../api/liveSeries';
import { useLivePastCandles } from '../api/livePastCandles';
import {
  useLivePastDailyCandles,
  type LivePastDailyCandlesWarning,
} from '../api/livePastDailyCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import {
  TIMEFRAME_TO_MS,
  type Timeframe,
  type RangeBundle,
  type Candle,
  type DateWarning,
} from '../api/types';
import { buildLiveBundle } from './buildLiveBundle';
import { aggregateCandles, aggregateCalendar } from './aggregateCandles';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  subtractDaysKst,
  INITIAL_HISTORICAL_DAYS,
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

/** Group per-row daily wire warnings (those carrying a `date` field) into
 * `DateWarning[]` so the existing InvariantOutcomesBanner can render them.
 * Batch-level warnings (kis_rate_limit / kis_api_error / etc.) lack a `date`
 * and are skipped here — a follow-up issue tracks surfacing them. */
function dailyWarningsToDateWarnings(
  raw: LivePastDailyCandlesWarning[] | undefined,
): DateWarning[] {
  if (!raw || raw.length === 0) return [];
  const byDate = new Map<string, DateWarning>();
  for (const w of raw) {
    if (!w.date) continue;
    let entry = byDate.get(w.date);
    if (!entry) {
      entry = { date: w.date, warnings: [] };
      byDate.set(w.date, entry);
    }
    entry.warnings.push({
      invariant_id: w.reason,
      severity: 'warn',
      message: w.msg,
      ctx: { batch: w.batch },
    });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
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
): UseLiveBundleResult {
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);

  const live = useLiveSeries(code ?? '');

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // 250-day clamp at the bundle layer so /api/range's 90-day cap and
  // /api/live/past-candles' 250-day cap can stay independent. Applies to
  // the minute path only — the daily endpoint has no equivalent cap.
  const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, INITIAL_HISTORICAL_DAYS);
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

  const dailyDateWarnings = useMemo<DateWarning[]>(
    () => (isMinute ? [] : dailyWarningsToDateWarnings(pastDailyCandlesQuery.data?.data_warnings)),
    [isMinute, pastDailyCandlesQuery.data],
  );

  const bundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;

    const todaySession =
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) };

    const sseOb = isMinute ? (live.ob as unknown as ObSnapshot[]) : [];
    const sseTrade = isMinute ? (live.trade as unknown as TradeSnapshot[]) : [];

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

    // Merge daily wire warnings (with a `date` field) into bundle.data_warnings
    // so InvariantOutcomesBanner surfaces them on D/W/M. buildLiveBundle's own
    // contribution comes from pastBundle (minute path); for D/W/M that's
    // always null, so the daily list stands alone.
    if (dailyDateWarnings.length > 0) {
      return {
        ...built,
        data_warnings: [...(built.data_warnings ?? []), ...dailyDateWarnings],
      };
    }
    return built;
  }, [code, todayKstYyyymmdd, isMinute, live.initial, live.ob, live.trade, past.data, kisCandles, bucketMs, dailyDateWarnings]);

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
