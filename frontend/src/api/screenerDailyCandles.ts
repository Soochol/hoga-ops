import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import { apiCall } from './client';

export interface ScreenerDailyCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScreenerDailyCandlesResponse {
  code: string;
  from: string;
  to: string;
  source: 'screener_daily';
  candles: ScreenerDailyCandle[];
  data_warnings: Array<{ batch: string; reason: string; msg: string }>;
}

export type ScreenerDailyCandlesQueryKey = readonly [
  'live',
  'screener-daily-candles',
  string | null,
  string | null,
  string | null,
];

export function screenerDailyCandlesQueryOptions(
  code: string | null,
  from: string | null,
  to: string | null,
): UseQueryOptions<
  ScreenerDailyCandlesResponse,
  Error,
  ScreenerDailyCandlesResponse,
  ScreenerDailyCandlesQueryKey
> {
  const enabled = !!(code && from && to && from <= to);
  return {
    queryKey: ['live', 'screener-daily-candles', code, from, to] as const,
    queryFn: ({ signal }) =>
      apiCall<ScreenerDailyCandlesResponse>(
        `/api/live/screener-daily-candles?code=${code}&from=${from}&to=${to}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  };
}

export function useScreenerDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  return useQuery(screenerDailyCandlesQueryOptions(code, from, to));
}
