import { type LivePastDailyCandle, fetchPastDailyCandles } from '../api/livePastDailyCandles';
import { type LiveTimeframe } from '../state/livePage';
import { initialHistoricalDaysFor } from './liveDateTime';
import { useAccumulatedDailyRange } from './useAccumulatedDailyRange';

export interface DailyCandlesResult {
  /** Accumulated immutable history + the live today bar, deduped, sorted asc.
   * Timeframe-independent raw daily bars (W/M aggregate downstream). */
  candles: LivePastDailyCandle[];
  isLoading: boolean;
  /** Mirrored to useLiveBundle.isExtending so the settle-loop fires its next step. */
  isExtending: boolean;
  error: unknown;
}

// Stable (module-level) so the accumulator's merge useMemo deps don't churn.
const candleSlice = (code: string, from: string, to: string) =>
  fetchPastDailyCandles(code, from, to).then((r) => r.candles);
const candleMs = (c: LivePastDailyCandle) => c.t_ms;

/** Daily-candle source for /live's D/W/M charts. Thin wrapper over
 * `useAccumulatedDailyRange` (incremental immutable history + live today bar);
 * see that hook for the O(K) accumulation rationale. Keyed per (code, timeframe)
 * so each frame keeps its own seed window. */
export function useDailyCandlesAccumulated(
  code: string | null,
  timeframe: LiveTimeframe,
  today: string,
  historicalFromDate: string | null,
  enabled: boolean,
): DailyCandlesResult {
  const r = useAccumulatedDailyRange<LivePastDailyCandle>({
    code,
    baseKey: ['live', 'daily-candles', code, timeframe],
    seedCalendarDays: initialHistoricalDaysFor(timeframe),
    today,
    historicalFromDate,
    enabled,
    fetchSlice: candleSlice,
    getMs: candleMs,
  });
  return { candles: r.items, isLoading: r.isLoading, isExtending: r.isExtending, error: r.error };
}
