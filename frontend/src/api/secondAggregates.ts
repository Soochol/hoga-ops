import { regularSessionOpenMs, regularSessionCloseMs } from '../live/liveDateTime';
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
export function useSecondAggregates(code: string | null, venue: LiveVenueOption, date: string, fromMs: number | null, prices = false, seconds: SecondAggregates['seconds'] = 10, regularSessionOnly = false) {
  return useQuery({
    queryKey: ['second-aggregates', code, venue, date, fromMs, prices, seconds, regularSessionOnly],
    enabled: code !== null,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ code: code!, venue,
        date, seconds: String(seconds), regular_session_only: String(regularSessionOnly), include_prices: String(prices) });
      if (fromMs !== null || regularSessionOnly) params.set('from_ms', String(Math.max(fromMs ?? 0, regularSessionOnly ? regularSessionOpenMs(date) : 0)));
      if (regularSessionOnly) params.set('to_ms', String(regularSessionCloseMs(date) + 1000));
      return apiCall<SecondAggregates>(`/api/live/second-aggregates?${params}`, { signal });
    },
    refetchInterval: date === todayKstYyyymmdd() ? 1000 : false,
    staleTime: date === todayKstYyyymmdd() ? 750 : Infinity,
  });
}
