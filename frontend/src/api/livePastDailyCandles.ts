import { useQuery } from '@tanstack/react-query';

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

export function useLivePastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-daily-candles', code, from, to] as const,
    queryFn: () =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    // See livePastCandles.ts for the rationale — code-aware placeholder
    // prevents the previous code's candle count from leaking into
    // LiveChartRoot's initial-view effect on watchlist switches.
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
