import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { liveVenueRefetchInterval } from '../live/liveVenuePolicy';
import type { LiveVenueOption } from '../state/liveVenue';

export interface LivePastDailyCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LivePastDailyCandlesWarning {
  batch: string;
  /** Present when the warning is per-row (e.g. invariant_violation); absent on
   * batch-level failures like kis_rate_limit / kis_api_error. */
  date?: string;
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation' | 'kis_rest_bypassed';
  msg: string;
}

export interface LivePastDailyCandlesResponse {
  code: string;
  from: string;
  to: string;
  venue?: LiveVenueOption;
  candles: LivePastDailyCandle[];
  cached_batches: string[];
  fresh_batches: string[];
  data_warnings: LivePastDailyCandlesWarning[];
}

export function useLivePastDailyCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
) {
  const enabled = !!(code && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'past-daily-candles', code, from, to, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}&venue=${venue}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval: () => liveVenueRefetchInterval(venue),
    // See livePastCandles.ts for the rationale — code+venue-aware placeholder
    // prevents the previous code/venue's candle count from leaking into
    // LiveChartRoot's initial-view effect on watchlist and venue switches.
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  });
}
