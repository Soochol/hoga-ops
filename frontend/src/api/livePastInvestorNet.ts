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
  points: InvestorNetPoint[];
  data_warnings: LivePastInvestorNetWarning[];
  cached: boolean;
}

/** GET /api/live/past-investor-net — recent (~30 trading day) foreign/institution
 * net-buy quantities. KIS inquire-investor takes no date range, so the query key
 * is code-only (ADR-0055). Enabled only for D/W/M timeframes by the caller. */
export function useLivePastInvestorNet(code: string | null) {
  const enabled = !!code;
  return useQuery({
    queryKey: ['live', 'past-investor-net', code] as const,
    queryFn: () =>
      apiCall<LivePastInvestorNetResponse>(`/api/live/past-investor-net?code=${code}`),
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
