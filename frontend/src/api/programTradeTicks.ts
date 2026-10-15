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

export function useProgramTradeHistory(code: string, date: string, venue: string) {
  return useInfiniteQuery({
    queryKey: ['live', 'program-trades', code, date, venue],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => apiCall<ProgramTradeTicksResponse>(
      `/api/live/program-trades?code=${code}&date=${date}&venue=${venue}&limit=200${pageParam === null ? '' : `&before=${pageParam}`}`, { signal },
    ),
    getNextPageParam: page => page.next_before ?? undefined,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
