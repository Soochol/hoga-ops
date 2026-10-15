import { useInfiniteQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface TradeHistoryRow {
  event_id: string;
  t_ms: number;
  price: number;
  qty: number;
  side: number;
  cum_volume: number | null;
}

export interface TradeHistoryResponse {
  code: string;
  date: string;
  venue: string;
  rows: TradeHistoryRow[];
  next_key: string | null;
  latest_at_ms: number | null;
  latest_volume: number | null;
  prev_close: number | null;
}

export function useTradeHistory(code: string, date: string, venue: string) {
  return useInfiniteQuery({
    queryKey: ['live', 'trade-history', code, date, venue],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiCall<TradeHistoryResponse>(
      `/api/live/trades/history?code=${code}&date=${date}&venue=${venue}${pageParam === null ? '' : `&next_key=${encodeURIComponent(pageParam)}`}`, { signal },
    ),
    getNextPageParam: page => page.next_key ?? undefined,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
