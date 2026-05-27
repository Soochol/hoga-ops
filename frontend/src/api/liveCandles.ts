import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import {
  baseFor,
  bucketSeconds,
  type LiveTimeframe,
} from '../state/livePage';
import { aggregateCandles } from '../live/aggregateCandles';

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
 * Strategy: the server only exposes the base timeframes ('1m', 'D', 'W', 'M').
 * Aggregated minute frames (3m–30m) are computed here from the 1m response,
 * so a single (code, '1m') query feeds every minute view and React Query
 * keeps the network footprint to one request per code. Daily/weekly/monthly
 * pass through unchanged.
 *
 * The backend caches per (code, base) for 60 seconds; our staleTime mirrors
 * that. Minute frames refetch every 60s so new bars appear without manual
 * invalidation; D/W/M are session-scoped and don't auto-refetch.
 */
export function useLiveCandles(code: string, timeframe: LiveTimeframe) {
  const base = baseFor(timeframe);
  const query = useQuery({
    queryKey: ['live', 'candles', code, base],
    queryFn: () =>
      apiCall<LiveCandlesResponse>(
        `/api/live/candles?code=${encodeURIComponent(code)}&timeframe=${encodeURIComponent(base)}`,
      ),
    enabled: !!code,
    staleTime: 30_000,
    refetchInterval: base === '1m' ? 60_000 : false,
  });

  const candles = useMemo<LiveCandle[]>(() => {
    const raw = query.data?.candles;
    if (!raw || raw.length === 0) return [];
    // KIS responses are DESC by t_ms. Aggregation + chart rendering both
    // assume ASC; sort once here and feed all consumers from the same view.
    const sorted = [...raw].sort((a, b) => a.t_ms - b.t_ms);
    const bucket = bucketSeconds(timeframe);
    if (bucket === null || timeframe === '1m') return sorted;
    return aggregateCandles(sorted, bucket);
  }, [query.data, timeframe]);

  return { ...query, candles };
}
