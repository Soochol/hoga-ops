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

/** Fetch a single [from, to] daily foreign/institution net-buy slice. KIS
 * investor-trade-by-stock-daily (FHPTJ04160001) walks back by date cursor
 * (ADR-0055). Dumb wire call — accumulation/today-split lives in
 * `useInvestorNetAccumulated` (via the shared `useAccumulatedDailyRange`), so a
 * daily scroll no longer re-downloads [cursor, today] of investor data each step. */
export function fetchPastInvestorNet(
  code: string,
  from: string,
  to: string,
): Promise<LivePastInvestorNetResponse> {
  return apiCall<LivePastInvestorNetResponse>(
    `/api/live/past-investor-net?code=${code}&from=${from}&to=${to}`,
  );
}
