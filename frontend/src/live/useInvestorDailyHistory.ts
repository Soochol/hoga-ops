import { useInfiniteQuery } from '@tanstack/react-query';

import type { InvestorTradeSide } from '../api/types';
import { apiCall } from '../api/client';
import type { InvestorNetAxis, LivePastInvestorNetResponse } from '../api/livePastInvestorNet';
import { subtractDaysKst } from './liveDateTime';

/** Disjoint historical windows: recent data polls separately; old pages only load on demand. */
export function useInvestorDailyHistory(code: string, recentFrom: string, axis: InvestorNetAxis, tradeSide: InvestorTradeSide = 'net') {
  return useInfiniteQuery({
    queryKey: ['live', 'investor-daily-history', code, recentFrom, axis, tradeSide],
    initialPageParam: subtractDaysKst(recentFrom, 1),
    queryFn: async ({ pageParam: to, signal }) => {
      const from = subtractDaysKst(to, 129);
      const page = await apiCall<LivePastInvestorNetResponse>(
        `/api/live/past-investor-net?code=${code}&from=${from}&to=${to}&axis=${axis}&trade_side=${tradeSide}`,
        { signal },
      );
      if ((page.trade_side ?? 'net') !== tradeSide) throw new Error('매매 기준이 다른 응답입니다');
      // A partial response must not advance the cursor and silently skip missing days.
      if (page.data_warnings.length > 0) throw new Error(page.data_warnings[0].msg);
      return page;
    },
    getNextPageParam: (lastPage) => lastPage.from > '19000101'
      ? subtractDaysKst(lastPage.from, 1) : undefined,
    enabled: false,
    staleTime: Infinity,
    retry: false,
  });
}
