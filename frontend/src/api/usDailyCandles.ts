import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { LiveInstrument, UsExchange } from '../live/liveInstrument';
import type { LiveTimeframe } from '../state/livePage';
import type { LiveIndexCandle } from './liveIndices';

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
  return useQuery({
    queryKey: ['live', 'us-stock-daily', stock?.exchange, stock?.symbol, from, to],
    enabled: !!stock && timeframe === 'D',
    queryFn: ({ signal }) => apiCall<UsStockDailyResponse>(`/api/live/us-stock-daily-candles?exchange=${stock!.exchange}&symbol=${encodeURIComponent(stock!.symbol)}&from=${from}&to=${to}`, { signal }),
    placeholderData: (previous) => previous?.instrument_key === `us-stock:${stock?.exchange}:${stock?.symbol}` ? previous : undefined,
    staleTime: 300_000,
    refetchInterval: (query) => usDailyRefetchInterval(query.state.data?.daily_metadata, to, query.state.dataUpdateCount),
    refetchOnWindowFocus: (query) => usDailyRefetchInterval(query.state.data?.daily_metadata, to, query.state.dataUpdateCount) !== false,
  });
}
