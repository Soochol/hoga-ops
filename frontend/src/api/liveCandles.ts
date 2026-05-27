import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LiveCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LiveCandlesResponse {
  code: string;
  timeframe: string;
  candles: LiveCandle[];
  cached: boolean;
}

/**
 * useLiveCandles — KIS candle proxy (backed by /api/live/candles).
 *
 * The backend caches per (code, timeframe) for 60 seconds. We additionally
 * set React Query's staleTime to 30s so most renders are instant. For
 * minute timeframes Stage 11+ can add a refetch interval; for now manual
 * invalidation is enough.
 */
export function useLiveCandles(code: string, timeframe: string) {
  return useQuery({
    queryKey: ['live', 'candles', code, timeframe],
    queryFn: () =>
      apiCall<LiveCandlesResponse>(
        `/api/live/candles?code=${encodeURIComponent(code)}&timeframe=${encodeURIComponent(timeframe)}`,
      ),
    enabled: !!code,
    staleTime: 30_000,
    refetchInterval: timeframe.endsWith('m') ? 60_000 : false,
  });
}
