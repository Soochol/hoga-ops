import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { useTradingRefresh, type TradingAccountId, type TradingSide } from './trading';
import { tradingStateKey } from './tradingRefresh';

export type ExecutionPriceBasis = 'average' | 'execution';
export interface ExecutionHistoryRow {
  order_ref: string;
  broker_order_id: string;
  code: string;
  name: string | null;
  side: TradingSide;
  quantity: string;
  order_quantity: string;
  price: string | null;
  price_basis: ExecutionPriceBasis;
  amount: string | null;
  filled_at: string | null;
  ordered_at: string | null;
  route: 'KRX' | 'NXT' | 'SOR';
}
export interface ExecutionHistoryPage {
  account_ref: string;
  date: string;
  rows: ExecutionHistoryRow[];
  next_key: string | null;
  fetched_at_ms: number;
  events_connected: boolean;
}

export function mergeExecutionRows(...pages: readonly ({ rows: ExecutionHistoryRow[] } | undefined)[]): ExecutionHistoryRow[] {
  const rows = new Map<string, ExecutionHistoryRow>();
  for (const page of pages) for (const row of page?.rows ?? []) {
    if (!(Number(row.quantity) > 0)) continue;
    const previous = rows.get(row.order_ref);
    // First page is current; a stale older page cannot overwrite its quantities.
    if (!previous || Number(row.quantity) > Number(previous.quantity)) rows.set(row.order_ref, row);
  }
  const stamp = (row: ExecutionHistoryRow) => Date.parse(row.filled_at ?? row.ordered_at ?? '') || 0;
  return [...rows.values()].sort((a, b) => stamp(b) - stamp(a) || b.order_ref.localeCompare(a.order_ref));
}

export function useExecutionHistory(account: TradingAccountId | null, date: string, enabled = true) {
  const { paused } = useTradingRefresh(account ?? 0, 'live', enabled);
  const available = enabled && typeof account === 'string' && !paused;
  const read = async (cursor: string | null, signal: AbortSignal) => {
    const page = await apiCall<ExecutionHistoryPage>(`/api/trading/v2/execution-history?account_ref=${encodeURIComponent(account ?? '')}&date=${date}${cursor ? `&next_key=${encodeURIComponent(cursor)}` : ''}`, { signal });
    if (page.account_ref !== account || page.date !== date) throw new Error('선택 계좌의 체결내역 응답을 확인하세요.');
    if (cursor && page.next_key === cursor) throw new Error('이전 체결내역 조회가 진행되지 않았습니다.');
    return page;
  };
  const first = useQuery({
    queryKey: [...tradingStateKey('live', account ?? 0), 'orders', 'execution-history', date],
    queryFn: ({ signal }) => read(null, signal), enabled: available,
    staleTime: 1_000, refetchInterval: available ? 3_000 : false, retry: false,
  });
  // Only the newest page polls. Scrolling into older history must not multiply polling requests.
  const older = useInfiniteQuery({
    queryKey: ['execution-history-older', account, date], enabled: false,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const cursor = pageParam ?? first.data?.next_key;
      if (!cursor) throw new Error('이전 체결내역이 없습니다.');
      return read(cursor, signal);
    },
    getNextPageParam: page => page.next_key ?? undefined, retry: false, staleTime: Infinity,
  });
  const scope = `${account}:${date}`;
  const [seen, setSeen] = useState<{ scope: string; page?: ExecutionHistoryPage; rows: ExecutionHistoryRow[] }>({ scope, rows: [] });
  let retained = seen.scope === scope ? seen.rows : [];
  if (seen.scope !== scope || seen.page !== first.data) {
    retained = mergeExecutionRows(first.data, { rows: retained });
    setSeen({ scope, page: first.data, rows: retained });
  }
  const pages = older.data?.pages ?? [];
  // Keep already observed totals as incoming fills move older orders off the first page.
  const rows = enabled ? mergeExecutionRows(first.data, ...pages, { rows: retained }) : [];
  return { first, older, rows, paused,
    hasMore: available && !!(pages.length ? pages[pages.length - 1].next_key : first.data?.next_key),
    loadMore: () => { if (available && !older.isFetching) void older.fetchNextPage(); },
  };
}
