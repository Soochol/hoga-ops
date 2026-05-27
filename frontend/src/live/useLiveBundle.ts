import { useMemo } from 'react';
import { useLiveSeries } from '../api/liveSeries';
import { useLiveCandles } from '../api/liveCandles';
import { useRange } from '../api/range';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { TIMEFRAME_TO_MS, type Timeframe, type RangeBundle } from '../api/types';
import { buildLiveBundle } from './buildLiveBundle';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import { yesterdayKst, regularSessionOpenMs, regularSessionCloseMs } from './liveDateTime';

const MINUTE_TIMEFRAMES: ReadonlyArray<Timeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];

function isMinuteTimeframe(tf: LiveTimeframe): tf is Timeframe {
  return (MINUTE_TIMEFRAMES as ReadonlyArray<string>).includes(tf);
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
  // enableRange already requires isMinute, so the timeframe cast is safe.
  const past = useRange(
    enableRange ? code : null,
    enableRange ? historicalFromDate : null,
    enableRange ? pastTo : null,
    enableRange ? (timeframe as Timeframe) : null,
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

