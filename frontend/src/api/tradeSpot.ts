import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { useOrderflowSourcePref } from '../state/sourcePreference';
import type { TradeSpotScope } from '../live/tradeSpotScope';

export type TradeSpotRepresentation = 'ticks' | 'second_price_aggregate';
export type TradeSpotStatus = 'observed' | 'empty' | 'unavailable' | 'insufficient_resolution';
export interface TradeSpotRow {
  event_id: string; t_ms: number; price: number; qty: number; side: number; count: number;
}
export interface TradeSpotResponse {
  code: string; date: string; venue: string; source_pref: string; from_ms: number; to_ms: number;
  source: 'hogaplay' | 'kiwoom_live' | null; representation: TradeSpotRepresentation | null;
  status: TradeSpotStatus; coverage: 'unverified'; storage_error: string | null;
  rows: TradeSpotRow[]; prev_close: number | null; revision: string; has_more: boolean; next_cursor: string | null;
  previous_observed_ms: number | null;
}

export function useTradeSpot(code: string, scope: TradeSpotScope, minAmountManwon: number, enabled = true) {
  const sourcePref = useOrderflowSourcePref();
  return useQuery({
    queryKey: ['trade-spot', code, scope.date, scope.venue, scope.timeframe, scope.fromMs, scope.toMs, sourcePref, minAmountManwon],
    enabled: enabled && sourcePref !== undefined,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ code, date: scope.date, venue: scope.venue, source_pref: sourcePref!,
        from_ms: String(scope.fromMs), to_ms: String(scope.toMs), min_amount_manwon: String(minAmountManwon) });
      return apiCall<TradeSpotResponse>(`/api/trades/spot?${params}`, { signal });
    },
    // Completed buckets can still be replaced by a capture; never cache them forever.
    staleTime: 1000,
    gcTime: 60_000,
    refetchInterval: () => Date.now() >= scope.fromMs && Date.now() < scope.toMs ? 1000 : 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
