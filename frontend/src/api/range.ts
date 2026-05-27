import { useQuery, keepPreviousData } from '@tanstack/react-query';

import { apiCall } from './client';
import { TIMEFRAME_TO_MS, type RangeBundle, type Timeframe } from './types';
import { useSourcePreferenceStore } from '../state/sourcePreference';

/**
 * Fetch a Stock-Date Range bundle (ADR-0013, ADR-0014).
 *
 * Uses apiCall helper, staleTime: Infinity (captured Stock-Dates are
 * immutable historical data), and an optional priceRange parameter that
 * drives VolumeProfileOverlay's visible-price filtering.
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
) {
  const bucketMs = timeframe ? TIMEFRAME_TO_MS[timeframe] : null;
  const enabled = !!(code && from && to && bucketMs);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const priceQs = priceRange ? `&price_min=${priceRange.min}&price_max=${priceRange.max}` : '';

  return useQuery({
    queryKey: [
      'range',
      code,
      from,
      to,
      bucketMs,
      priceRange?.min,
      priceRange?.max,
      sourcePref,
    ] as const,
    queryFn: () =>
      apiCall<RangeBundle>(
        `/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${bucketMs}` +
          `${priceQs}&source_pref=${sourcePref}`,
      ),
    enabled,
    staleTime: Infinity,
    // Keep the previous response visible during a refetch with a new query
    // key (e.g., /live extending historicalFromDate to fetch one more
    // chunk). Without this, `data` flips to undefined while the new query
    // is in flight, which on /live makes the bundle shrink to today-only
    // for a frame and the chart visibly collapses to ~2 candles before
    // re-expanding when the response lands.
    placeholderData: keepPreviousData,
  });
}
