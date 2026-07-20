import { useQuery, useQueryClient, type QueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { apiCall } from './client';
import type { RangeBundle, Timeframe } from './types';
import {
  buildRangeBundleRequest,
  RANGE_QUERY_KEY_FROM_DATE_INDEX,
  RANGE_QUERY_KEY_VDIST_PRICE_MAX_INDEX,
  RANGE_QUERY_KEY_VDIST_PRICE_MIN_INDEX,
  rangePlaceholderData,
  type RangeBundleRequestInput,
  type RangeQueryKey,
  type RangeRequestOptions,
} from './rangeRequest';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { SourcePreference } from '../state/sourcePreference';
import { useLivePromotionStore } from '../state/livePromotion';

export { buildRangeBundleRequest, rangePlaceholderData };
export type { RangeBundleRequest, RangeBundleRequestInput, RangeQueryKey, RangeRequestOptions } from './rangeRequest';

/**
 * Refetch cadence for a today-inclusive range query (ms).
 *
 * Synced with backend `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S` (default 300s =
 * 5 min, app.py:121). /api/range reads PROMOTED disk data (hogaplay parquet),
 * which only changes once per Today Promotion cycle — refetching faster than
 * the promotion cadence is wasted work; refetching slower would let `pastMaxQrT`
 * fall behind. This is the frontend half of spec §6 "경계 우측 전진": it advances
 * pastMaxQrT so buildLiveBundle's `incrementalQR.filter(p => p.t > pastMaxQrT)`
 * keeps sourcing today's hoga seam from disk as the boundary moves right.
 *
 * Seam-sizing invariant (review C1, Task 12): the in-memory live buffer
 * (LiveSnapshotBuffer, 15min retention) must cover the worst-case staleness of
 * pastMaxQrT, which lags `now` by up to promotion_period + refetch_period
 * (data promoted ≤5min ago, read ≤5min ago = ~10min). 15min > 5+5 with margin,
 * so the [pastMaxQrT … now] window is always bridged by the buffer — no hole.
 */
export const TODAY_RANGE_REFETCH_MS = 5 * 60_000;

/** Pure react-query freshness options for a /api/range query, gated on whether
 * the requested range includes today (KST). Extracted so both branches are
 * unit-testable without a react-query harness.
 *
 * - Today-inclusive (`to >= todayKst`): 5-min refetch (see TODAY_RANGE_REFETCH_MS)
 *   so pastMaxQrT advances with each Today Promotion cycle.
 * - Past-only (`to < todayKst`, or `todayKst`/`to` unknown): staleTime Infinity,
 *   no refetch — captured Stock-Dates are immutable historical data. This keeps
 *   non-live callers (capture/replay backfill) on the original frozen behavior;
 *   the refetch must NOT leak into them. */
export function rangeFreshnessOptions(
  to: string | null,
  todayKst: string | null,
): { staleTime: number; refetchInterval: number | false } {
  const includesToday = !!(to && todayKst && to >= todayKst);
  return includesToday
    ? { staleTime: TODAY_RANGE_REFETCH_MS, refetchInterval: TODAY_RANGE_REFETCH_MS }
    : { staleTime: Infinity, refetchInterval: false };
}

/** Whether an at-rest today-range delta should refetch now.
 *
 * Three triggers: (1) never fetched, (2) the 5-min polling fallback elapsed,
 * (3) WS 푸시 승격 무효화 — a promotion_completed stamp landed *after* our last
 * fetch. Convergence/termination (the property that matters): once the refetch
 * lands, `previousUpdatedAtMs` (react-query dataUpdatedAt) advances past
 * `lastPromotionMs`, so trigger (3) goes false and a stale stamp cannot
 * re-trigger — mirrors the past-candles bumpMergedVersion termination guard. */
export function liveRangeRefreshDue(
  previousUpdatedAtMs: number | undefined,
  nowMs: number,
  lastPromotionMs: number,
): boolean {
  if (!previousUpdatedAtMs) return true;
  if (nowMs >= previousUpdatedAtMs + TODAY_RANGE_REFETCH_MS) return true;
  return lastPromotionMs > 0 && lastPromotionMs > previousUpdatedAtMs;
}

export type RangeBundleQueryOptionsInput = RangeBundleRequestInput;

export function rangeBundleQueryOptions(
  input: RangeBundleQueryOptionsInput,
): UseQueryOptions<RangeBundle, Error, RangeBundle, RangeQueryKey> {
  const request = buildRangeBundleRequest(input);
  const { staleTime, refetchInterval } = rangeFreshnessOptions(input.to, request.todayKst);
  return {
    queryKey: request.queryKey,
    queryFn: ({ signal }) =>
      apiCall<RangeBundle>(request.url, { signal }),
    enabled: request.enabled,
    staleTime,
    refetchInterval,
    placeholderData: (prev, previousQuery) =>
      rangePlaceholderData(prev, request.queryKey, previousQuery?.queryKey),
  };
}

export interface RangeDeltaPlan {
  enabled: boolean;
  requestInput: RangeBundleRequestInput;
  canReusePrevious: boolean;
  servePrevious: boolean;
  usePlaceholderData: boolean;
  forceRerenderAfterMerge: boolean;
  blocksHistoricalExtension: boolean;
  scheduleRefreshAtMs: number | null;
  identity: string;
}

function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  ));
  d.setUTCDate(d.getUTCDate() + days);
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * 라이브 델타 요청 1회의 최대 달력일 폭 (콜드 시드 + 좌측 확장 타일 공통).
 *
 * 콜드(캐시된 previous 없음) 딥 뷰포트는 종전엔 [from, 오늘] 전체를 한 방에
 * 요청했다 — 2개월 콜드 범위 실측 ~52s 블로킹(016360, 2026-07-11 슬로그).
 * 시드 창(최근 CHUNK일)부터 받고 나머지는 기존 좌측-확장 델타 경로가 청크
 * 단위로 워크백한다(분봉 청크 워크백 PR#455 패턴의 range 이식). 각 청크가
 * 랜딩되는 렌더에서 isHistoricalDeltaFetching이 하강해 점진 렌더가 되고,
 * merge가 previous.from_date를 전진시켜 다음 청크를 자기구동으로 당긴다.
 * 빈 범위(주말 청크)도 백엔드가 요청 경계를 에코하므로(_empty_range_bundle)
 * from_date가 전진해 종결이 보장된다.
 */
export const LIVE_RANGE_CHUNK_DAYS = 7;

type LiveRangeDeltaMode = 'sidecar' | 'hoga';

/** 델타 identity에서 중립화하는 queryKey 인덱스.
 *
 * vdist 가격 경계(10·11)는 오늘 세션 고저가에서 파생돼(useLiveBundle의
 * candlePriceRange) 신고/신저가·60초 폴마다 흔들리는데, identity에 남겨두면
 * 매번 "콜드"로 오인해 시드+워크백을 재실행한다(2026-07-11 슬로그 churn).
 * 제외해도 정합이 깨지지 않는 근거: 백엔드는 per-day 로컬 캔들 범위를
 * 우선하고(bundle.py `price_range = candle_price_range or supplied…`) 요청
 * 경계는 캔들 없는 날의 폴백일 뿐이라 과거일 결과가 이 경계와 무관하다.
 * 오늘 슬라이스는 at-rest refresh(case 2)가 새 경계를 URL에 실어 나르며
 * TODAY_RANGE_REFETCH_MS 주기로 수렴한다. */
const LIVE_RANGE_IDENTITY_NEUTRAL_INDICES = [
  RANGE_QUERY_KEY_FROM_DATE_INDEX,
  RANGE_QUERY_KEY_VDIST_PRICE_MIN_INDEX,
  RANGE_QUERY_KEY_VDIST_PRICE_MAX_INDEX,
] as const;

function liveRangeDeltaIdentity(input: RangeBundleRequestInput): string {
  const request = buildRangeBundleRequest(input);
  const key = [...request.queryKey];
  for (const index of LIVE_RANGE_IDENTITY_NEUTRAL_INDICES) key[index] = null;
  return JSON.stringify(key);
}

function liveRangeDeltaIdentityFromKey(queryKey: QueryKey): string | null {
  if (!Array.isArray(queryKey) || queryKey[0] !== 'range') return null;
  const key = [...queryKey];
  for (const index of LIVE_RANGE_IDENTITY_NEUTRAL_INDICES) key[index] = null;
  return JSON.stringify(key);
}

/** 라이브 델타 병합본을 1-샷 복원하기 위한 canonical React Query 키. 실 청크 요청
 * 키(`['range', code, from, to, …]`)와 겹치지 않는 전용 네임스페이스('live'/
 * 'range-merged')를 써서 두 가지를 얻는다:
 *  ① /study 의 useStudyRangeCacheEviction(`removeQueries({queryKey:['range']})`)이
 *     prefix 불일치로 이 병합본을 축출하지 못한다 — /live 웜 캐시가 /study 왕복에도
 *     생존.
 *  ② main.tsx 의 setQueryDefaults(['live','range-merged'], gcTime 2h)를 상속해
 *     전역 30분보다 오래 살아 "점심 후 복귀"에서 네트워크 재-워크백 없이 복원.
 * identity(=liveRangeDeltaIdentity)가 이미 code·to·bucketMs·mode·options 를 담은
 * JSON이라 그 자체가 캐시 축 — code/tf/mode별 분리가 자동이고 identity당 1개만
 * 자기-덮어쓰므로 파편화가 없다. 캔들 mergedPastCandlesKey(livePastCandles.ts)의
 * range 판(版). */
export function mergedLiveRangeKey(
  identity: string,
): readonly ['live', 'range-merged', string] {
  return ['live', 'range-merged', identity] as const;
}

/** canonical 병합본 정확-키 O(1) 복원. 실키 스캔(cachedLiveRangeDeltaPrevious)의
 * 폴백이 아니라 선행 경로 — 개별 청크 키가 gc돼도(전역 30분) 병합본은 2h 살아
 * 있으므로 최광폭을 잃지 않는다. */
function restoredLiveRangeMerged(
  queryClient: QueryClient,
  identity: string,
): { data: RangeBundle; updatedAtMs: number } | undefined {
  const key = mergedLiveRangeKey(identity);
  const data = queryClient.getQueryData<RangeBundle>(key);
  if (!data) return undefined;
  return { data, updatedAtMs: queryClient.getQueryState(key)?.dataUpdatedAt ?? 0 };
}

function cachedLiveRangeDeltaPrevious(
  queryClient: QueryClient,
  input: RangeBundleRequestInput,
  identity: string,
): { data: RangeBundle; updatedAtMs: number } | undefined {
  if (!input.code || !input.to) return undefined;
  let best: { data: RangeBundle; updatedAtMs: number } | undefined;
  for (const [queryKey, data] of queryClient.getQueriesData<RangeBundle>({ queryKey: ['range', input.code] })) {
    if (!data || data.code !== input.code || data.to_date !== input.to) continue;
    if (liveRangeDeltaIdentityFromKey(queryKey) !== identity) continue;
    if (!best || data.from_date < best.data.from_date) {
      best = { data, updatedAtMs: queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0 };
    }
  }
  return best;
}

function planLiveRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
  previousIdentity?: string,
  previousUpdatedAtMs?: number,
  nowMs: number = Date.now(),
  mode: LiveRangeDeltaMode = 'sidecar',
  // Client-clock stamp of the last promotion_completed event for this code
  // (0 = none). Added as a trailing param so the plan* wrappers stay unchanged.
  lastPromotionMs: number = 0,
): RangeDeltaPlan {
  const identity = liveRangeDeltaIdentity(input);
  const request = buildRangeBundleRequest(input);
  const options = input.options ?? {};
  const fullInput = { ...input };
  const isLiveDeltaRequest = !!(
    request.enabled &&
    options.mode === mode &&
    options.volumeDistributionCutoffMs == null &&
    input.todayKst &&
    input.to &&
    input.to >= input.todayKst
  );

  if (!isLiveDeltaRequest || !input.code || !input.from || !input.to) {
    return {
      enabled: request.enabled,
      requestInput: fullInput,
      canReusePrevious: false,
      servePrevious: false,
      usePlaceholderData: true,
      forceRerenderAfterMerge: false,
      blocksHistoricalExtension: false,
      scheduleRefreshAtMs: null,
      identity,
    };
  }

  const sameIdentity = !!(
    previous &&
    previous.code === input.code &&
    previous.to_date === input.to &&
    previousIdentity === identity
  );

  if (sameIdentity && previous.from_date <= input.from) {
    // previous(캐시된 병합본)가 요청 창 [input.from, to]를 완전히 덮는다:
    //  - `=== input.from`: 경계 정확히 일치.
    //  - `<  input.from`: previous 가 더 깊다. 웜 복귀 경로가 여기 걸린다 —
    //    setActiveCode/setCandleTimeframe 이 historicalFromDate 를 null 로 리셋해
    //    input.from 이 기본 시드 창으로 좁아지지만, 캐시에는 이전 세션에 좌측 팬으로
    //    확장해 둔 딥 번들이 남아 있다(cachedLiveRangeDeltaPrevious 가 from_date
    //    최소인 것을 집어 온다).
    // 두 하위 케이스 모두 오늘-델타(from=to=today) refresh 로만 수렴시키고 딥
    // 병합본을 계속 서빙한다. 종전엔 `<` 하위 케이스를 좁은 창 통짜 재요청 +
    // servePrevious:false 로 폐기해, 캔들은 딥(livePastCandles.ts:202 가
    // previous.from<=from 을 딥 서빙 + 오늘-델타로 처리)인데 지표만 시드 창으로
    // 얕아지는 비대칭 + 재요청 동안 지표 pane 빈 플래시를 만들었다. canReusePrevious
    // 로 mergeRangeBundles(previous, 오늘응답) 하면 from_date=min 이라 딥 유지.
    const nextRefreshAtMs = previousUpdatedAtMs ? previousUpdatedAtMs + TODAY_RANGE_REFETCH_MS : 0;
    const refreshDue = liveRangeRefreshDue(previousUpdatedAtMs, nowMs, lastPromotionMs);
    return {
      enabled: refreshDue,
      requestInput: { ...input, from: input.to, to: input.to },
      canReusePrevious: true,
      servePrevious: true,
      usePlaceholderData: true,
      forceRerenderAfterMerge: false,
      blocksHistoricalExtension: false,
      scheduleRefreshAtMs: refreshDue ? null : nextRefreshAtMs,
      identity,
    };
  }

  if (sameIdentity && input.from < previous.from_date) {
    // 좌측 확장 타일 — LIVE_RANGE_CHUNK_DAYS로 캡. 갭이 크면(콜드 시드 직후,
    // 딥 팬) 청크가 랜딩→merge→plan 재계산을 반복하며 input.from까지 워크백.
    const tileTo = addDays(previous.from_date, -1);
    const tileFrom = maxDate(input.from, addDays(tileTo, -(LIVE_RANGE_CHUNK_DAYS - 1)));
    return {
      enabled: true,
      requestInput: { ...input, from: tileFrom, to: tileTo },
      canReusePrevious: true,
      servePrevious: true,
      usePlaceholderData: true,
      forceRerenderAfterMerge: true,
      blocksHistoricalExtension: true,
      scheduleRefreshAtMs: null,
      identity,
    };
  }

  // 콜드(또는 identity 전환) — 통짜 [from, to] 대신 최근 CHUNK일 시드만 요청.
  // 시드가 랜딩되면 위의 확장-타일 분기가 나머지를 청크 워크백한다.
  const seedFrom = maxDate(input.from, addDays(input.to, -(LIVE_RANGE_CHUNK_DAYS - 1)));
  return {
    enabled: true,
    requestInput: seedFrom > input.from ? { ...input, from: seedFrom } : fullInput,
    canReusePrevious: false,
    servePrevious: false,
    usePlaceholderData: true,
    forceRerenderAfterMerge: false,
    blocksHistoricalExtension: true,
    scheduleRefreshAtMs: null,
    identity,
  };
}

