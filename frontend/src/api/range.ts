import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer, useRef } from 'react';

import { apiCall } from './client';
import type { RangeBundle, Timeframe } from './types';
import {
  buildRangeBundleRequest,
  rangePlaceholderData,
  type RangeBundleRequestInput,
  type RangeQueryKey,
  type RangeRequestOptions,
} from './rangeRequest';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { SourcePreference } from '../state/sourcePreference';

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

type DeltaRangeMode = 'sidecar' | 'hoga';

function deltaRangeIdentity(input: RangeBundleRequestInput): string {
  const request = buildRangeBundleRequest(input);
  const key = [...request.queryKey];
  key[2] = null;
  return JSON.stringify(key);
}

function planRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
  previousIdentity?: string,
  mode: DeltaRangeMode = 'sidecar',
): RangeDeltaPlan {
  const identity = deltaRangeIdentity(input);
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
    return {
      enabled: true,
      requestInput: fullInput,
      canReusePrevious: false,
      servePrevious: true,
      identity,
    };
  }

  if (sameIdentity && input.from < previous.from_date) {
    return {
      enabled: true,
      requestInput: { ...input, from: input.from, to: addDays(previous.from_date, -1) },
      canReusePrevious: true,
      servePrevious: true,
      identity,
    };
  }

  return {
    enabled: true,
    requestInput: fullInput,
    canReusePrevious: false,
    servePrevious: false,
    identity,
  };
}

export function planSidecarRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
  previousIdentity?: string,
): RangeDeltaPlan {
  return planRangeDelta(input, previous, previousIdentity, 'sidecar');
}

export function planHogaRangeDelta(
  input: RangeBundleRequestInput,
  previous?: RangeBundle,
  previousIdentity?: string,
): RangeDeltaPlan {
  return planRangeDelta(input, previous, previousIdentity, 'hoga');
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string, compare: (a: T, b: T) => number): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return Array.from(byKey.values()).sort(compare);
}

export function mergeRangeBundles(previous: RangeBundle, next: RangeBundle): RangeBundle {
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
      [...previous.candles, ...next.candles],
      (c) => String(c.ts_ms),
      (a, b) => a.ts_ms - b.ts_ms,
    ),
    quote_ratio: {
      bucket_ms: next.quote_ratio.bucket_ms,
      points: uniqueBy(
        [...previous.quote_ratio.points, ...next.quote_ratio.points],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    fill_strength: {
      bucket_ms: next.fill_strength.bucket_ms,
      points: uniqueBy(
        [...previous.fill_strength.points, ...next.fill_strength.points],
        (p) => String(p.t),
        (a, b) => a.t - b.t,
      ),
    },
    ask_peaks: uniqueBy(
      [...previous.ask_peaks, ...next.ask_peaks],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    bid_peaks: uniqueBy(
      [...(previous.bid_peaks ?? []), ...(next.bid_peaks ?? [])],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    broker_late_entries: uniqueBy(
      [...previous.broker_late_entries, ...next.broker_late_entries],
      (e) => `${e.t_ms}|${e.broker}|${e.side}`,
      (a, b) => a.t_ms - b.t_ms,
    ),
    trade_volume_pocs: uniqueBy(
      [...(previous.trade_volume_pocs ?? []), ...(next.trade_volume_pocs ?? [])],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    volume_distributions: uniqueBy(
      [...previous.volume_distributions, ...next.volume_distributions],
      (p) => p.date,
      (a, b) => a.date.localeCompare(b.date),
    ),
    program_trade: {
      source: next.program_trade?.source ?? previous.program_trade?.source,
      points: uniqueBy(
        [...(previous.program_trade?.points ?? []), ...(next.program_trade?.points ?? [])],
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

function useRangeDelta(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
  priceRange?: { min: number; max: number },
  todayKst?: string | null,
  options?: RangeRequestOptions,
  sourcePrefOverride?: SourcePreference,
  mode: DeltaRangeMode = 'sidecar',
) {
  const storedSourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const sourcePref = sourcePrefOverride ?? storedSourcePref;
  const mergedRef = useRef<{ identity: string; data: RangeBundle } | null>(null);
  const [, forceRerender] = useReducer((value: number) => value + 1, 0);
  const baseInput = useMemo<RangeBundleRequestInput>(
    () => ({ code, from, to, timeframe, priceRange, todayKst, sourcePref, options }),
    [code, from, to, timeframe, priceRange, todayKst, sourcePref, options],
  );
  const merged = mergedRef.current;
  const previousIdentity = merged?.identity;
  const previous = merged && merged.identity === deltaRangeIdentity(baseInput)
    ? merged.data
    : undefined;
  const plan = useMemo(
    () => planRangeDelta(baseInput, previous, previousIdentity, mode),
    [baseInput, previous, previousIdentity, mode],
  );
  const request = buildRangeBundleRequest(plan.requestInput);
  const { staleTime, refetchInterval } = rangeFreshnessOptions(to, request.todayKst);
  const initialData = plan.servePrevious && !plan.canReusePrevious ? previous : undefined;

  const query = useQuery<RangeBundle, Error, RangeBundle, RangeQueryKey>({
    queryKey: request.queryKey,
    queryFn: ({ signal }) => apiCall<RangeBundle>(request.url, { signal }),
    enabled: plan.enabled,
    staleTime,
    refetchInterval,
    placeholderData: (prev, previousQuery) =>
      rangePlaceholderData(prev, request.queryKey, previousQuery?.queryKey),
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
    if (!data || query.isPlaceholderData) return;
    if (mergedRef.current?.identity === plan.identity && mergedRef.current.data === data) return;
    mergedRef.current = { identity: plan.identity, data };
    if (plan.canReusePrevious) forceRerender();
  }, [data, query.isPlaceholderData, plan.identity, plan.canReusePrevious]);

  return { ...query, data };
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
  return useRangeDelta(code, from, to, timeframe, priceRange, todayKst, options, sourcePrefOverride, 'sidecar');
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
  return useRangeDelta(code, from, to, timeframe, priceRange, todayKst, options, sourcePrefOverride, 'hoga');
}
