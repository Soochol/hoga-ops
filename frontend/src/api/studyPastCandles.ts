import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import { apiCall } from './client';
import type {
  LivePastCandlesResponse,
  LivePastCandlesWarning,
} from './livePastCandles';
import type {
  LivePastDailyCandlesResponse,
  LivePastDailyCandlesWarning,
} from './livePastDailyCandles';
import type { LiveVenueOption } from '../state/liveVenue';

export type { LivePastCandlesWarning, LivePastDailyCandlesWarning };

export const STUDY_PAST_CANDLES_STALE_TIME = Infinity;

export type StudyPastCandlesQueryKey = readonly [
  'study',
  'past-candles',
  string | null,
  string | null,
  string | null,
  LiveVenueOption,
];

export type StudyPastDailyCandlesQueryKey = readonly [
  'study',
  'past-daily-candles',
  string | null,
  string | null,
  string | null,
  LiveVenueOption,
];

export function studyPastCandlesQueryOptions(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
): UseQueryOptions<LivePastCandlesResponse, Error, LivePastCandlesResponse, StudyPastCandlesQueryKey> {
  const enabled = !!(code && from && to && from <= to);
  return {
    queryKey: ['study', 'past-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: STUDY_PAST_CANDLES_STALE_TIME,
    refetchInterval: false,
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  };
}

export function studyPastDailyCandlesQueryOptions(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
): UseQueryOptions<LivePastDailyCandlesResponse, Error, LivePastDailyCandlesResponse, StudyPastDailyCandlesQueryKey> {
  const enabled = !!(code && from && to && from <= to);
  return {
    queryKey: ['study', 'past-daily-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: STUDY_PAST_CANDLES_STALE_TIME,
    refetchInterval: false,
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  };
}

export function useStudyPastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  return useQuery(studyPastCandlesQueryOptions(code, from, to, venue));
}

export function useStudyPastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  return useQuery(studyPastDailyCandlesQueryOptions(code, from, to, venue));
}
