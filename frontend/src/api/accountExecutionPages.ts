import { useMemo, useReducer } from 'react';
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { apiCall, type ApiError } from './client';
import type { AccountExecutions } from './accountExecutions';

const AUTO_PAGES = 128;

export async function fetchAccountExecutionPage(
  account: string, code: string, date: string, venue: string, cursor: string | null,
  signal: AbortSignal, seen: ReadonlySet<string | null> = new Set(),
): Promise<AccountExecutions> {
  const params = new URLSearchParams({ account_ref: account, code, date, venue });
  if (cursor) params.set('cursor', cursor);
  const page = await apiCall<AccountExecutions>(`/api/trading/v2/executions?${params}`, { signal });
  if (page.account_ref !== account || page.code !== code || page.date !== date || page.price_venue !== venue
    || (page.next_cursor && (page.next_cursor === cursor || seen.has(page.next_cursor)))) {
    throw new Error('체결 조회 응답을 확인할 수 없습니다.');
  }
  return page;
}

function combinePages(results: UseQueryResult<AccountExecutions>[]) {
  const failedIndex = results.findIndex(result => result.isError);
  return {
    pages: results.flatMap(result => result.data ? [result.data] : []),
    loading: results.some(result => result.isFetching),
    error: results[failedIndex]?.error ?? null,
    failedIndex,
    refetchFailed: results[failedIndex]?.refetch,
  };
}

/** Completed historical pages (including empty ones) live in this tab's query cache.
 * One missing page runs at a time. Leaving a date aborts only its unfinished page;
 * earlier pages remain reusable across ranges, resolutions, windows and OFF/ON.
 */
export function useHistoricalExecutionPages(
  account: string, code: string, dates: readonly string[], enabled: boolean, venue: string,
) {
  const client = useQueryClient();
  const [, redraw] = useReducer(value => value + 1, 0);
  const scope = dates.join(',');
  const budget = useMemo(() => {
    const visible = new Set(scope.split(','));
    const existing = client.getQueriesData<AccountExecutions>({
      queryKey: ['account-execution-history-page', account, code, venue],
    }).filter(([key, data]) => data && visible.has(String(key[4]))).map(([key]) => JSON.stringify(key));
    return { existing: new Set(existing), allowance: AUTO_PAGES };
  }, [client, account, code, venue, scope]);
  const allowed = enabled && !!account && !!code;
  const requests: { date: string; cursor: string | null; key: readonly unknown[]; seen: Set<string | null> }[] = [];
  let unsupported = false;
  for (const date of dates) {
    let cursor: string | null = null;
    const seen = new Set<string | null>();
    do {
      seen.add(cursor);
      const key: readonly unknown[] = ['account-execution-history-page', account, code, venue, date, cursor];
      requests.push({ date, cursor, key, seen: new Set(seen) });
      const cached: AccountExecutions | undefined = client.getQueryData<AccountExecutions>(key);
      if (!cached) break;
      if (!cached.supported) { unsupported = true; break; }
      cursor = cached.next_cursor;
    } while (cursor && !seen.has(cursor));
  }
  const target = requests.findIndex(request => !client.getQueryData(request.key));
  // Count shared successful pages, rather than which window owned the fetch.
  const used = requests.filter(request => client.getQueryData(request.key)
    && !budget.existing.has(JSON.stringify(request.key))).length;
  const remaining = budget.allowance - used;
  const result = useQueries({
    queries: requests.map((request, index) => ({
      queryKey: request.key,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchAccountExecutionPage(account, code, request.date, venue, request.cursor, signal, request.seen),
      enabled: allowed && !unsupported && index === target && remaining > 0,
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    })),
    combine: combinePages,
  });
  return {
    pages: result.pages,
    loading: result.loading,
    error: result.error,
    pending: target >= 0 && !unsupported && !result.error && remaining > 0,
    more: target >= 0 && !unsupported,
    loadMore: () => { if (allowed) { budget.allowance += AUTO_PAGES; redraw(); } },
    retry: () => {
      if (!allowed || result.failedIndex < 0) return;
      budget.allowance = Math.max(budget.allowance, used + AUTO_PAGES);
      if ((result.error as ApiError)?.code === 'execution-cursor-expired') {
        // Refresh this date's root so every window observes the new signed chain.
        const request = requests[result.failedIndex];
        void client.fetchQuery({
          queryKey: ['account-execution-history-page', account, code, venue, request.date, null],
          queryFn: ({ signal }) => fetchAccountExecutionPage(account, code, request.date, venue, null, signal),
          staleTime: 0,
          retry: false,
        }).catch(() => { /* The observed root query exposes the error and retry action. */ });
      } else {
        void result.refetchFailed?.();
      }
      redraw();
    },
  };
}
