import { useInfiniteQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface ProgramTradeTickRow {
  event_id: string;
  t_ms: number;
  price: number | null;
  event_delta_qty: number;
}

export interface ProgramTradeTicksResponse {
  code: string;
  date: string;
  venue: string;
  rows: ProgramTradeTickRow[];
  next_before: number | null;
}

export interface ProgramTradeHistoryResponse {
  code: string;
  date: string;
  venue: string;
  rows: ProgramTradeTickRow[];
  next_key: string | null;
  latest_at_ms: number | null;
}

export function useProgramTradeHistory(code: string, date: string, venue: string) {
  return useInfiniteQuery({
    queryKey: ['live', 'program-trade-history', code, date, venue],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiCall<ProgramTradeHistoryResponse>(
      `/api/live/program-trades/history?code=${code}&date=${date}&venue=${venue}${pageParam === null ? '' : `&next_key=${encodeURIComponent(pageParam)}`}`, { signal },
    ),
    getNextPageParam: page => page.next_key ?? undefined,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
