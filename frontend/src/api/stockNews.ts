import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type StockNewsStatus = 'ok' | 'unconfigured' | 'error';

export interface StockNewsItem {
  id: string;
  title: string;
  source: string;
  published_at_ms: number | null;
  related_codes: string[];
}

export interface StockNewsResponse {
  code: string;
  date: string | null;
  status: StockNewsStatus;
  items: StockNewsItem[];
  fetched_at_ms: number | null;
  limit: number;
}

export function useStockNews(code: string, date: string | null) {
  return useQuery({
    queryKey: ['stock-news', code, date],
    queryFn: ({ signal }) => apiCall<StockNewsResponse>(
      `/api/news/stock?code=${encodeURIComponent(code)}${date ? `&date=${date}` : ''}`, { signal },
    ),
    staleTime: 60_000,
    refetchInterval: date ? false : 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
