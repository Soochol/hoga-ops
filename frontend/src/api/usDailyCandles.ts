import { useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';
import type { LiveInstrument, UsExchange } from '../live/liveInstrument';
import type { LiveTimeframe } from '../state/livePage';
import { US_MINUTE_TIMEFRAMES } from '../live/liveInstrument';
import type { UsMinuteMetadata, LiveIndexCandle } from './liveIndices';

export type UsDailyStatus = 'normal' | 'stale' | 'unconfigured' | 'error' | 'bypass' | 'partial';
export interface UsDateRange { start: string; end: string }
export interface UsDailyMetadata {
  market: string;
  market_timezone: string;
  source: string;
  price_basis: string;
  currency: string;
  session_scope: string;
  history_start: string | null;
  latest_bar_date: string | null;
  last_successful_check_at_ms: number | null;
  completed: UsDateRange[];
  missing: UsDateRange[];
  truncated: boolean;
  refresh_status: UsDailyStatus;
  messages: string[];
}
export interface UsDailyBar extends LiveIndexCandle { trading_date: string }
export interface UsStockDailyResponse {
  instrument_key: string;
  exchange: UsExchange;
  symbol: string;
  from: string;
  to: string;
  timeframe: string;
  candles: UsDailyBar[];
  daily_metadata: UsDailyMetadata;
}
export interface UsStockEntry { exchange: UsExchange; symbol: string; label: string; english_name: string; is_etf: boolean }
export interface UsStockCatalogResponse { stocks: UsStockEntry[]; status: string; fetched_at_ms: number | null }
export function useUsStocks() {
  return useQuery({ queryKey: ['live', 'us-stocks'], queryFn: ({ signal }) => apiCall<UsStockCatalogResponse>('/api/live/us-stocks', { signal }), staleTime: 86_400_000 });
}
export function usDailyRefetchInterval(meta: UsDailyMetadata | undefined, currentTo: string, count: number): number | false {
  // Continue bounded partial walks while they make progress; never spin on errors.
  if (meta?.refresh_status === 'partial' && count < 8) return 1000;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  return currentTo >= today ? 300_000 : false;
}
export function useUsStockDaily(instrument: LiveInstrument | null, timeframe: LiveTimeframe, from: string, to: string) {
  const stock = instrument?.kind === 'us_stock' ? instrument : null;
  return useQuery<UsStockDailyResponse & { realtimeBaseMs?: number }>({
    queryKey: ['live', 'us-stock-daily', stock?.exchange, stock?.symbol, timeframe, from, to],
    enabled: !!stock && ['D', 'W', 'M'].includes(timeframe),
    queryFn: async ({ signal }) => {
      const realtimeBaseMs = Date.now();
      const data = await apiCall<UsStockDailyResponse>(`/api/live/us-stock-daily-candles?exchange=${stock!.exchange}&symbol=${encodeURIComponent(stock!.symbol)}&from=${from}&to=${to}&timeframe=${timeframe}`, { signal });
      return { ...data, realtimeBaseMs };
    },
    placeholderData: (previous) => previous?.instrument_key === `us-stock:${stock?.exchange}:${stock?.symbol}` && previous.timeframe === timeframe ? previous : undefined,
    staleTime: 300_000,
    refetchInterval: (query) => {
      const interval = usDailyRefetchInterval(query.state.data?.daily_metadata, to, query.state.dataUpdateCount);
      return timeframe === 'D' && interval === 300_000 ? 60_000 : interval;
    },
    refetchOnWindowFocus: (query) => usDailyRefetchInterval(query.state.data?.daily_metadata, to, query.state.dataUpdateCount) !== false,
  });
}


export interface UsStockMinuteMetadata extends UsMinuteMetadata {
  price_basis: string;
  currency: string;
  bar_limit: number;
  pages_fetched: number;
  more_available: boolean;
  next_cursor: string | null;
}
export interface UsStockMinuteResponse {
  instrument_key: string;
  exchange: UsExchange;
  symbol: string;
  from: string;
  to: string;
  timeframe: string;
  candles: UsDailyBar[];
  minute_metadata: UsStockMinuteMetadata;
}
export const US_MINUTE_MAX_BARS = 51_200;

/** Latest wins on overlap. Never throw away already loaded history on polling. */
export function mergeUsMinuteBars(...parts: UsDailyBar[][]): UsDailyBar[] {
  const rows = new Map<number, UsDailyBar>();
  for (const part of parts) for (const row of part) rows.set(row.t_ms, row);
  return [...rows.values()].sort((a, b) => a.t_ms - b.t_ms).slice(-US_MINUTE_MAX_BARS);
}

export function retainUsMinuteWindow(old: UsStockMinuteResponse | undefined, next: UsStockMinuteResponse): UsStockMinuteResponse {
  if (!old || old.instrument_key !== next.instrument_key || old.timeframe !== next.timeframe) return next;
  const candles = mergeUsMinuteBars(old.candles, next.candles);
  const keepCursor = !!old.candles.length && !!next.candles.length && old.candles[0].t_ms < next.candles[0].t_ms;
  return { ...next, candles, from: candles[0]?.trading_date ?? next.from,
    minute_metadata: { ...next.minute_metadata, available_from_ms: candles[0]?.t_ms ?? null,
      ...(keepCursor ? { next_cursor: old.minute_metadata.next_cursor, more_available: old.minute_metadata.more_available } : {}) } };
}

export function useUsStockMinutes(instrument: LiveInstrument | null, timeframe: LiveTimeframe) {
  const stock = instrument?.kind === 'us_stock' ? instrument : null;
  const client = useQueryClient();
  const key = ['live', 'us-stock-minute', stock?.exchange, stock?.symbol, timeframe];
  const url = `/api/live/us-stock-minute-candles?exchange=${stock?.exchange}&symbol=${encodeURIComponent(stock?.symbol ?? '')}&timeframe=${timeframe}`;
  const latest = useQuery<UsStockMinuteResponse & { realtimeBaseMs?: number }>({
    queryKey: key,
    enabled: !!stock && (US_MINUTE_TIMEFRAMES as readonly string[]).includes(timeframe),
    queryFn: async ({ signal }) => {
      const realtimeBaseMs = Date.now();
      return { ...await apiCall<UsStockMinuteResponse>(url, { signal }), realtimeBaseMs };
    },
    structuralSharing: (old, next) => retainUsMinuteWindow(old as UsStockMinuteResponse | undefined, next as UsStockMinuteResponse),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
  });
  const history = useInfiniteQuery({
    queryKey: [...key, 'history'],
    enabled: false,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const cursor = pageParam ?? client.getQueryData<UsStockMinuteResponse>(key)?.minute_metadata.next_cursor;
      if (!cursor) throw new Error('과거 조회 연결 정보가 없습니다. 차트를 새로고침하세요.');
      const page = await apiCall<UsStockMinuteResponse>(`${url}&cursor=${encodeURIComponent(cursor)}`, { signal });
      if (!page.candles.length && page.minute_metadata.refresh_status !== 'normal')
        throw new Error('과거 조회에 실패했습니다. 다시 시도하세요.');
      return page;
    },
    getNextPageParam: (last, pages) => pages.length < 63 ? last.minute_metadata.next_cursor : undefined,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    // Completed pages keep their object references; avoid recursively walking
    // tens of thousands of immutable bars after every append.
    structuralSharing: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const pages = history.data?.pages;
  const data = useMemo(() => {
    if (!latest.data) return undefined;
    const candles = mergeUsMinuteBars(...(history.data?.pages ?? []).map(p => p.candles), latest.data.candles);
    return { ...latest.data, candles, from: candles[0]?.trading_date ?? latest.data.from };
  }, [history.data, latest.data]);
  const candles = data?.candles ?? [];
  const nextCursor = pages?.length ? pages.at(-1)?.minute_metadata.next_cursor : latest.data?.minute_metadata.next_cursor;
  const hasMore = !!stock && !!nextCursor && (pages?.length ?? 0) < 63 && candles.length < US_MINUTE_MAX_BARS;
  return { ...latest, data, historyLoading: history.isFetchingNextPage, historyError: history.error,
    historyHasMore: hasMore, historyLimitReached: (pages?.length ?? 0) >= 63 || candles.length >= US_MINUTE_MAX_BARS,
    loadOlder: () => { if (hasMore && !history.isFetchingNextPage) void history.fetchNextPage({ cancelRefetch: false }); },
    retryHistory: () => { void history.fetchNextPage({ cancelRefetch: false }); } };
}
