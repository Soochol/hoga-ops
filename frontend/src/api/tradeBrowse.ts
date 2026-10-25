import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { apiCall, type ApiError } from './client';
import type { TradeSpotResponse } from './tradeSpot';
import { earlierTradeScope, type TradeSpotScope } from '../live/tradeSpotScope';

export interface TradeBrowsePage { scope: TradeSpotScope; data: TradeSpotResponse }
export interface TradeBrowseParam { scope: TradeSpotScope; cursor: string | null }

export function nextTradePage(page: TradeBrowsePage): TradeBrowseParam | undefined {
  if (page.data.has_more) return page.data.next_cursor ? { scope: page.scope, cursor: page.data.next_cursor } : undefined;
  const scope = earlierTradeScope(page.scope, page.data.previous_observed_ms);
  return scope ? { scope, cursor: null } : undefined;
}

export function useTradeBrowsePages(code: string, seed: TradeSpotScope, sourcePref: string, minAmountManwon: number,
  initial: TradeSpotResponse | undefined) {
  const client = useQueryClient();
  const key = ['trade-browse', code, seed.date, seed.venue, seed.timeframe, seed.fromMs, seed.toMs, seed.regularSessionOnly, sourcePref, minAmountManwon];
  const first = { scope: seed, cursor: null };
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: first as TradeBrowseParam,
    initialData: initial ? { pages: [{ scope: seed, data: initial }], pageParams: [first] } : undefined,
    queryFn: async ({ pageParam, signal }): Promise<TradeBrowsePage> => {
      const { scope, cursor } = pageParam;
      const params = new URLSearchParams({ code, date: scope.date, venue: scope.venue, source_pref: sourcePref,
        from_ms: String(scope.fromMs), to_ms: String(scope.toMs), min_amount_manwon: String(minAmountManwon) });
      if (cursor) params.set('cursor', cursor);
      const data = await apiCall<TradeSpotResponse>(`/api/trades/spot?${params}`, { signal });
      const base = client.getQueryData<InfiniteData<TradeBrowsePage, TradeBrowseParam>>(key)?.pages[0]?.data;
      if ((cursor !== null || scope.fromMs !== seed.fromMs) && base?.source && (data.source !== base.source || data.representation !== base.representation
          || (base.source === 'hogaplay' && data.revision !== base.revision))) {
        throw Object.assign(new Error('체결 데이터가 변경되었습니다. 처음부터 다시 조회하세요'), { status: 409 }) as ApiError;
      }
      if (data.has_more && !data.next_cursor) throw new Error('다음 체결 페이지 정보가 없습니다');
      return { scope, data };
    },
    getNextPageParam: nextTradePage,
    // A reading session is a stable chain. Refreshing its head would splice generations.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return { ...query, restart: () => client.resetQueries({ queryKey: key, exact: true }) };
}
