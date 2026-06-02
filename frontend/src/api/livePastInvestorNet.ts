import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { InvestorNetPoint } from './types';

export interface LivePastInvestorNetWarning {
  batch: string;
  /** Present on per-row warnings (invariant_violation); absent on batch-level
   * failures like kis_rate_limit / kis_api_error. */
  date?: string;
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation';
  msg: string;
}

export interface LivePastInvestorNetResponse {
  code: string;
  from: string;
  to: string;
  points: InvestorNetPoint[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastInvestorNetWarning[];
}

/** GET /api/live/past-investor-net — daily foreign/institution net-buy across
 * [from, to]. KIS investor-trade-by-stock-daily (FHPTJ04160001) walks back by
 * date cursor, so this mirrors useLivePastDailyCandles with a batch/gap cache
 * (ADR-0055). Enabled only for 'D' (일봉) by the caller. */
export function useLivePastInvestorNet(
  code: string | null,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-investor-net', code, from, to] as const,
    queryFn: () =>
      apiCall<LivePastInvestorNetResponse>(
        `/api/live/past-investor-net?code=${code}&from=${from}&to=${to}`,
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
