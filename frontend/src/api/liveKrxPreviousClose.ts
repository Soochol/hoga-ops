import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface KrxPreviousCloseResponse {
  code: string;
  as_of: string;
  session_date: string | null;
  date: string | null;
  price: number | null;
  fetched_at_ms: number | null;
}

/** Shared across both windows and venues; the baseline is always the raw KRX close. */
export function useLiveKrxPreviousClose(code: string | null, asOf: string) {
  return useQuery({
    queryKey: ['live', 'krx-previous-close', code, asOf],
    queryFn: ({ signal }) => apiCall<KrxPreviousCloseResponse>(
      `/api/live/krx-previous-close?code=${code}&as_of=${asOf}`, { signal },
    ),
    enabled: !!code,
    staleTime: 60_000,
    refetchInterval: query => query.state.data?.price != null && query.state.data.as_of === asOf ? false : 60_000,
  });
}
