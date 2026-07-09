import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { GapRangesResponse } from '../api/types';

/** WS1: lazily fetch continuous-trading gap boundaries for one Stock-Date.
 *
 * Enabled only when the inventory drawer's gap panel is expanded — the
 * inventory list itself never carries gap ranges (it reads meta.json only;
 * the backend recomputes from parquet for legacy meta, which is too costly to
 * do per-row). staleTime Infinity: a captured Stock-Date's gaps don't change
 * unless it's re-captured, and a re-capture invalidates via the SSE inventory
 * refresh path.
 */
export function useStockDateGaps(code: string, date: string, enabled: boolean) {
  return useQuery({
    queryKey: ['gaps', code, date],
    queryFn: () =>
      apiGet<GapRangesResponse>(
        `/api/gaps?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}`,
      ),
    enabled,
    staleTime: Infinity,
  });
}
