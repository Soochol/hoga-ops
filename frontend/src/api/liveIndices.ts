import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { PAST_CANDLES_REFETCH_IN_BACKGROUND } from './livePastCandles';
import type { LiveIndexId } from '../live/liveInstrument';
import { todayKstYyyymmdd } from '../live/liveDateTime';
import { liveVenueRefetchInterval } from '../live/liveVenuePolicy';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import type { InvestorNetPoint } from './types';

export type LiveIndexInvestorScope = 'market' | 'index' | 'none';

type LiveIndexWire = {
  kind: 'index';
  id: LiveIndexId;
  label: string;
  investor_scope: LiveIndexInvestorScope;
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
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LiveIndexCandlesWarning {
  batch: string;
  date?: string;
  reason: 'rate_limit_upstream' | 'api_error' | 'invariant_violation' | 'index_minute_depth_limited';
  msg: string;
}

export interface LiveIndexCandlesResponse {
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
  const enabled = !!(indexId && from && to && from <= to);
  const refetchInterval = () => indexCandlesRefetchInterval(timeframe, to);
  return useQuery({
    queryKey: ['live', 'index-candles', indexId, timeframe, from, to] as const,
    queryFn: ({ signal }) =>
      apiCall<LiveIndexCandlesResponse>(
        `/api/live/index-candles?index_id=${indexId}&timeframe=${timeframe}&from=${from}&to=${to}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    refetchInterval,
    // 탭 가림 중 정지 방지 + focus refetch 를 같은 술어로 게이트 — 근거는
    // livePastCandles.ts 의 PAST_CANDLES_REFETCH_IN_BACKGROUND 주석 참조.
    refetchIntervalInBackground: PAST_CANDLES_REFETCH_IN_BACKGROUND,
    refetchOnWindowFocus: () => refetchInterval() !== false,
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
