import { useMemo, useRef } from 'react';
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
    return {
      enabled: true,
      requestFrom: from,
      requestTo: to,
      canReusePrevious: false,
      servePrevious: false,
      identity,
    };
  }
  return {
    enabled: true,
    requestFrom: from,
    requestTo: addDays(previous.from, -1),
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
) {
  const mergedRef = useRef<{ identity: string; data: LivePastCandlesResponse } | null>(null);
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
        { signal },
      ),
    enabled: plan.enabled,
    staleTime: 60_000,
    refetchInterval: () => liveVenueRefetchInterval(venue),
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

  return {
    ...query,
    data,
  };
}
