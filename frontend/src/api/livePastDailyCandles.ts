import { apiCall } from './client';

export interface LivePastDailyCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LivePastDailyCandlesWarning {
  batch: string;
  /** Present when the warning is per-row (e.g. invariant_violation); absent on
   * batch-level failures like kis_rate_limit / kis_api_error. */
  date?: string;
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation';
  msg: string;
}

export interface LivePastDailyCandlesResponse {
  code: string;
  from: string;
  to: string;
  candles: LivePastDailyCandle[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastDailyCandlesWarning[];
}

/** Fetch a single [from, to] daily-candle slice from the KIS-backed endpoint
 * (ADR-0048). This is the dumb wire call — the accumulation/today-split policy
 * lives in `useDailyCandlesAccumulated` (live layer) so this stays free of any
 * date math or React state. `from`/`to` are YYYYMMDD KST, inclusive. */
export function fetchPastDailyCandles(
  code: string,
  from: string,
  to: string,
): Promise<LivePastDailyCandlesResponse> {
  return apiCall<LivePastDailyCandlesResponse>(
    `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}`,
  );
}
