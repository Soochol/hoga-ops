import { fetchPastInvestorNet } from '../api/livePastInvestorNet';
import type { InvestorNetPoint } from '../api/types';
import { initialHistoricalDaysFor } from './liveDateTime';
import { useAccumulatedDailyRange } from './useAccumulatedDailyRange';

export interface InvestorNetResult {
  points: InvestorNetPoint[];
  isLoading: boolean;
  error: unknown;
}

// Stable (module-level) so the accumulator's merge useMemo deps don't churn.
const investorSlice = (code: string, from: string, to: string) =>
  fetchPastInvestorNet(code, from, to).then((r) => r.points);
const investorMs = (p: InvestorNetPoint) => p.t_ms;

/** Foreign/institution net-buy overlay source — 'D' (일봉) only. Thin wrapper
 * over `useAccumulatedDailyRange` so the overlay accumulates incrementally on
 * the SAME `historicalFromDate` cursor as the candles, instead of re-downloading
 * [cursor, today] of investor data on every settle step (the prior O(K²)). */
export function useInvestorNetAccumulated(
  code: string | null,
  today: string,
  historicalFromDate: string | null,
  enabled: boolean,
): InvestorNetResult {
  const r = useAccumulatedDailyRange<InvestorNetPoint>({
    code,
    baseKey: ['live', 'daily-investor', code],
    seedCalendarDays: initialHistoricalDaysFor('D'),
    today,
    historicalFromDate,
    enabled,
    fetchSlice: investorSlice,
    getMs: investorMs,
  });
  return { points: r.items, isLoading: r.isLoading, error: r.error };
}
