import { useQuery } from '@tanstack/react-query';
import { apiGet } from './client';
import type { StockDate } from './types';

export function useStockDates() {
  return useQuery({
    queryKey: ['stock-dates'],
    queryFn: () => apiGet<StockDate[]>('/api/stock-dates'),
    staleTime: Infinity,  // invalidated by SSE
  });
}
