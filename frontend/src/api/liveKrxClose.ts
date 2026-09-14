import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface KrxCloseResponse {
  code: string;
  date: string;
  price: number | null;
  close_at_ms: number;
  fetched_at_ms: number | null;
}

export function useLiveKrxClose(code: string | null, date: string) {
  return useQuery({
    queryKey: ['live', 'krx-close', code, date],
    queryFn: ({ signal }) => apiCall<KrxCloseResponse>('/api/live/krx-close?code=' + code, { signal }),
    enabled: !!code,
    staleTime: 60_000,
    refetchInterval: query => query.state.data?.price != null && query.state.data.date === date ? false : 60_000,
  });
}
