import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { BrokerSeriesResponse } from './types';
import { useSourcePreferenceStore } from '../state/sourcePreference';

/**
 * Freshness for a day-anchored broker-series query, gated on whether `date`
 * is today (KST). Mirrors `range.ts` rangeFreshnessOptions: a today-inclusive
 * day refetches every 60s so the backend today-seam tail (parquet + live
 * buffer, #9) advances; a past day is immutable → staleTime Infinity.
 *
 * 60s < the 5-min Today-Promotion cadence, so the tail stays fresh well within
 * the seam-sizing invariant (retention > promote + refetch). `todayKst` is a
 * param (not imported) to keep this api-layer module free of a live-layer dep.
 */
export function brokerSeriesFreshness(
  date: string | null,
  todayKst: string | null,
): { staleTime: number; refetchInterval: number | false } {
  const includesToday = !!(date && todayKst && date >= todayKst);
  return includesToday
    ? { staleTime: 60_000, refetchInterval: 60_000 }
    : { staleTime: Infinity, refetchInterval: false };
}

/**
 * Fetch the day-anchored broker trajectories for one Stock-Date (ADR-0023).
 *
 * Mirrors useRange's pattern: react-query. Past Stock-Dates are immutable
 * (staleTime Infinity); a today-inclusive date refetches every 60s so the
 * backend today-seam tail advances (#9 — `brokerSeriesFreshness`). Deliberately
 * NOT useSpot — that hook is the cursor-keyed 10호가 debouncer. Day-scope data
 * lives next to useRange for visual clustering of the day-scope read paths.
 *
 * ADR-0039: threads `source_pref` from the global sourcePreference store into
 * the query string and key (mirroring useRange) so the 거래원 card resolves to
 * the SAME source as the chart on the same page — and so the backend today-seam
 * merge fires only when the resolved source is the live-capture source (#9).
 */
export function useBrokerSeriesForDay(
  code: string | null,
  date: string | null,
  todayKst: string | null = null,
) {
  const { staleTime, refetchInterval } = brokerSeriesFreshness(date, todayKst);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  return useQuery({
    queryKey: ['brokers/series', code, date, sourcePref] as const,
    queryFn: () =>
      apiCall<BrokerSeriesResponse>(
        `/api/brokers/series?code=${code}&date=${date}&source_pref=${sourcePref}`,
      ),
    enabled: code !== null && date !== null,
    staleTime,
    refetchInterval,
  });
}
