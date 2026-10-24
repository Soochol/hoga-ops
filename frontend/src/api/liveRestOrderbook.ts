import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { OrderbookLevel } from './types';
import type { LiveVenueOption } from '../state/liveVenue';
import { useKstDay } from '../util/useKstDay';

export type RestOrderbookSource = 'kiwoom_rest' | 'stored';
/** ka10004 has no trading date. Never manufacture ts_ms from its clock. */
export interface RestOrderbook {
  ask: OrderbookLevel[];
  bid: OrderbookLevel[];
  tot_ask: number;
  tot_bid: number;
  book_time: string | null;
}
export interface RestOrderbookResponse {
  code: string;
  venue: LiveVenueOption;
  book: RestOrderbook | null;
  source: RestOrderbookSource;
  fetched_at_ms: number | null;
  checked_at_ms: number;
  refresh_failed: boolean;
  storage_failed: boolean;
}

export function useLiveRestOrderbook(code: string, venue: LiveVenueOption, enabled: boolean) {
  const date = useKstDay();
  return useQuery({
    queryKey: ['live', 'last-orderbook', code, venue, date],
    queryFn: ({ signal }) => apiCall<RestOrderbookResponse>(
      `/api/live/last-orderbook?code=${encodeURIComponent(code)}&venue=${venue}`, { signal },
    ),
    enabled: !!code && enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: false,
  });
}
