import { useQuery, keepPreviousData } from '@tanstack/react-query';

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
    placeholderData: keepPreviousData,
  });
}
