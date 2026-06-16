import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { isKrxRegularSessionNow } from '../live/liveDateTime';

export interface LiveInvestorTrendEstimateRow {
  slot: string;
  foreign_qty: number | null;
  institution_qty: number | null;
  sum_qty: number | null;
}

export interface LiveInvestorTrendEstimateWarning {
  reason: 'kis_credentials_missing' | 'kis_rate_limit' | 'kis_api_error' | 'parse_error';
  msg: string;
}

export interface LiveInvestorTrendEstimateResponse {
  code: string;
  trading_day: string;
  fetched_at_ms: number | null;
  rows: LiveInvestorTrendEstimateRow[];
  latest: LiveInvestorTrendEstimateRow | null;
  source: 'kis';
  status: 'ok' | 'empty' | 'error';
  data_warning: LiveInvestorTrendEstimateWarning | null;
}

export function liveInvestorTrendEstimateQueryOptions(code: string | null) {
  return {
    queryKey: ['live', 'investor-trend-estimate', code] as const,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      apiCall<LiveInvestorTrendEstimateResponse>(
        `/api/live/investor-trend-estimate?code=${code}`,
        { signal },
      ),
    enabled: !!code,
    staleTime: 60_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
    placeholderData: (prev: LiveInvestorTrendEstimateResponse | undefined) =>
      prev && prev.code === code ? prev : undefined,
  };
}

export function useLiveInvestorTrendEstimate(code: string | null) {
  return useQuery(liveInvestorTrendEstimateQueryOptions(code));
}
