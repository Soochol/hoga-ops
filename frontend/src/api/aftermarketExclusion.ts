import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { LiveVenueOption } from '../state/liveVenue';
import { isKrxAftermarketWindow } from '../util/stockSessions';
import { unixMsToKSTDate } from '../util/time';

export type AftermarketExclusionReason = 'etf' | 'etn' | 'investment_warning' | 'investment_risk'
  | 'administrative' | 'liquidation' | 'short_term_overheat' | 'investment_caution_issue'
  | 'low_liquidity' | 'abnormal_surge' | 'investment_caution';
export type AftermarketExclusionStatus = 'checked' | 'unavailable' | 'error' | 'inactive';
export type AftermarketExclusionSource = 'symbol_master' | 'kiwoom_ka10100';
export interface AftermarketExclusionResponse {
  code: string;
  date: string;
  status: AftermarketExclusionStatus;
  reasons: AftermarketExclusionReason[];
  checked_at_ms: number | null;
  source: AftermarketExclusionSource | null;
}

/** Shared by both book windows. Never reuse another code/day or a failed recheck. */
export function useAftermarketExclusion(code: string, venue: LiveVenueOption, nowMs: number, live: boolean) {
  const date = unixMsToKSTDate(nowMs);
  const enabled = live && venue === 'KRX' && isKrxAftermarketWindow(nowMs);
  const query = useQuery({
    queryKey: ['live', 'aftermarket-exclusion', code, date],
    queryFn: ({ signal }) => apiCall<AftermarketExclusionResponse>(
      `/api/live/aftermarket-exclusion?code=${encodeURIComponent(code)}`, { signal },
    ),
    enabled, staleTime: 30_000, refetchInterval: enabled ? 60_000 : false, retry: false,
  });
  const data = query.data;
  return enabled && !query.isError && data?.code === code && data.date === date
    && data.status === 'checked' && data.checked_at_ms != null
    && nowMs - data.checked_at_ms >= -5_000 && nowMs - data.checked_at_ms < 120_000 ? data : undefined;
}