export function planSidecarRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
  previousIdentity?: string,
): RangeDeltaPlan {
  return planLiveRangeDelta(input, previous, previousIdentity, undefined, undefined, 'sidecar');
}

export function planHogaRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
  previousIdentity?: string,
): RangeDeltaPlan {
  return planLiveRangeDelta(input, previous, previousIdentity, undefined, undefined, 'hoga');
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string, compare: (a: T, b: T) => number): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return Array.from(byKey.values()).sort(compare);
}

function rangeInvariantKey(item: { date: string; violations?: unknown; warnings?: unknown }): string {
  return `${item.date}|${JSON.stringify(item.violations ?? item.warnings ?? [])}`;
}

function coveredDates(bundle: RangeBundle): Set<string> {
  return new Set(bundle.segments.map((segment) => segment.date));
}

function outsideCoveredDates<T extends { date: string }>(items: T[], dates: Set<string>): T[] {
  if (dates.size === 0) return items;
  return items.filter((item) => !dates.has(item.date));
}

function outsideCoveredSegment(pointMs: number, bundle: RangeBundle): boolean {
  if (bundle.segments.length === 0) return true;
  return !bundle.segments.some((segment) =>
    pointMs >= segment.session_open_ms && pointMs <= segment.session_close_ms,
  );
}

