import { isUsIndexId, US_MINUTE_TIMEFRAMES } from '../live/liveInstrument';
import { usDailyRefetchInterval, type UsDailyMetadata } from './usDailyCandles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall } from './client';
import type { WireDataWarning } from './dataWarnings';
import { hasBlockingWarnings, PAST_CANDLES_REFETCH_IN_BACKGROUND } from './livePastCandles';
import type { LiveIndexId } from '../live/liveInstrument';
import { realMsToYyyymmdd, todayKstYyyymmdd } from '../live/liveDateTime';
import { liveVenueRefetchInterval } from '../live/liveVenuePolicy';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import type { InvestorNetPoint, InvestorNetUnit } from './types';

export type LiveIndexInvestorScope = 'market' | 'index' | 'none';

type LiveIndexWire = {
  kind: 'index';
  id: LiveIndexId;
  label: string;
  investor_scope: LiveIndexInvestorScope;
  market?: string;
  market_timezone?: string;
  supported_timeframes?: string[];
};

type LiveIndicesResponse = {
  indices: LiveIndexWire[];
};

export type LiveIndexEntry = {
  kind: 'index';
  id: LiveIndexId;
  label: string;
  investorScope: LiveIndexInvestorScope;
};

export interface LiveIndexCandle {
  trading_date?: string;
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Actual turnover for a calendar candle, in KRW. */
  trade_value_won?: number | null;
}

export interface LiveIndexCandlesWarning extends WireDataWarning {
  batch: string;
  date?: string;
  reason:
    | 'rate_limit_upstream'
    | 'api_error'
    | 'invariant_violation'
    | 'index_minute_depth_limited'
    // 거버너 용량 한계로 HTTP 500 대신 경고로 강등된 경우(`api.py::_kis_capacity_
    // degraded_batch_warning`). **백엔드가 내보내는데 이 union 에 오래 없었다** —
    // 사유가 변수로 들어가는 자리라 리터럴 스캔 가드가 못 봤고, ADR-0143 정리 중에
    // 드러났다(2026-08-10).
    | 'index_kis_capacity_overloaded';
  msg: string;
}

export interface UsMinuteMetadata {
  market_timezone: string;
  source: string;
  history_scope: string;
  delay_status: string;
  session_scope: string;
  available_from_ms: number | null;
  available_to_ms: number | null;
  last_successful_check_at_ms: number | null;
  refresh_status: UsDailyMetadata['refresh_status'];
  messages: string[];
}

export interface LiveIndexCandlesResponse {
  minute_metadata?: UsMinuteMetadata;
  daily_metadata?: UsDailyMetadata;
  index_id: LiveIndexId;
  from: string;
  to: string;
  timeframe: LiveTimeframe;
  candles: LiveIndexCandle[];
  data_warnings: LiveIndexCandlesWarning[];
}

export interface LiveIndexInvestorNetResponse {
  index_id: LiveIndexId;
  from: string;
  to: string;
  /** 'amt_eok' — 지수/시장 순매수는 **금액(억원)** 이다(#1119). 구백엔드는 미포함. */
  unit?: InvestorNetUnit;
  points: InvestorNetPoint[];
  data_warnings: LiveIndexCandlesWarning[];
}

function mapIndex(row: LiveIndexWire): LiveIndexEntry {
  return {
    kind: 'index',
    id: row.id,
    label: row.label,
    investorScope: row.investor_scope,
  };
}

/** 지수 캔들 폴링 주기 — 장중 **오늘 창의 분봉**만 돈다(그 외 false).
 *
 * 종전엔 staleTime 만 있고 타이머가 없어, 사용자가 탭을 만지지 않는 한 지수 차트가
 * 첫 로드 시점에 얼어붙었다(백엔드 index_minute_candles_cache 의 TTL 부재와 한 쌍 —
 * 서버만 만료시켜도 아무도 다시 묻지 않으면 새 봉은 붙지 않는다).
 *
 * - **분봉 한정**: D/W/M 은 백엔드 일봉 캐시(index_candles_cache)에 아직 오늘 TTL 이
 *   없어 재요청해도 같은 응답이 온다 — 폴링해봐야 헛 요청만 는다.
 * - **venue=KRX 고정**: 지수는 KRX 정규장에서만 산출된다(NXT/UN 세션에는 지수가 없다).
 * - `to < todayKst` 인 과거 전용 창은 불변이라 돌 이유가 없다.
 */
