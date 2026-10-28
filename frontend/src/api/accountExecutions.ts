import { useEffect, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchAccountExecutionPage, useHistoricalExecutionPages } from './accountExecutionPages';
import type { TradingSide } from './trading';
import { todayKstYyyymmdd } from '../live/liveDateTime';

export type ExecutionBasis = 'execution' | 'order_average';

export interface AccountExecution {
  execution_id: string;
  order_ref: string;
  code: string;
  trading_date: string;
  t_ms: number;
  side: TradingSide;
  price: string;
  quantity: string;
  venue: string | null;
  basis: ExecutionBasis;
}
export interface AccountExecutions {
  account_ref: string;
  code: string;
  date: string;
  rows: AccountExecution[];
  next_cursor: string | null;
  supported: boolean;
  message: string | null;
  fetched_at_ms: number;
  raw_close: string | null;
  price_venue: string;
}
type Page = { index: number; cursor: string | null };
const AUTO_PAGES = 128;

function useExecutionPages(account: string, code: string, dates: readonly string[], enabled: boolean, live: boolean, venue: string) {
  const key = dates.join(',');
  const query = useInfiniteQuery({
    queryKey: ['account-executions', account, code, venue, key],
    enabled: enabled && !!account && !!code && dates.length > 0,
    initialPageParam: { index: 0, cursor: null } as Page,
    queryFn: async ({ pageParam, signal }) => {
      const date = dates[pageParam.index];
      return fetchAccountExecutionPage(account, code, date, venue, pageParam.cursor, signal);
    },
    getNextPageParam: (last, _pages, param) => !last.supported ? undefined : last.next_cursor
      ? { index: param.index, cursor: last.next_cursor }
      : param.index + 1 < dates.length ? { index: param.index + 1, cursor: null } : undefined,
    staleTime: live ? 5_000 : 300_000,
    refetchInterval: live ? 15_000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const count = query.data?.pages.length ?? 0;
  const next = query.fetchNextPage;
  useEffect(() => {
    if (enabled && query.hasNextPage && !query.isFetching && !query.isError && count < AUTO_PAGES) void next();
  }, [enabled, query.hasNextPage, query.isFetching, query.isError, count, next]);
  return query;
}

/** Today refreshes independently; polling must not re-read every historical trading day. */
export function useAccountExecutions(account: string, code: string, dates: readonly string[], enabled: boolean, venue: string) {
  const today = todayKstYyyymmdd();
  const pastDates = useMemo(() => [...new Set(dates)].filter(date => date < today).sort().reverse(), [dates, today]);
  const currentDates = useMemo(() => dates.includes(today) ? [today] : [], [dates, today]);
  const current = useExecutionPages(account, code, currentDates, enabled, true, venue);
  const past = useHistoricalExecutionPages(account, code, pastDates, enabled, venue);
  const pages = useMemo(() => [...(current.data?.pages ?? []), ...past.pages], [current.data, past.pages]);
  const rows = useMemo(() => {
    const unique = new Map<string, AccountExecution>();
    for (const page of pages) for (const row of page.rows) if (row.code === code) {
      const previous = unique.get(row.execution_id);
      // OPEN/CLOSED pages can overlap during a partial-fill transition.
      if (previous?.basis === 'order_average' && row.basis === 'order_average'
        && (Number(previous.quantity) > Number(row.quantity)
          || (Number(previous.quantity) === Number(row.quantity) && previous.t_ms > row.t_ms))) continue;
      unique.set(row.execution_id, row);
    }
    return [...unique.values()].sort((a, b) => a.t_ms - b.t_ms);
  }, [pages, code]);
  const rawCloses = useMemo(() => Object.fromEntries(pages.filter(p => Number(p.raw_close) > 0)
    .map(p => [p.date, Number(p.raw_close)])), [pages]);
  return {
    rows,
    rawCloses,
    loading: current.isFetching || past.loading,
    error: current.error ?? past.error,
    message: pages.find(page => page.message)?.message,
    pending: (currentDates.length > 0 && !current.data) || past.pending,
    more: current.hasNextPage || past.more,
    retry: () => { if (enabled && currentDates.length && current.error) void current.refetch(); past.retry(); },
    loadMore: () => { if (enabled && current.hasNextPage) void current.fetchNextPage(); past.loadMore(); },
  };
}
