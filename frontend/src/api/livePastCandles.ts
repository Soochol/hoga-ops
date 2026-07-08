import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { liveVenueRefetchInterval } from '../live/liveVenuePolicy';
import type { LiveVenueOption } from '../state/liveVenue';

export interface LivePastCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LivePastCandlesWarning {
  date: string;
  reason: string;
  msg: string;
}

export interface LiveEffectiveSession {
  date: string;
  venue: LiveVenueOption;
  open_ms: number;
  close_ms: number;
}

export interface LivePastCandlesResponse {
  code: string;
  from: string;
  to: string;
  venue?: LiveVenueOption;
  candles: LivePastCandle[];
  cached_dates: string[];
  fresh_dates: string[];
  data_warnings: LivePastCandlesWarning[];
  effective_sessions?: LiveEffectiveSession[];
}

interface DeltaPlan {
  enabled: boolean;
  requestFrom: string | null;
  requestTo: string | null;
  canReusePrevious: boolean;
  servePrevious: boolean;
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

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function uniqueWarnings(warnings: LivePastCandlesWarning[]): LivePastCandlesWarning[] {
  const out = new Map<string, LivePastCandlesWarning>();
  for (const warning of warnings) {
    out.set(`${warning.date}|${warning.reason}|${warning.msg}`, warning);
  }
  return Array.from(out.values()).sort((a, b) =>
    `${a.date}|${a.reason}|${a.msg}`.localeCompare(`${b.date}|${b.reason}|${b.msg}`),
  );
}

/** 백엔드 _fallback_blocking_warning_dates와 동일한 재시도-가능 실패 사유.
 * 이 경고를 실은 응답을 델타 기준(mergedRef)에 박제하면, 일시 장애 창이
 * "이미 받은 범위"로 굳어 영원히 재요청되지 않는다(영구 구멍). */
const BLOCKING_WARNING_REASONS = new Set([
  'capacity_overloaded',
  'fetch_budget_exhausted',
  'kis_api_error',
  'kis_rate_limit',
  'rate_limit_aborted',
]);

export function hasBlockingWarnings(response: LivePastCandlesResponse): boolean {
  return response.data_warnings.some((w) => BLOCKING_WARNING_REASONS.has(w.reason));
}

function uniqueSessionsByDate(sessions: LiveEffectiveSession[]): LiveEffectiveSession[] {
  const byDate = new Map<string, LiveEffectiveSession>();
  for (const session of sessions) {
    byDate.set(session.date, session);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function sortUniqueCandles(candles: LivePastCandle[]): LivePastCandle[] {
  const byT = new Map<number, LivePastCandle>();
  for (const candle of candles) {
    byT.set(candle.t_ms, candle);
  }
  return Array.from(byT.values()).sort((a, b) => a.t_ms - b.t_ms);
}

function responseIdentity(code: string | null, to: string | null, venue: LiveVenueOption): string {
  return `${code ?? ''}|${to ?? ''}|${venue}`;
}

/** 한 요청의 최대 캘린더일 폭. 백엔드 미캐시-일수 예산
 * (max_fresh_dates_per_collect=12 거래일)보다 작은 ~11거래일이라 청크는
 * 항상 예산 안에서 완결된다. 기준선(mergedRef)이 리마운트·날짜 롤오버로
 * 사라졌을 때 수백 일 창을 통째로 재요청하던 것이 분봉 기아의
 * 근본원인(2026-07-07 조사) — 청크 워크백으로 근절한다. */
export const PAST_CHUNK_CALENDAR_DAYS = 15;

/** 서버가 예산 내로 응답하므로 정상 요청은 수 초에 끝난다. 30s는 서버
 * 포화·행 상태에서 무한 로딩을 끊는 백스톱 — abort되면 React Query
 * 재시도/refetchInterval이 이어받는다. */
const PAST_CANDLES_TIMEOUT_MS = 30_000;

export function withPastCandlesTimeout(signal: AbortSignal, ms: number): AbortSignal {
  if (typeof AbortSignal.any !== 'function' || typeof AbortSignal.timeout !== 'function') {
    return signal; // 구형 런타임 폴백: 타임아웃 없이 기존 동작 유지
  }
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** 이 청크 요청(requestTo)이 오늘을 포함하는가. range.ts의 rangeFreshnessOptions와
 * 동일 술어 — todayKst가 없으면(스터디 등 과거 전용) false. */
function chunkIncludesToday(requestTo: string | null, todayKst: string | null): boolean {
  return !!(requestTo && todayKst && requestTo >= todayKst);
}

/** 완결된 과거 청크는 불변이므로 stale 판정이 무의미하다 → Infinity로 승격.
 * 오늘을 포함하는 head 청크만 Today Promotion(5분)에 맞춰 60s stale을 유지한다.
 * (range.ts rangeFreshnessOptions와 동일 원칙 — 그쪽은 이미 이렇게 한다.) */
export function pastCandlesStaleTime(requestTo: string | null, todayKst: string | null): number {
  return chunkIncludesToday(requestTo, todayKst) ? 60_000 : Infinity;
}

/** 과거 전용 청크는 폴링을 끈다(false) — 불변 데이터에 venue 주기 refetch는 낭비다.
 * 예외: blocking 경고(일시 장애) 응답은 얼리면 실패 창이 영구 구멍이 되므로,
 * 과거 전용이라도 venue 주기로 재시도해 자가 회복한다(mergedRef 박제 가드와 동일 원칙).
 * refetchInterval은 staleTime과 무관하게 타이머로 도므로 staleTime:Infinity와 공존한다. */
export function pastCandlesRefetchInterval(
  data: LivePastCandlesResponse | undefined,
  requestTo: string | null,
  todayKst: string | null,
  venue: LiveVenueOption,
): number | false {
  if (chunkIncludesToday(requestTo, todayKst)) return liveVenueRefetchInterval(venue);
  if (data && hasBlockingWarnings(data)) return liveVenueRefetchInterval(venue);
  return false;
}

export function planPastCandlesDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption,
  previous?: LivePastCandlesResponse,
): DeltaPlan {
  const enabled = !!(code && from && to && from <= to);
  const identity = responseIdentity(code, to, venue);
  if (!enabled || !code || !from || !to) {
    return {
      enabled: false,
      requestFrom: null,
      requestTo: null,
      canReusePrevious: false,
      servePrevious: false,
      identity,
    };
  }
  const previousVenue = previous?.venue ?? 'KRX';
  const sameIdentity = !!(
    previous &&
    previous.code === code &&
    previousVenue === venue &&
    previous.to === to
  );
  if (sameIdentity && previous.from <= from) {
    return {
      enabled: false,
      requestFrom: null,
      requestTo: null,
      canReusePrevious: false,
      servePrevious: true,
      identity,
    };
  }
  const canReusePrevious = !!(
    sameIdentity &&
    from < previous.from
  );
  if (!canReusePrevious) {
    const chunkFloor = addDays(to, -(PAST_CHUNK_CALENDAR_DAYS - 1));
    return {
      enabled: true,
      requestFrom: from < chunkFloor ? chunkFloor : from,
      requestTo: to,
      canReusePrevious: false,
      servePrevious: false,
      identity,
    };
  }
  const requestTo = addDays(previous.from, -1);
  const chunkFloor = addDays(requestTo, -(PAST_CHUNK_CALENDAR_DAYS - 1));
  return {
    enabled: true,
    requestFrom: from < chunkFloor ? chunkFloor : from,
    requestTo,
    canReusePrevious: true,
    servePrevious: true,
    identity,
  };
}

export function mergePastCandleResponses(
  previous: LivePastCandlesResponse,
  next: LivePastCandlesResponse,
): LivePastCandlesResponse {
  return {
    ...next,
    from: previous.from < next.from ? previous.from : next.from,
    // load-bearing: 청크 워크백 중 merged `to`를 seed `to`(=max)에 고정한다.
    // sameIdentity가 `previous.to === to`로 키하므로(아래 planPastCandlesDelta),
    // merged `to`가 한 청크의 더 작은 to로 흘러내리면 워크백 도중 체인이
    // 리셋된다. 이 max가 워크백 자기재시작의 불변식이다 — 낮추지 말 것.
    to: previous.to > next.to ? previous.to : next.to,
    venue: next.venue ?? previous.venue,
    candles: sortUniqueCandles([...previous.candles, ...next.candles]),
    cached_dates: uniqueSorted([...previous.cached_dates, ...next.cached_dates]),
    fresh_dates: uniqueSorted([...previous.fresh_dates, ...next.fresh_dates]),
    data_warnings: uniqueWarnings([...previous.data_warnings, ...next.data_warnings]),
    effective_sessions: uniqueSessionsByDate([
      ...(previous.effective_sessions ?? []),
      ...(next.effective_sessions ?? []),
    ]),
  };
}

export function useLivePastCandles(
  code: string | null,
  from: string | null,
  to: string | null,
  venue: LiveVenueOption = 'KRX',
  todayKst: string | null = null,
) {
  const mergedRef = useRef<{ identity: string; data: LivePastCandlesResponse } | null>(null);
  const [, bumpMergedVersion] = useReducer((x: number) => x + 1, 0);
  const identity = responseIdentity(code, to, venue);
  const previous = mergedRef.current?.identity === identity ? mergedRef.current.data : undefined;
  const previousFrom = previous?.from;
  const previousTo = previous?.to;
  const plan = useMemo(
    () => planPastCandlesDelta(code, from, to, venue, previous),
    [code, from, to, venue, previous, previousFrom, previousTo],
  );

  const query = useQuery({
    queryKey: ['live', 'past-candles', code, plan.requestFrom, plan.requestTo, venue] as const,
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${plan.requestFrom}&to=${plan.requestTo}&venue=${venue}`,
        { signal: withPastCandlesTimeout(signal, PAST_CANDLES_TIMEOUT_MS) },
      ),
    enabled: plan.enabled,
    // Freshness gated on whether this chunk includes today (range.ts parity):
    // past-only completed chunks are immutable → frozen (staleTime Infinity,
    // no poll); the today head chunk keeps the 60s / venue-interval cadence.
    staleTime: pastCandlesStaleTime(plan.requestTo, todayKst),
    refetchInterval: (query) =>
      pastCandlesRefetchInterval(query.state.data, plan.requestTo, todayKst, venue),
    // Code+venue-aware placeholder: keep previous data only when the identity
    // still means the same candle venue. Same-code refetches (lazy from/to
    // extension, refetchInterval) keep the previous render to avoid blanking.
    // Code or venue switches drop the placeholder
    // so the bundle reports candles.length===0 until fresh data arrives —
    // without this, LiveChartRoot's initial-view effect runs against the
    // PREVIOUS code's candle count and locks setVisibleLogicalRange with a
    // stale right edge, pushing the new code's latest candle off-screen.
    placeholderData: (prev) => (
      prev && prev.code === code && (prev.venue ?? 'KRX') === venue && prev.to === to ? prev : undefined
    ),
  });

  const data = useMemo(() => {
    if (plan.servePrevious && previous && !query.data) return previous;
    if (!query.data) return undefined;
    if (query.isPlaceholderData) return previous;
    if (plan.canReusePrevious && previous) {
      return mergePastCandleResponses(previous, query.data);
    }
    return query.data;
  }, [plan.canReusePrevious, plan.servePrevious, previous, query.data, query.isPlaceholderData]);

  // 일시 장애(blocking 경고) 응답은 이번 렌더에만 서빙하고 델타 기준으론
  // 박제하지 않는다 — 다음 plan이 실패 창을 재요청해 자가 회복(staleTime
  // 60s + refetchInterval). 박제하면 실패 창이 영구 구멍이 된다(319660 사례).
  // 가드는 방금 도착한 query.data에만 건다: 이전에 박제된 정상 상태는
  // merged data에 경고가 섞여 있어도 그대로 유지돼야 한다.
  if (data && !query.isPlaceholderData && !(query.data && hasBlockingWarnings(query.data))) {
    mergedRef.current = { identity, data };
  }

  // 청크 워크백 전진 nudge: 응답이 pin된 렌더에서는 plan이 pin 이전
  // previous로 계산돼 있다. 데이터 도착마다 리렌더를 한 번 강제해
  // 다음 청크 쿼리키가 즉시 파생되게 한다. blocking 경고 응답은 pin되지
  // 않아 plan이 같은 키를 유지 → React Query가 중복 요청을 흡수하므로
  // 무한 루프가 아니다(재시도는 staleTime 60s가 담당).
  // 종료 보장: bumpMergedVersion은 어떤 query.data/isPlaceholderData에도
  // 반영되지 않는 useReducer 카운터라 자기 effect를 재발화하지 못한다 —
  // 오직 새 query 결과에만 발화한다. merged.from은 단조 비증가이고,
  // seed from에 도달하면 servePrevious 분기가 enabled:false로 쿼리를 꺼
  // query.data=undefined → 가드 거짓 → 정지한다.
  useEffect(() => {
    if (query.data && !query.isPlaceholderData) bumpMergedVersion();
  }, [query.data, query.isPlaceholderData]);

  return {
    ...query,
    data,
    // isLoading = "보여줄 데이터가 전혀 없음". 워크백 청크 N≥3에선 placeholder
    // 체인(prev.to === to, 위 placeholderData)이 끊겨 raw query.isLoading이
    // 재점화하지만, `data`는 mergedRef 병합본을 계속 서빙한다 — 소비자가 이를
    // '초기 로딩'으로 오독해 차트를 통째로 언마운트하는 것(/study 플래시,
    // 2026-07-08 실증)을 계약 차원에서 차단한다. 워크백 진행 신호가 필요한
    // 소비자는 isFetching / isPlaceholderData(둘 다 raw 유지)를 쓴다.
    isLoading: query.isLoading && data == null,
  };
}
