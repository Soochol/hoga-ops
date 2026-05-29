import { useQuery } from '@tanstack/react-query';

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
    // Code-aware placeholder mirrors livePastCandles.ts: keep the previous
    // response visible during same-code refetches (e.g., /live extending
    // historicalFromDate to fetch one more chunk), but DROP it on code
    // switches. Without this code guard, a watchlist click on /live left
    // the previous code's segments / quote_ratio / fill_strength in
    // bundle until /api/range for the new code resolved, which made the
    // VirtualAxis (built from those segments) stale and projected the
    // new code's hoga indicator points onto the old code's date layout —
    // surfaced as "엉뚱한 곳에서 시작하는" charts in /diagnose 2026-05-29.
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}
