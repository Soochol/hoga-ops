import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { PAST_CANDLES_REFETCH_IN_BACKGROUND } from './livePastCandles';
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
   * batch-level failures like rate_limit_upstream / api_error. */
  date?: string;
  reason: 'rate_limit_upstream' | 'api_error' | 'invariant_violation' | 'rest_bypassed';
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
    // 탭 가림(document hidden) 구간의 D/W/M 갱신 정지 방지 — 전체 근거는
    // livePastCandles.ts 의 PAST_CANDLES_REFETCH_IN_BACKGROUND 주석 참조.
    // focus refetch 는 refetchInterval 과 **같은 술어**로 게이트한다: staleTime 이
    // 60s 고정이라 게이트 없이 true 로 두면 장 마감 후에도 탭 복귀마다 KIS 호출이
    // 창 수만큼 나간다(일봉은 장외에 변할 게 없다).
    refetchIntervalInBackground: PAST_CANDLES_REFETCH_IN_BACKGROUND,
    refetchOnWindowFocus: () => liveVenueRefetchInterval(venue) !== false,
    // See livePastCandles.ts for the rationale — code+venue-aware placeholder
    // prevents the previous code/venue's candle count from leaking into
    // LiveChartRoot's initial-view effect on watchlist and venue switches.
    placeholderData: (prev) => (prev && prev.code === code && (prev.venue ?? 'KRX') === venue ? prev : undefined),
  });
}
