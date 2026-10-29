import { useEffect } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { apiCall, type ApiError } from './client';

export interface RecentTradedStock { code: string; name: string | null; date: string; filled_at: string | null }
export interface ExecutionHistoryRangePage {
  account_ref: string;
  from_date: string;
  to_date: string;
  rows: RecentTradedStock[];
  next_key: string | null;
  scanned_through: string | null;
  fetched_at_ms: number;
  events_connected: boolean;
}

export function oneYearAgo(date: string): string {
  const year = Number(date.slice(0, 4)) - 1, month = Number(date.slice(4, 6)), day = Number(date.slice(6));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}${date.slice(4, 6)}${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/** One request at a time, shared/resumed across windows; never re-poll the whole year. */
export function useExecutionHistoryRange(account: string, from: string, to: string, enabled: boolean) {
  const client = useQueryClient();
  const queryKey = ['execution-history-range', account, from, to];
  const query = useInfiniteQuery({
    queryKey, enabled, initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ account_ref: account, from_date: from, to_date: to });
      if (pageParam) params.set('next_key', pageParam);
      const page = await apiCall<ExecutionHistoryRangePage>(`/api/trading/v2/execution-history-range?${params}`, { signal });
      const previous = client.getQueryData<InfiniteData<ExecutionHistoryRangePage>>(queryKey);
      if (page.account_ref !== account || page.from_date !== from || page.to_date !== to
        || (page.next_key && (pageParam === page.next_key || previous?.pageParams.includes(page.next_key)))) {
        throw new Error('선택 계좌의 과거 체결내역 응답을 확인하세요.');
      }
      return page;
    },
    getNextPageParam: page => page.next_key ?? undefined,
    staleTime: Infinity, gcTime: 86_400_000, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false,
  });
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  const pageCount = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (enabled && hasNextPage && !isFetching && !isError) void fetchNextPage({ cancelRefetch: false });
  }, [enabled, hasNextPage, isFetching, isError, fetchNextPage, pageCount]);
  const restart = () => client.resetQueries({ queryKey, exact: true });
  const retryPage = () => (query.error as ApiError | null)?.code === 'execution-cursor-expired'
    ? restart() : query.data ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch();
  return { ...query, restart, retryPage };
}
