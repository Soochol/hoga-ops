import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { BrokerSeriesResponse } from './types';

/**
 * Fetch the day-anchored broker trajectories for one Stock-Date (ADR-0023).
 *
 * Mirrors useRange's pattern: react-query, staleTime: Infinity (captured
 * Stock-Dates are immutable). Deliberately NOT useSpot — that hook is the
 * cursor-keyed, rapid-scrub debouncer used by the 10호가 card. Day-scope
 * data lives next to useRange for visual clustering of the two day-scope
 * read paths in this directory.
 */
export function useBrokerSeriesForDay(
  code: string | null,
  date: string | null,
) {
  return useQuery({
    queryKey: ['brokers/series', code, date] as const,
    queryFn: () =>
      apiCall<BrokerSeriesResponse>(
        `/api/brokers/series?code=${code}&date=${date}`,
      ),
    enabled: code !== null && date !== null,
    staleTime: Infinity,
  });
}
