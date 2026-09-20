import { useInfiniteQuery } from '@tanstack/react-query';

import { apiCall } from '../api/client';
import type { LiveDailyProgramTradeResponse } from '../api/liveDailyProgramTrade';
import { subtractDaysKst } from './liveDateTime';

/**
 * 일별 프로그램 과거 페이지. 최근 130일 폴링 쿼리와 겹치지 않는 구간만 사용자가
 * 요청할 때 가져온다. 부분 응답을 다음 페이지로 넘기면 빠진 날짜를 영구히 건너뛰므로
 * warning은 실패로 남겨 같은 페이지를 재시도하게 한다.
 */
export function useDailyProgramTradeHistory(code: string | null, recentFrom: string | null) {
  const safeRecentFrom = recentFrom ?? '19000101';
  return useInfiniteQuery({
    queryKey: ['live', 'daily-program-trade-history', code, recentFrom],
    initialPageParam: subtractDaysKst(safeRecentFrom, 1),
    queryFn: async ({ pageParam: to, signal }) => {
      if (code === null || recentFrom === null) throw new Error('프로그램 과거 조회 범위가 없습니다');
      const from = subtractDaysKst(to, 129);
      const page = await apiCall<LiveDailyProgramTradeResponse>(
        `/api/live/daily-program-trade?code=${code}&from=${from}&to=${to}`,
        { signal },
      );
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
