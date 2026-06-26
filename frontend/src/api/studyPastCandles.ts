import { useQuery } from '@tanstack/react-query';

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

export function useStudyPastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
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
  });
}

export function useStudyPastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
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
  });
}
