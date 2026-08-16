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
import { useLiveVenueStore } from '../state/liveVenue';
import { useEffectiveVenue } from '../live/useEffectiveVenue';
import { useOrderflowSourcePref } from '../state/sourcePreference';
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
 *   the refetch must NOT leak into them.
 *
 * 탭 가림(document hidden) 대응(2026-07-29) — 오늘 분기에만 두 플래그를 켠다.
 * 전역 `refetchOnWindowFocus:false`(main.tsx) + react-query 의
 * `refetchIntervalInBackground` 기본 false 때문에, /live 탭이 가려지면 이 5분
 * 폴링이 멈춰 pastMaxQrT 가 동결되고 오늘 보조지표가 SSE 버퍼(15분 보존)만으로
 * 남다가 축출과 함께 구멍이 난다 — 캔들 쪽과 같은 병(livePastCandles.ts 의
 * PAST_CANDLES_REFETCH_IN_BACKGROUND 주석에 전말). 과거 전용 분기는 명시적으로
 * false 를 돌려 "비-라이브 호출자는 동결" 계약을 값으로 못박는다(테스트가 단언). */
export function rangeFreshnessOptions(
  to: string | null,
  todayKst: string | null,
): {
  staleTime: number;
  refetchInterval: number | false;
  refetchIntervalInBackground: boolean;
  refetchOnWindowFocus: boolean;
} {
  const includesToday = !!(to && todayKst && to >= todayKst);
  return includesToday
    ? {
        staleTime: TODAY_RANGE_REFETCH_MS,
        refetchInterval: TODAY_RANGE_REFETCH_MS,
        refetchIntervalInBackground: true,
        refetchOnWindowFocus: true,
      }
    : {
        staleTime: Infinity,
        refetchInterval: false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
      };
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
  const {
    staleTime, refetchInterval, refetchIntervalInBackground, refetchOnWindowFocus,
  } = rangeFreshnessOptions(input.to, request.todayKst);
  return {
    queryKey: request.queryKey,
    queryFn: ({ signal }) =>
      apiCall<RangeBundle>(request.url, { signal }),
    enabled: request.enabled,
    staleTime,
    refetchInterval,
    refetchIntervalInBackground,
    refetchOnWindowFocus,
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

/**
 * canonical 병합본 키에서 종목코드를 복원한다 — 축출(useLiveRangeCacheEviction)용.
 *
 * identity 는 실키 배열의 JSON 이라 code 는 인덱스 1 에 그대로 있다(RangeQueryKey
 * 규약). 이 지식을 여기 가둬 두어 축출 쪽이 JSON 형식을 알 필요가 없게 한다.
 *
 * 모르면 **null** 을 준다. 호출부는 null 을 "판별 불가 → 보존"으로 다뤄야 한다 —
 * 축출은 되돌릴 수 없으니 애매하면 남기는 쪽이 안전하다.
 */
export function codeFromMergedLiveRangeKey(queryKey: QueryKey): string | null {
  if (!Array.isArray(queryKey)) return null;
  if (queryKey[0] !== 'live' || queryKey[1] !== 'range-merged') return null;
  const identity = queryKey[2];
  if (typeof identity !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(identity);
    if (!Array.isArray(parsed)) return null;
    const code: unknown = parsed[1];
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * `['range', …]` 실키에서 bucket_ms(=봉)를 복원한다 — 축출용(#801).
 *
 * `RangeQueryKey` 규약상 인덱스 4 가 bucketMs 다. `codeFromMergedLiveRangeKey` 와
 * 같은 이유로 키 형식 지식을 이 모듈에 가둔다 — 축출 쪽이 인덱스를 알면 키 순서를
 * 바꾸는 날 조용히 엉뚱한 값을 지운다.
 *
 * 모르면 **null**(판별 불가 → 보존). 축출은 되돌릴 수 없다.
 */
export function bucketMsFromRangeKey(queryKey: QueryKey): number | null {
  if (!Array.isArray(queryKey) || queryKey[0] !== 'range') return null;
  const bucketMs: unknown = queryKey[4];
  return typeof bucketMs === 'number' && Number.isFinite(bucketMs) ? bucketMs : null;
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

/**
 * 방금 발행한 병합본에 **지배당한**(dominated) 같은-identity `['range', …]` 사본을 걷어낸다.
 *
 * 왜 쌓이나: 좌측 팬은 `historicalFromDate` 를 스텝마다 뒤로 민다. 아래 effect 가
 * 매 병합마다 `baseInput.from`(= 그 시점의 팬 위치) 키로 **그때의 최광폭 병합본
 * 전체**를 재발행하므로, 스텝이 진행될수록 7일치·14일치·…·63일치 사본이 덮어쓰기가
 * 아니라 **나란히 증식**한다. 옵저버가 없어 gcTime 30분을 꽉 채우고, 2개월 팬 한 번이
 * 한 종목·한 identity 기준 수십 MB 다(2026-07-29 크로스헤어 지연 진단 2순위).
 *
 * 왜 지워도 안전한가: `cachedLiveRangeDeltaPrevious` 는 같은 identity 중 **from_date
 * 최소**인 사본만 집어온다. 방금 쓴 병합본이 곧 그 최소이고, 여기서 지우는 건
 * `from_date >= merged.from_date` 인 **완전히 포함되는** 창들뿐이라 복원원의 깊이가
 * 그대로다. 즉 회수되는 건 중복 사본이지 정보가 아니다.
 *
 * 가드 둘:
 *  - `type: 'inactive'` — 옵저버가 남은 쿼리를 지우면 RQ 가 즉시 재생성·재요청한다
 *    (useStudyRangeCacheEviction 과 같은 함정). 현재 서빙 중인 청크가 여기 걸린다.
 *  - `cached === merged` — 방금 쓴 사본 자신을 제외한다.
 *
 * identity 로 좁히므로 /study 가 쓰는 `['range', …]` 는 건드리지 않는다.
 */
function removeDominatedLiveRangeCopies(
  queryClient: QueryClient,
  identity: string,
  merged: RangeBundle,
): void {
  queryClient.removeQueries({
    queryKey: ['range', merged.code],
    type: 'inactive',
    predicate: (query) => {
      const cached = query.state.data as RangeBundle | undefined;
      if (!cached || cached === merged) return false;
      if (liveRangeDeltaIdentityFromKey(query.queryKey) !== identity) return false;
      return cached.to_date === merged.to_date && cached.from_date >= merged.from_date;
    },
  });
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
    // ⚠ `...next` 만으로는 **결손 사유가 팬 한 번에 사라진다**(#1133). 실측: 8/1~8/7
    // 요청이 `missing_dates=[8/5]` 를 주고, 이어지는 7/31 단일 청크가 `[]` 를 주면서
    // 스프레드가 앞의 것을 덮었다 — 화면에서는 안내가 떴다가 조용히 없어진다.
    // `excluded_dates`·`data_warnings` 와 같은 날짜별 병합이라 규칙도 그대로 쓴다:
    // next 가 덮은 날짜(`nextDates`)만 previous 에서 빼고 나머지는 보존한다.
    missing_dates: uniqueBy(
      [...outsideCoveredDates(previous.missing_dates ?? [], nextDates), ...(next.missing_dates ?? [])],
      (m) => `${m.date}|${m.reason}`,
      (a, b) => a.date.localeCompare(b.date),
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
    // 시각 단위 병합이되 위 둘(`depth_heatmap`·`depth_delta`)과 **키가 다르다** — 한
    // 스냅샷 시각에 매도·매수 벽이 동시에, 또는 다른 호가 레벨에서 함께 설 수 있어
    // `t_ms` 만으로 묶으면 그중 하나만 남는다.
    //
    // **`previous` 는 거르지 않는다.** 이 함수 안에 병합 규칙이 두 종류 공존하므로 왜
    // 이쪽인지 남긴다. `broker_late_entries`·`program_trade` 는 next 가 다시 내려준
    // 세그먼트 안의 previous 를 `outsideCoveredSegment` 로 버리는데, 그건 **재계산에서
    // 항목이 사라질 수 있을 때** 필요한 방어다(사라진 항목은 대응할 키가 없어 dedup 이
    // 못 잡는다). 호가벽 판정에는 그 일이 없다 — `query_wall_surge` 의 임계가
    // `avg(tot) OVER (… UNBOUNDED PRECEDING AND CURRENT ROW)` 인 **당일 러닝 prefix
    // 집계**이고 baseline·`lag` 도 전부 lookback 이라(윈도우에 `FOLLOWING` 이 하나도
    // 없다), 데이터가 뒤로 늘어나도 **과거 시각의 판정이 불변**이다. 나중에 확정되는
    // 것은 결말(`outcome`)뿐이고 그건 키가 같아 `uniqueBy` 가 뒤를 남긴다.
    // **prefix 집계인가가 이 선택의 판별식이다.**
    //
    // 이 항목이 아예 없으면 최상위 `...next` 로 낙착돼 청크를 이어 붙일 때마다 앞 구간이
    // 통째로 사라진다(#1333 — 좌측 팬 프리페치의 빈 청크 하나가 전량을 지웠다).
    wall_surge: uniqueBy(
      [...(previous.wall_surge ?? []), ...(next.wall_surge ?? [])],
      (e) => `${e.t_ms}|${e.side}|${e.price}`,
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
  const storedSourcePref = useOrderflowSourcePref();
  const sourcePref = sourcePrefOverride ?? storedSourcePref;
  // venue 는 **전역 선택기**를 따른다(#1132) — `/live` 에서 고른 시장이 히트맵·
  // 스크리너까지 지배하는 것과 같은 규율. 쿼리 키에도 들어가므로 venue 를 바꾸면
  // 캐시가 갈린다(안 갈리면 이전 venue 데이터가 그대로 보인다).
  //
  // 다만 **선택값이 아니라 이 종목에 대한 해석값**을 쓴다. 규율이 바뀐 게 아니라
  // (여전히 선택기를 따른다) 해석 단계가 빠져 있었다: NXT 미상장 종목에 통합(UN)을
  // 고르면 백엔드에 `kiwoom_live/UN/` 이 애초에 안 생겨(`coverage.subscription_venues`
  // 가 `("KRX",)`) **빈 200** 이 온다. 실측 2026-08-07 `003490`: KRX 프로그램 708 점
  // 대 UN **0**. 에러가 아니라 정상 빈 응답이라 화면이 조용히 빈다.
  const selectedVenue = useLiveVenueStore((s) => s.venue);
  const venue = useEffectiveVenue(code, selectedVenue);
  return useQuery(rangeBundleQueryOptions({
    code,
    from,
    to,
    timeframe,
    priceRange,
    todayKst,
    sourcePref,
    venue,
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
  const storedSourcePref = useOrderflowSourcePref();
  const sourcePref = sourcePrefOverride ?? storedSourcePref;
  // 전역 선택기(#1132)를 **종목별로 해석해서** 쓴다 — 근거는 `useRange` 의 같은 자리.
  // 여기선 `identity` 까지 따라간다: `liveRangeDeltaIdentity` 가 queryKey 파생이라
  // 선택값이 남으면 venue 를 바꿔도 델타 병합본이 이전 시장 데이터를 물고 있는다.
  const selectedVenue = useLiveVenueStore((s) => s.venue);
  const venue = useEffectiveVenue(code, selectedVenue);
  const queryClient = useQueryClient();
  const mergedRef = useRef<{ identity: string; data: RangeBundle; updatedAtMs: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [, forceRerender] = useReducer((value: number) => value + 1, 0);
  const baseInput = useMemo<RangeBundleRequestInput>(
    () => ({ code, from, to, timeframe, priceRange, todayKst, sourcePref, venue, options }),
    [code, from, to, timeframe, priceRange, todayKst, sourcePref, venue, options],
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
  const {
    staleTime, refetchInterval, refetchIntervalInBackground, refetchOnWindowFocus,
  } = rangeFreshnessOptions(plan.requestInput.to, request.todayKst);
  const initialData = plan.servePrevious && !plan.canReusePrevious ? previous : undefined;

  const query = useQuery<RangeBundle, Error, RangeBundle, RangeQueryKey>({
    queryKey: request.queryKey,
    queryFn: ({ signal }) => apiCall<RangeBundle>(request.url, { signal }),
    enabled: plan.enabled,
    staleTime,
    refetchInterval,
    refetchIntervalInBackground,
    refetchOnWindowFocus,
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
    // 위 재발행이 남긴 이전 팬 스텝 사본들을 즉시 회수 — 근거는 함수 주석.
    removeDominatedLiveRangeCopies(queryClient, plan.identity, data);
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
