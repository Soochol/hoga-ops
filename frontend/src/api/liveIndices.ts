import { isUsIndexId, US_MINUTE_TIMEFRAMES } from '../live/liveInstrument';
import { usDailyRefetchInterval, type UsDailyMetadata } from './usDailyCandles';
import { usIndexRefreshInterval } from './usIndexRefreshPolicy';
import { restoreUsIndexDailyHistory } from './usIndexDailyTransfer';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { indexRealtimeKey, overlayIndexCandles, type IndexRealtimeSession } from './indexRealtimeCandles';
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
  refresh_interval_ms?: number;
  current_daily_candle?: (LiveIndexCandle & { trading_date: string }) | null;
}

export interface LiveIndexCandlesResponse {
  daily_history_revision?: string;
  daily_history_unchanged?: boolean;
  minute_metadata?: UsMinuteMetadata;
  daily_metadata?: UsDailyMetadata;
  index_id: LiveIndexId;
  from: string;
  to: string;
  timeframe: LiveTimeframe;
  candles: LiveIndexCandle[];
  data_warnings: LiveIndexCandlesWarning[];
}

/** Query metadata, not part of the server wire model. */
type IndexCandleQueryData = LiveIndexCandlesResponse & { realtimeBaseMs?: number };

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

/** Match the backend's mutable D/W/M boundary. Completed periods never poll. */
export function indexCandlesRefetchInterval(
  timeframe: LiveTimeframe,
  to: string | null,
  todayKst: string = todayKstYyyymmdd(),
): 60_000 | false {
  const day = new Date(`${todayKst.slice(0, 4)}-${todayKst.slice(4, 6)}-${todayKst.slice(6, 8)}T00:00:00Z`);
  if (timeframe === 'W') day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  if (timeframe === 'M') day.setUTCDate(1);
  const boundary = day.toISOString().slice(0, 10).replaceAll('-', '');
  if (!to || to < boundary) return false;
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
  const refetchInterval = (query: { state: { data?: LiveIndexCandlesResponse; dataUpdateCount: number; error?: unknown } }) => {
    if (!isUsIndexId(indexId)) return indexCandlesRefetchInterval(timeframe, to);
    if (query.state.error) return 60_000;
    if (isMinuteTimeframe(timeframe) || query.state.data?.minute_metadata) {
      return usIndexRefreshInterval(query.state.data?.minute_metadata?.refresh_interval_ms);
    }
    return usDailyRefetchInterval(query.state.data?.daily_metadata, to ?? '', query.state.dataUpdateCount);
  };
  const realtime = useQuery<IndexRealtimeSession>({ queryKey: indexRealtimeKey(indexId), queryFn: skipToken });
  const queryKey = ['live', 'index-candles', indexId, timeframe, from, to] as const;
  const result = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const startedAtMs = Date.now();
      const compactDaily = isUsIndexId(indexId) && timeframe === 'D';
      // Capture the exact full baseline used by this request, even if its cache
      // entry is removed/replaced while the response is in flight.
      const previous = compactDaily ? queryClient.getQueryData<IndexCandleQueryData>(queryKey) : undefined;
      const revision = previous && !hasBlockingWarnings(previous) ? previous.daily_history_revision : undefined;
      const path = `/api/live/index-candles?index_id=${indexId}&timeframe=${timeframe}&from=${from}&to=${to}`;
      let response = await apiCall<LiveIndexCandlesResponse>(
        path + (revision ? `&daily_history_revision=${encodeURIComponent(revision)}` : ''),
        { signal },
      );
      if (compactDaily) {
        let restored = restoreUsIndexDailyHistory(response, previous, revision);
        if (!restored) {
          response = await apiCall<LiveIndexCandlesResponse>(path, { signal });
          restored = restoreUsIndexDailyHistory(response, undefined, undefined);
        }
        if (!restored) throw new Error('미국 지수 일봉 이력을 다시 불러오지 못했습니다.');
        response = restored;
        // A warning-preserving merge below may differ from the server prefix.
        // Never advertise that prefix as a valid baseline on the next request.
        if (hasBlockingWarnings(response)) response = { ...response, daily_history_revision: undefined };
      }
      if (!hasBlockingWarnings(response)) return { ...response, realtimeBaseMs: startedAtMs } as IndexCandleQueryData;
      // A degraded history request may contain no candles or only the older
      // chunk. Retain already fetched rows in this requested window; keep the
      // response's failure warnings so the backfill/retry policy still sees it.
      const byTime = new Map<number, LiveIndexCandle>();
      const cached = queryClient.getQueryCache().findAll({
        queryKey: ['live', 'index-candles', indexId, timeframe],
      }).sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
      let realtimeBaseMs = startedAtMs;
      for (const query of cached) {
        const previous = query.state.data as IndexCandleQueryData | undefined;
        if (previous?.index_id !== indexId || previous.timeframe !== timeframe) continue;
        realtimeBaseMs = Math.min(realtimeBaseMs, previous.realtimeBaseMs ?? 0);
        for (const row of previous.candles) {
          const date = realMsToYyyymmdd(row.t_ms);
          if (date >= response.from && date <= response.to) byTime.set(row.t_ms, row);
        }
      }
      if (byTime.size === 0) return { ...response, realtimeBaseMs } as IndexCandleQueryData;
      for (const row of response.candles) byTime.set(row.t_ms, row);
      return { ...response, realtimeBaseMs, candles: [...byTime.values()].sort((a, b) => a.t_ms - b.t_ms) };
    },
    enabled,
    staleTime: isUsIndexId(indexId) ? 2000 : 60_000,
    refetchInterval,
    // 탭 가림 중 정지 방지 + focus refetch 를 같은 술어로 게이트 — 근거는
    // livePastCandles.ts 의 PAST_CANDLES_REFETCH_IN_BACKGROUND 주석 참조.
    refetchIntervalInBackground: isUsIndexId(indexId) ? false : PAST_CANDLES_REFETCH_IN_BACKGROUND,
    ...(isUsIndexId(indexId) ? { retry: false } : {}),
    refetchOnWindowFocus: (query) => refetchInterval(query) !== false,
    placeholderData: (prev) => (prev && prev.index_id === indexId && prev.timeframe === timeframe ? prev : undefined),
  });
  const data = useMemo(() => result.data ? overlayIndexCandles(
    result.data, realtime.data, result.data.realtimeBaseMs ?? 0,
  ) : undefined, [result.data, realtime.data]);
  return { ...result, data };
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
