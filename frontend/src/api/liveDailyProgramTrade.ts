import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { isKrxRegularSessionNow } from '../live/liveDateTime';
import type { LivePastInvestorNetWarning } from './livePastInvestorNet';

export type DailyProgramTradePoint = {
  t_ms: number;
  net_qty: number | null;
  buy_qty: number | null;
  sell_qty: number | null;
};

export interface LiveDailyProgramTradeResponse {
  code: string;
  from: string;
  to: string;
  points: DailyProgramTradePoint[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastInvestorNetWarning[];
}

export function useLiveDailyProgramTrade(code: string | null, from: string | null, to: string | null) {
  return useQuery({
    queryKey: ['live', 'daily-program-trade', code, from, to],
    queryFn: ({ signal }) => apiCall<LiveDailyProgramTradeResponse>(
      `/api/live/daily-program-trade?code=${code}&from=${from}&to=${to}`, { signal },
    ),
    enabled: !!(code && from && to && from <= to),
    staleTime: 60_000,
    refetchInterval: () => isKrxRegularSessionNow() ? 60_000 : false,
    placeholderData: (prev) => prev?.code === code ? prev : undefined,
  });
}
