import { todayKstYyyymmdd } from '../live/liveDateTime';
import { apiCall } from './client';
import { useQuery } from '@tanstack/react-query';
import type { LiveVenueOption } from '../state/liveVenue';

export type SecondBar = {
  t_ms: number; open: number; high: number; low: number; close: number;
  volume: number; trade_value: number; count: number;
};
export type SecondPrice = { t_ms: number; price: number; side: -1 | 0 | 1; qty: number; count: number };
export type SecondAggregates = {
  source: 'second_trades' | 'hogaplay' | null;
  code: string; venue: 'KRX' | 'NXT' | 'UN'; date: string; seconds: 1 | 5 | 10 | 30;
  status: 'observed' | 'unavailable'; coverage: 'unverified'; storage_error: string | null;
  first_observed_ms: number | null; last_observed_ms: number | null;
  bars: SecondBar[]; prices: SecondPrice[];
};
export function useSecondAggregates(code: string | null, venue: LiveVenueOption, date: string, fromMs: number | null, prices = false, seconds: SecondAggregates['seconds'] = 10) {
  return useQuery({
    queryKey: ['second-aggregates', code, venue, date, fromMs, prices, seconds],
    enabled: code !== null,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ code: code!, venue,
        date, seconds: String(seconds), include_prices: String(prices) });
      if (fromMs !== null) params.set('from_ms', String(fromMs));
      return apiCall<SecondAggregates>(`/api/live/second-aggregates?${params}`, { signal });
    },
    refetchInterval: date === todayKstYyyymmdd() ? 1000 : false,
    staleTime: date === todayKstYyyymmdd() ? 750 : Infinity,
  });
}
