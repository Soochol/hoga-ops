import { useMemo } from 'react';
import { useLiveSeries } from '../api/liveSeries';
import { useLiveCandles } from '../api/liveCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS, type Timeframe, type RangeBundle } from '../api/types';
import { buildLiveBundle } from './buildLiveBundle';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const MINUTE_TIMEFRAMES: ReadonlyArray<Timeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];

function isMinuteTimeframe(tf: LiveTimeframe): tf is Timeframe {
  return (MINUTE_TIMEFRAMES as ReadonlyArray<string>).includes(tf);
}

/** Yesterday in YYYYMMDD KST given today YYYYMMDD KST. */
function yesterdayKst(todayYyyymmdd: string): string {
  const y = parseInt(todayYyyymmdd.slice(0, 4), 10);
  const m = parseInt(todayYyyymmdd.slice(4, 6), 10);
  const d = parseInt(todayYyyymmdd.slice(6, 8), 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export interface UseLiveBundleResult {
  bundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
}

/** Orchestrate live SSE + today candles + past /api/range into a single
 * RangeBundle for LiveChartRoot.
 *
 * - Minute timeframes (1m–30m): full pipeline including past lazy fetch.
 * - D/W/M: SSE-disabled, hoga indicators stay empty (Addendum 9.4).
 */
export function useLiveBundle(
  code: string | null,
  timeframe: LiveTimeframe,
  todayKstYyyymmdd: string,
): UseLiveBundleResult {
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);

  const live = useLiveSeries(code ?? '');
  const { candles: todayCandles } = useLiveCandles(code ?? '', timeframe);

  const isMinute = isMinuteTimeframe(timeframe);
  const bucketMs = isMinute ? TIMEFRAME_TO_MS[timeframe] : 60_000;

  // /api/range — only call when we have a historical range AND timeframe is
  // a minute frame. D/W/M skip past fetch entirely (spec Section 4.2).
  const pastTo = yesterdayKst(todayKstYyyymmdd);
  const enableRange = !!(code && historicalFromDate && isMinute && historicalFromDate <= pastTo);
  const past = useRange(
    enableRange ? code : null,
    enableRange ? historicalFromDate : null,
    enableRange ? pastTo : null,
    enableRange && isMinute ? (timeframe as Timeframe) : null,
  );

  const bundle = useMemo<RangeBundle | null>(() => {
    if (!code) return null;

    const todaySession =
      live.initial != null
        ? { open_ms: live.initial.session_open_ms, close_ms: live.initial.session_close_ms ?? regularSessionCloseMs(todayKstYyyymmdd) }
        : { open_ms: regularSessionOpenMs(todayKstYyyymmdd), close_ms: regularSessionCloseMs(todayKstYyyymmdd) };

    // D/W/M: hoga indicators are intentionally empty per Addendum 9.4.
    const sseOb = isMinute ? (live.ob as unknown as ObSnapshot[]) : [];
    const sseTrade = isMinute ? (live.trade as unknown as TradeSnapshot[]) : [];

    return buildLiveBundle({
      code,
      todayDate: todayKstYyyymmdd,
      todaySession,
      pastBundle: past.data ?? null,
      sseOb,
      sseTrade,
      todayCandles,
      bucketMs,
    });
  }, [code, todayKstYyyymmdd, isMinute, live.initial, live.ob, live.trade, past.data, todayCandles, bucketMs]);

  return {
    bundle,
    isLoading: live.isLoading || past.isLoading,
    error: live.error ?? past.error ?? null,
  };
}

/** Fallback session bounds for today when /api/live/series hasn't responded
 * yet — 09:00 KST open, 15:30 KST close. */
function regularSessionOpenMs(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return Date.UTC(y, m - 1, d, 0, 0, 0);
}

function regularSessionCloseMs(yyyymmdd: string): number {
  return regularSessionOpenMs(yyyymmdd) + 6.5 * 3600 * 1000;
}
