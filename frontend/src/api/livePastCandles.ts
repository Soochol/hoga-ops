import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';

export interface LivePastCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LivePastCandlesWarning {
  date: string;
  reason: string;
  msg: string;
}

export interface LivePastCandlesResponse {
  code: string;
  from: string;
  to: string;
  candles: LivePastCandle[];
  cached_dates: string[];
  fresh_dates: string[];
  data_warnings: LivePastCandlesWarning[];
}

export function useLivePastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-candles', code, from, to] as const,
    queryFn: () =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    // Code-aware placeholder: keep previous data only when the code matches.
    // Same-code refetches (lazy from/to extension, refetchInterval) keep the
    // previous render to avoid blanking. Code switches drop the placeholder
    // so the bundle reports candles.length===0 until fresh data arrives —
    // without this, LiveChartRoot's initial-view effect runs against the
    // PREVIOUS code's candle count and locks setVisibleLogicalRange with a
    // stale right edge, pushing the new code's latest candle off-screen.
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
