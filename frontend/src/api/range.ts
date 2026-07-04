import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

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