export function indexCandlesRefetchInterval(
  timeframe: LiveTimeframe,
  to: string | null,
  todayKst: string = todayKstYyyymmdd(),
): 60_000 | false {
  if (!to || !isMinuteTimeframe(timeframe) || to < todayKst) return false;
  return liveVenueRefetchInterval('KRX');
}

export function useLiveIndexCandles(
  indexId: LiveIndexId | null,
  timeframe: LiveTimeframe,
  from: string | null,
  to: string | null,
) {
  const queryClient = useQueryClient();
  const enabled = !!(indexId && from && to && from <= to) && (!isUsIndexId(indexId) || [...US_MINUTE_TIMEFRAMES, 'D', 'W', 'M'].includes(timeframe));
  const refetchInterval = (query: { state: { data?: LiveIndexCandlesResponse; dataUpdateCount: number } }) => isUsIndexId(indexId) && isMinuteTimeframe(timeframe) ? 60_000 : isUsIndexId(indexId) ? usDailyRefetchInterval(query.state.data?.daily_metadata, to ?? '', query.state.dataUpdateCount) : indexCandlesRefetchInterval(timeframe, to);
  return useQuery({
    queryKey: ['live', 'index-candles', indexId, timeframe, from, to] as const,
    queryFn: async ({ signal }) => {
      const response = await apiCall<LiveIndexCandlesResponse>(
        `/api/live/index-candles?index_id=${indexId}&timeframe=${timeframe}&from=${from}&to=${to}`,
        { signal },
      );
      if (!hasBlockingWarnings(response)) return response;
      // A degraded history request may contain no candles or only the older
      // chunk. Retain already fetched rows in this requested window; keep the
      // response's failure warnings so the backfill/retry policy still sees it.
      const byTime = new Map<number, LiveIndexCandle>();
      const cached = queryClient.getQueryCache().findAll({
        queryKey: ['live', 'index-candles', indexId, timeframe],
      }).sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
      for (const query of cached) {
        const previous = query.state.data as LiveIndexCandlesResponse | undefined;
        if (previous?.index_id !== indexId || previous.timeframe !== timeframe) continue;
        for (const row of previous.candles) {
          const date = realMsToYyyymmdd(row.t_ms);
          if (date >= response.from && date <= response.to) byTime.set(row.t_ms, row);
        }
      }
      if (byTime.size === 0) return response;
      for (const row of response.candles) byTime.set(row.t_ms, row);
      return { ...response, candles: [...byTime.values()].sort((a, b) => a.t_ms - b.t_ms) };
    },
    enabled,
    staleTime: 60_000,
    refetchInterval,
    // 탭 가림 중 정지 방지 + focus refetch 를 같은 술어로 게이트 — 근거는
    // livePastCandles.ts 의 PAST_CANDLES_REFETCH_IN_BACKGROUND 주석 참조.
    refetchIntervalInBackground: PAST_CANDLES_REFETCH_IN_BACKGROUND,
    refetchOnWindowFocus: (query) => refetchInterval(query) !== false,
    placeholderData: (prev) => (prev && prev.index_id === indexId && prev.timeframe === timeframe ? prev : undefined),
  });
}

export function useLiveIndexInvestorNet(
  indexId: LiveIndexId | null,
  from: string | null,
  to: string | null,
  enabledByCaller: boolean,
) {
  const enabled = !!(enabledByCaller && indexId && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'index-investor-net', indexId, from, to] as const,
    queryFn: ({ signal }) =>
      apiCall<LiveIndexInvestorNetResponse>(
        `/api/live/index-investor-net?index_id=${indexId}&from=${from}&to=${to}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.index_id === indexId ? prev : undefined),
  });
}

export function useLiveIndices() {
  return useQuery({
    queryKey: ['live-indices'],
    staleTime: 60 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const response = await apiCall<LiveIndicesResponse>('/api/live/indices', { signal });
      return response.indices.map(mapIndex);
    },
  });
}
