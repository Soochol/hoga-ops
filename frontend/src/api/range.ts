import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { TIMEFRAME_TO_MS, type RangeBundle, type Timeframe } from './types';

/**
 * Fetch a Stock-Date Range bundle (ADR-0013, ADR-0014).
 *
 * Uses apiCall helper, staleTime: Infinity (captured Stock-Dates are
 * immutable historical data), and an optional priceRange parameter that
 * drives VolumeProfileOverlay's visible-price filtering.
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
  const qs = priceRange ? `&price_min=${priceRange.min}&price_max=${priceRange.max}` : '';
  return useQuery({
    queryKey: ['range', code, from, to, bucketMs, priceRange?.min, priceRange?.max] as const,
    queryFn: () =>
      apiCall<RangeBundle>(
        `/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${bucketMs}${qs}`,
      ),
    enabled,
    staleTime: Infinity,
  });
}