export function mergeRangeBundles(previous: RangeBundle, next: RangeBundle): RangeBundle {
  const nextDates = coveredDates(next);
  const previousCandles = previous.candles.filter((candle) => outsideCoveredSegment(candle.ts_ms, next));
  const previousQuoteRatioPoints = previous.quote_ratio.points.filter((point) => outsideCoveredSegment(point.t, next));
  const previousFillStrengthPoints = previous.fill_strength.points.filter((point) => outsideCoveredSegment(point.t, next));
  const previousBrokerLateEntries = previous.broker_late_entries.filter((entry) => outsideCoveredSegment(entry.t_ms, next));
  const previousProgramTradePoints = (previous.program_trade?.points ?? []).filter((point) => outsideCoveredSegment(point.t, next));
  return {
    ...next,
    from_date: previous.from_date < next.from_date ? previous.from_date : next.from_date,
    to_date: previous.to_date > next.to_date ? previous.to_date : next.to_date,
    segments: uniqueBy(
      [...previous.segments, ...next.segments],
      (s) => s.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    candles: uniqueBy(
      [...previousCandles, ...next.candles],
      (c) => String(c.ts_ms),
      (a, b) => a.ts_ms - b.ts_ms,
    ),
    quote_ratio: {
      bucket_ms: next.quote_ratio.bucket_ms,
      points: uniqueBy(
        [...previousQuoteRatioPoints, ...next.quote_ratio.points],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    fill_strength: {
      bucket_ms: next.fill_strength.bucket_ms,
      points: uniqueBy(
        [...previousFillStrengthPoints, ...next.fill_strength.points],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    excluded_dates: uniqueBy(
      [...outsideCoveredDates(previous.excluded_dates ?? [], nextDates), ...(next.excluded_dates ?? [])],
      rangeInvariantKey,
      (a, b) => rangeInvariantKey(a).localeCompare(rangeInvariantKey(b)),
    ),
    data_warnings: uniqueBy(
      [...outsideCoveredDates(previous.data_warnings ?? [], nextDates), ...(next.data_warnings ?? [])],
      rangeInvariantKey,
      (a, b) => rangeInvariantKey(a).localeCompare(rangeInvariantKey(b)),
    ),
    ask_peaks: uniqueBy(
      [...outsideCoveredDates(previous.ask_peaks, nextDates), ...next.ask_peaks],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    bid_peaks: uniqueBy(
      [...outsideCoveredDates(previous.bid_peaks ?? [], nextDates), ...(next.bid_peaks ?? [])],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    broker_late_entries: uniqueBy(
      [...previousBrokerLateEntries, ...next.broker_late_entries],
      (e) => `${e.t_ms}|${e.broker}|${e.side}`,
      (a, b) => a.t_ms - b.t_ms,
    ),
    trade_volume_pocs: uniqueBy(
      [...outsideCoveredDates(previous.trade_volume_pocs ?? [], nextDates), ...(next.trade_volume_pocs ?? [])],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    // Per-bucket (not per-date) merge like fill_strength.points: dedup by t_ms,
    // ascending. uniqueBy keeps the LAST occurrence, so [previous, next] → next
    // (latest) wins per overlapping bucket.
    depth_heatmap: uniqueBy(
      [...(previous.depth_heatmap ?? []), ...(next.depth_heatmap ?? [])],
      (p) => String(p.t_ms),
      (a, b) => a.t_ms - b.t_ms,
    ),
    depth_delta: uniqueBy(
      [...(previous.depth_delta ?? []), ...(next.depth_delta ?? [])],
      (p) => String(p.t_ms),
      (a, b) => a.t_ms - b.t_ms,
    ),
    volume_distributions: uniqueBy(
      [...outsideCoveredDates(previous.volume_distributions, nextDates), ...next.volume_distributions],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    program_trade: {
      source: next.program_trade?.source ?? previous.program_trade?.source,
      points: uniqueBy(
        [...previousProgramTradePoints, ...(next.program_trade?.points ?? [])],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
  };
}

/**
 * Fetch a Stock-Date Range bundle (ADR-0013, ADR-0014).
 *
 * Uses apiCall helper and an optional priceRange parameter that drives
 * VolumeProfileOverlay's visible-price filtering.
 *
 * Freshness (`rangeFreshnessOptions`): past-only ranges are immutable historical
 * data → staleTime Infinity, no refetch. A today-inclusive range (caller passes
 * `todayKst` and `to >= todayKst`, i.e. /live) refetches every 5 min so the
 * today hoga seam (`pastMaxQrT`) advances with Today Promotion instead of
 * freezing at load — without this, Task 12's 15-min buffer leaves a growing
 * hole between the frozen pastMaxQrT and now (review C1).
 *
 * ADR-0039: threads `source_pref` from the global sourcePreference store
 * into the query string and query key so different source preferences get
 * independent cache entries.
 */
export function useRange(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: RangeRequestOptions,
  sourcePrefOverride?: SourcePreference,
) {
  const storedSourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const sourcePref = sourcePrefOverride ?? storedSourcePref;
  return useQuery(rangeBundleQueryOptions({
    code,
    from,
    to,
    timeframe,
    priceRange,
    todayKst,
    sourcePref,
    options,
  }));
}

function useLiveRangeDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: RangeRequestOptions,
  sourcePrefOverride?: SourcePreference,
  mode: LiveRangeDeltaMode = 'sidecar',
) {
  const storedSourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const sourcePref = sourcePrefOverride ?? storedSourcePref;
  const queryClient = useQueryClient();
  const mergedRef = useRef<{ identity: string; data: RangeBundle; updatedAtMs: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [, forceRerender] = useReducer((value: number) => value + 1, 0);
  const baseInput = useMemo<RangeBundleRequestInput>(
    () => ({ code, from, to, timeframe, priceRange, todayKst, sourcePref, options }),
    [code, from, to, timeframe, priceRange, todayKst, sourcePref, options],
  );
  const merged = mergedRef.current;
  const identity = liveRangeDeltaIdentity(baseInput);
  const previousIdentity = merged?.identity === identity ? merged.identity : identity;
  // 복원 우선순위: 같은 마운트 mergedRef → canonical 병합본(O(1), gcTime 2h) →
  // 실키 스캔(구버전 캐시·동시 창 폴백). canonical 이 리마운트·/study 왕복·gcTime
  // 초과를 커버하는 주 경로다.
  const cachedPrevious = merged && merged.identity === identity
    ? merged
    : restoredLiveRangeMerged(queryClient, identity)
      ?? cachedLiveRangeDeltaPrevious(queryClient, baseInput, identity);
  const previous = cachedPrevious?.data;
  // Per-code promotion stamp — updating it re-renders only this code's hooks,
  // recomputing the plan so refreshDue fires the moment disk data advances.
  const lastPromotionMs = useLivePromotionStore((s) => (code ? s.byCode[code] ?? 0 : 0));
  const plan = useMemo(
    () => planLiveRangeDelta(baseInput, previous, previousIdentity, cachedPrevious?.updatedAtMs, nowMs, mode, lastPromotionMs),
    [baseInput, previous, previousIdentity, cachedPrevious?.updatedAtMs, nowMs, mode, lastPromotionMs],
  );
  const request = buildRangeBundleRequest(plan.requestInput);
  const { staleTime, refetchInterval } = rangeFreshnessOptions(plan.requestInput.to, request.todayKst);
  const initialData = plan.servePrevious && !plan.canReusePrevious ? previous : undefined;

  const query = useQuery<RangeBundle, Error, RangeBundle, RangeQueryKey>({
    queryKey: request.queryKey,
    queryFn: ({ signal }) => apiCall<RangeBundle>(request.url, { signal }),
    enabled: plan.enabled,
    staleTime,
    refetchInterval,
    placeholderData: plan.usePlaceholderData
      ? (prev, previousQuery) =>
          rangePlaceholderData(prev, request.queryKey, previousQuery?.queryKey)
      : undefined,
    ...(initialData ? { initialData } : {}),
  });

  const data = useMemo(() => {
    if (plan.servePrevious && previous && !query.data) return previous;
    if (!query.data) return undefined;
    if (query.isPlaceholderData) return previous ?? query.data;
    if (plan.canReusePrevious && previous) return mergeRangeBundles(previous, query.data);
    return query.data;
  }, [plan.canReusePrevious, plan.servePrevious, previous, query.data, query.isPlaceholderData]);

  useEffect(() => {
    if (plan.scheduleRefreshAtMs == null) return undefined;
    const delayMs = Math.max(0, plan.scheduleRefreshAtMs - Date.now());
    const timer = window.setTimeout(() => setNowMs(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [plan.scheduleRefreshAtMs]);

  useEffect(() => {
    if (!data || query.isPlaceholderData) return;
    const updatedAtMs = query.dataUpdatedAt || Date.now();
    if (mergedRef.current?.identity === plan.identity && mergedRef.current.data === data) return;
    mergedRef.current = { identity: plan.identity, data, updatedAtMs };
    queryClient.setQueryData(buildRangeBundleRequest(baseInput).queryKey, data);
    // canonical 병합본 재발행 → 다음 리마운트·탭 복귀의 복원 소스(gcTime 2h). 이
    // 키엔 옵저버(useQuery)가 없어 setQueryData 가 재렌더를 유발하지 않는다. 위
    // 가드가 mergedRef 와 canonical 을 동기 유지하므로(둘 다 이 effect 에서만 쓰기)
    // 캔들의 별도 publishedRef 는 불필요 — range.ts 는 렌더 단계 pin 이 없다.
    queryClient.setQueryData(mergedLiveRangeKey(plan.identity), data);
    if (plan.forceRerenderAfterMerge) forceRerender();
  }, [baseInput, data, queryClient, query.dataUpdatedAt, query.isPlaceholderData, plan.identity, plan.forceRerenderAfterMerge]);

  return {
    ...query,
    data,
    isPlaceholderData: plan.enabled ? query.isPlaceholderData : false,
    // 배압 신호. isPlaceholderData만으로는 콜드(보여줄 이전 데이터가 없어
    // placeholder 미형성)에서 false가 되어, 콜드 in-flight 중 팬이 추가 요청을
    // 발사하는 사각이 있었다(2026-07-11 슬로그: 동일 wide 요청 3건 동시).
    // `!query.data`가 콜드 fetch를 커버한다 — 데이터가 랜딩되는 렌더에서는
    // isFetching=false라 하강 엣지(점진 페인트 + settle-loop pull)는 보존된다.
    isHistoricalDeltaFetching:
      plan.blocksHistoricalExtension && query.isFetching && (query.isPlaceholderData || query.data == null),
  };
}

export function useRangeSidecarDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: RangeRequestOptions,
  sourcePrefOverride?: SourcePreference,
) {
  return useLiveRangeDelta(code, from, to, timeframe, priceRange, todayKst, options, sourcePrefOverride, 'sidecar');
}

export function useRangeHogaDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: RangeRequestOptions,
  sourcePrefOverride?: SourcePreference,
) {
  return useLiveRangeDelta(code, from, to, timeframe, priceRange, todayKst, options, sourcePrefOverride, 'hoga');
}
