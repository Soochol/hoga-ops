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
  /**
   * 백엔드 `batched_daily_walkback` 이 실을 수 있는 사유 전부(ADR-0004 손 미러).
   *
   * 벤더 실패의 사유는 `error_policy.classify_live_error` 가 정하므로, **거기 팔이
   * 늘면 여기도 늘어야 한다**. 이 미러는 wire 계약 가드가 못 본다 — 경고가 BE 의
   * `Literal` 이 아니라 평범한 dict 라서다. 그래서 드리프트가 조용하다:
   * `transport_error` 는 백엔드가 내보내기 시작한 뒤로도 한동안 여기 없었고,
   * `liveDataWarnings.ts` 가 `reason: string` 을 받는 덕에 런타임은 멀쩡했다.
   *
   * `unexpected_error` 는 일부러 뺐다 — walkback 이 벤더 예외 타입만 잡으므로
   * 이 경로에서는 도달할 수 없다. 도달 가능한 값만 적는 것이 미러의 값어치다.
   */
  reason:
    | 'rate_limit_upstream'
    | 'transport_error'
    | 'api_error'
    | 'auth_error'
    | 'batch_limit_exceeded'
    | 'invariant_violation'
    | 'rest_bypassed';
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
