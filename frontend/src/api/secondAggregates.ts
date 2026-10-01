import { regularSessionOpenMs, regularSessionCloseMs } from '../live/liveDateTime';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { apiCall } from './client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { applySecondDelta, projectSecondSource } from './secondAggregateSource';
import type { LiveVenueOption } from '../state/liveVenue';

export type SecondBar = {
  t_ms: number; open: number; high: number; low: number; close: number;
  volume: number; trade_value: number; count: number;
};
export type SecondPrice = { t_ms: number; price: number; side: -1 | 0 | 1; qty: number; count: number };
export type SecondAggregates = {
  revision?: string | null; reset?: boolean; changed_ms?: number[];
  source: 'second_trades' | 'hogaplay' | null;
  code: string; venue: 'KRX' | 'NXT' | 'UN'; date: string; seconds: 1 | 5 | 10 | 30;
  status: 'observed' | 'unavailable'; coverage: 'unverified'; storage_error: string | null;
  first_observed_ms: number | null; last_observed_ms: number | null;
  bars: SecondBar[]; prices: SecondPrice[];
};
export function useSecondAggregates(code: string | null, venue: LiveVenueOption, date: string, fromMs: number | null, prices = false, seconds: SecondAggregates['seconds'] = 10, regularSessionOnly = false) {
  const client = useQueryClient();
  // One stock/date source serves every seconds interval and its linked profile.
  const queryKey = ['second-source', code, venue, date, regularSessionOnly] as const;
  const select = useCallback((source: SecondAggregates) => projectSecondSource(source, seconds, fromMs, prices), [seconds, fromMs, prices]);
  const shared = useQuery({
    queryKey,
    enabled: code !== null,
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<SecondAggregates>(queryKey);
      const params = new URLSearchParams({ code: code!, venue, date, seconds: '1',
        regular_session_only: String(regularSessionOnly), include_prices: 'true', incremental: 'true' });
      if (regularSessionOnly) {
        params.set('from_ms', String(regularSessionOpenMs(date)));
        params.set('to_ms', String(regularSessionCloseMs(date) + 1000));
      }
      if (previous?.revision) params.set('since_revision', previous.revision);
      const next = await apiCall<SecondAggregates>(`/api/live/second-aggregates?${params}`, { signal });
      return applySecondDelta(previous, next);
    },
    select,
    // Bucket merging already retains unchanged objects. Avoid a second deep scan
    // of the entire day in React Query's structural-sharing implementation.
    structuralSharing: false,
    refetchInterval: query => date === todayKstYyyymmdd() && query.state.data?.revision ? 1000 : false,
    staleTime: query => query.state.data && !query.state.data.revision ? Infinity : date === todayKstYyyymmdd() ? 750 : Infinity,
  });
  // A frontend may be upgraded before its local backend. Preserve the old
  // bounded polling path until that backend advertises response revisions.
  const legacyBackend = shared.data !== undefined && !shared.data.revision;
  const legacy = useQuery({
    queryKey: ['second-aggregates', code, venue, date, fromMs, prices, seconds, regularSessionOnly],
    enabled: code !== null && legacyBackend,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ code: code!, venue, date, seconds: String(seconds),
        include_prices: String(prices), regular_session_only: String(regularSessionOnly) });
      if (fromMs !== null || regularSessionOnly) params.set('from_ms', String(Math.max(fromMs ?? 0, regularSessionOnly ? regularSessionOpenMs(date) : 0)));
      if (regularSessionOnly) params.set('to_ms', String(regularSessionCloseMs(date) + 1000));
      return apiCall<SecondAggregates>(`/api/live/second-aggregates?${params}`, { signal });
    },
    refetchInterval: date === todayKstYyyymmdd() && legacyBackend ? 1000 : false,
    staleTime: date === todayKstYyyymmdd() ? 750 : Infinity,
  });
  return legacyBackend ? legacy : shared;
}
