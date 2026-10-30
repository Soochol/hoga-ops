import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { TradingAccountId } from './trading';

export interface PreopenCloseQuote {
  account_ref: string; code: string; trading_date: string; supported: boolean;
  price: number | null; starts_at_ms: number; ends_at_ms: number; can_order: boolean;
  reason: string | null; fetched_at_ms: number;
}

export function usePreopenClose(account: TradingAccountId, code: string, date: string, enabled: boolean) {
  return useQuery({
    queryKey: ['trading', 'live', 'preopen-close', account, code, date],
    enabled: enabled && typeof account === 'string',
    queryFn: ({ signal }) => apiCall<PreopenCloseQuote>(
      `/api/trading/v2/preopen-close?account_ref=${encodeURIComponent(account)}&code=${encodeURIComponent(code)}`, { signal }),
    staleTime: 10_000, refetchInterval: 15_000, retry: false,
  });
}
