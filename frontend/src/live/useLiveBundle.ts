import { useMemo } from 'react';
import { useLiveSeries } from '../api/liveSeries';
import { useLivePastCandles } from '../api/livePastCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS, type Timeframe, type RangeBundle, type Candle } from '../api/types';
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
  // /api/live/past-candles' 250-day cap can stay independent.
  const seedFrom = historicalFromDate ?? subtractDaysKst(todayKstYyyymmdd, INITIAL_HISTORICAL_DAYS);
  const earliestAllowed = subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);
  const pastFrom = laterDate(seedFrom, earliestAllowed);
  // Includes today so post-promote disk data (hogaplay/snapshots.parquet,
  // ADR-0037 v2 layout) feeds today's hoga indicators. Before this, today's
  // quote_ratio/fill_strength came only from the in-memory SSE buffer, which
  // is volatile across backend restarts. buildLiveBundle's pastHasTodaySegment
  // check + the t > pastMaxQrT incremental filter already handle the dedup
  // with the SSE tail (buildLiveBundle.ts:67, 72).
  const pastTo = todayKstYyyymmdd;

  const enableRange = !!(code && isMinute && pastFrom <= pastTo);
  const past = useRange(
    enableRange ? code : null,
    enableRange ? pastFrom : null,
    enableRange ? pastTo : null,
    enableRange ? (timeframe as Timeframe) : null,
  );

  // KIS past-candles: range is [pastFrom, today] (today included, ADR-0040).
  // Enabled for ALL timeframes — D/W/M client-aggregate from the same 1m KIS
  // bars (no backend D/W/M endpoint exists post-4b99191).
  const pastCandlesEnabled = !!code;
  const pastCandlesQuery = useLivePastCandles(
    pastCandlesEnabled ? code : null,
    pastCandlesEnabled ? pastFrom : null,
    pastCandlesEnabled ? todayKstYyyymmdd : null,
  );

  const kisCandles = useMemo<Candle[]>(() => {
    const raw = pastCandlesQuery.data?.candles ?? [];
    if (raw.length === 0) return [];
    // Minute timeframes: epoch-floor bucket via aggregateCandles (also dedupes
    // within-bucket duplicates from pre-f63ed15 KIS cache files).
    // D/W/M: calendar-aligned bucket via aggregateCalendar — the result's t_ms
    // is the bucket's first 1m bar (= sessionOpenMs of the bucket's first
    // trading day) so axis.contains admits it inside that Segment.
    const bars = isMinute
      ? aggregateCandles(raw, TIMEFRAME_TO_MS[timeframe as Timeframe] / 1000)
      : aggregateCalendar(raw, timeframe as 'D' | 'W' | 'M');
    return bars.map(kisBarToCandle);
  }, [pastCandlesQuery.data, isMinute, timeframe]);

  const bundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;

    const todaySession =
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) };

    const sseOb = isMinute ? (live.ob as unknown as ObSnapshot[]) : [];
    const sseTrade = isMinute ? (live.trade as unknown as TradeSnapshot[]) : [];

    return buildLiveBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession,
      pastBundle: past.data ?? null,
      sseOb,
      sseTrade,
      kisCandles,
      bucketMs,
    });
  }, [code, todayKstYyyymmdd, isMinute, live.initial, live.ob, live.trade, past.data, kisCandles, bucketMs]);

  const clampEngaged = historicalFromDate != null && historicalFromDate < earliestAllowed;

  return {
    bundle,
    isLoading: live.isLoading || past.isLoading || pastCandlesQuery.isLoading,
    error: live.error ?? past.error ?? pastCandlesQuery.error ?? null,
    clampEngaged,
    isPastCandlesLoading: pastCandlesQuery.isLoading,
  };
}
