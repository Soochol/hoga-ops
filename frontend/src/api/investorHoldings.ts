import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type HoldingsSource = 'kiwoom_ka10008';
export type HoldingsWarningReason = 'unavailable' | 'api_error' | 'invalid_row' | 'page_budget' | 'cursor_stalled';
export interface HoldingsObservation { date: string; t_ms: number; quantity_shares: number | null; ratio_pct: number | null }
export interface HoldingsWarning { reason: HoldingsWarningReason; message: string }
export interface InvestorHoldingsResponse {
  code: string; from: string; to: string; source: HoldingsSource; provider_scope: string; institution_supported: false;
  observations: HoldingsObservation[]; oldest_observed_date: string | null; latest_observed_date: string | null;
  pages_observed: number; pagination_complete: boolean; exhausted: boolean; partial: boolean; data_warnings: HoldingsWarning[];
}
export function useInvestorHoldings(code: string | null, from: string, to: string) {
  return useQuery({
    queryKey: ['live', 'investor-holdings', code, from, to],
    enabled: Boolean(code && from && to && from <= to),
    queryFn: async ({ signal }) => {
      const response = await apiCall<InvestorHoldingsResponse>(`/api/live/investor-holdings?code=${code}&from=${from}&to=${to}`, { signal });
      if (response.code !== code || response.from !== from || response.to !== to || response.source !== 'kiwoom_ka10008'
        || response.provider_scope !== 'KRX' || response.institution_supported !== false) throw new Error('보유 자료 응답 기준이 다릅니다');
      return response;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
