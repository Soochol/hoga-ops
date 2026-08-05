import type { LiveVenueOption } from '../state/liveVenue';
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
  /** 거래원은 별도 정책 없이 **venue 선택기를 따른다**(#1112). 쿼리 키에도 넣어야
   *  venue 를 바꿨을 때 캐시가 갈린다. */
  venue: LiveVenueOption,
) {
  return useQuery({
    queryKey: ['brokers/series', code, date, venue] as const,
    queryFn: () =>
      apiCall<BrokerSeriesResponse>(
        `/api/brokers/series?code=${code}&date=${date}&venue=${venue}`,
      ),
    enabled: code !== null && date !== null,
    staleTime: Infinity,
  });
}
