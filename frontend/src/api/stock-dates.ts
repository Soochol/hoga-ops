import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { StockDate } from './types';

/** Shared with inventory event invalidator in `./eventStream.ts` — single source of truth. */
export const STOCK_DATES_QUERY_KEY = ['stock-dates'] as const;

export function useStockDates() {
  return useQuery({
    queryKey: STOCK_DATES_QUERY_KEY,
    queryFn: () => apiGet<StockDate[]>('/api/stock-dates'),
    staleTime: Infinity, // invalidated by SSE
  });
}
