import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { TIMEFRAME_TO_MS, type RangeBundle, type Timeframe } from './types';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { SourcePreference } from '../state/sourcePreference';

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

type RangeQueryKey = readonly [
  'range',
  string | null,
  string | null,
  string | null,
  number | null,
  number | undefined,
  number | undefined,
  number | null,
  number | null,
  number | undefined,
  number | undefined,
  number | null,
  SourcePreference,
];

const PLACEHOLDER_COMPATIBLE_KEY_INDICES = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export function rangePlaceholderData(
  prev: RangeBundle | undefined,
  currentKey: RangeQueryKey,
  previousKey: readonly unknown[] | undefined,
): RangeBundle | undefined {
  if (!prev || prev.code !== currentKey[1]) return undefined;
  if (!previousKey) return undefined;
  for (const index of PLACEHOLDER_COMPATIBLE_KEY_INDICES) {
    if (previousKey[index] !== currentKey[index]) return undefined;
  }
  return prev;
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
  options?: {
    brokerLateEntryStartHHMM?: number | null;
    volumeDistributionBins?: number | null;
    tradeVolumePocBins?: number | null;
    volumeDistributionPriceRange?: { min: number; max: number } | null;
  },
) {
  const bucketMs = timeframe ? TIMEFRAME_TO_MS[timeframe] : null;
  const enabled = !!(code && from && to && bucketMs);
  const sourcePref: SourcePreference = useSourcePreferenceStore((s) => s.sourcePreference);
  const priceQs = priceRange ? `&price_min=${priceRange.min}&price_max=${priceRange.max}` : '';
  const volumeDistributionBins = options?.volumeDistributionBins ?? null;
  const tradeVolumePocBins = options?.tradeVolumePocBins ?? null;
  const brokerLateEntryStartHHMM = options?.brokerLateEntryStartHHMM ?? null;
  const volumeDistributionPriceRange = options?.volumeDistributionPriceRange ?? null;
  const brokerLateEntryQs = brokerLateEntryStartHHMM != null
    ? `&broker_late_entry_start_hhmm=${brokerLateEntryStartHHMM}`
    : '';
  const volumeDistributionQs = volumeDistributionBins != null
    ? `&volume_distribution_bins=${volumeDistributionBins}`
    : '';
  const volumeDistributionPriceQs = volumeDistributionPriceRange != null
    ? `&volume_distribution_price_min=${volumeDistributionPriceRange.min}&volume_distribution_price_max=${volumeDistributionPriceRange.max}`
    : '';
  const tradeVolumePocQs = tradeVolumePocBins != null
    ? `&trade_volume_poc_bins=${tradeVolumePocBins}`
    : '';
  const { staleTime, refetchInterval } = rangeFreshnessOptions(to, todayKst ?? null);

  const queryKey: RangeQueryKey = [
      'range',
      code,
      from,
      to,
      bucketMs,
      priceRange?.min,
      priceRange?.max,
      brokerLateEntryStartHHMM,
      volumeDistributionBins,
      volumeDistributionPriceRange?.min,
      volumeDistributionPriceRange?.max,
      tradeVolumePocBins,
      sourcePref,
    ];

  return useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      apiCall<RangeBundle>(
        `/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${bucketMs}` +
          `${priceQs}${brokerLateEntryQs}${volumeDistributionQs}${volumeDistributionPriceQs}${tradeVolumePocQs}&source_pref=${sourcePref}`,
        { signal },
      ),
    enabled,
    staleTime,
    refetchInterval,
    // Code-aware placeholder mirrors livePastCandles.ts: keep the previous
    // response visible during same-code refetches (e.g., /live extending
    // historicalFromDate to fetch one more chunk), but DROP it on code
    // switches. Without this code guard, a watchlist click on /live left
    // the previous code's segments / quote_ratio / fill_strength in
    // bundle until /api/range for the new code resolved, which made the
    // VirtualAxis (built from those segments) stale and projected the
    // new code's hoga indicator points onto the old code's date layout —
    // surfaced as "엉뚱한 곳에서 시작하는" charts in /diagnose 2026-05-29.
    placeholderData: (prev, previousQuery) =>
      rangePlaceholderData(prev, queryKey, previousQuery?.queryKey),
  });
}
