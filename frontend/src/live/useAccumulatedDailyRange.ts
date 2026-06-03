import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { subtractDaysKst } from './liveDateTime';

export interface AccumulatedDailyRange<T> {
  /** Accumulated immutable history + the live today slice, deduped by ms key,
   * sorted ascending. */
  items: T[];
  isLoading: boolean;
  /** A historical extension page is in flight (false-edge = one settle step). */
  isExtending: boolean;
  error: unknown;
}

/** Page request range, YYYYMMDD KST inclusive. The cursor is the lowest range
 * already REQUESTED (not the lowest data returned), so the next page is always
 * disjoint below it — no overlapping re-fetch even across a 거래정지 gap. */
interface PageParam {
  from: string;
  to: string;
}

const EMPTY: unknown[] = [];

export interface AccumulatedDailyRangeArgs<T> {
  code: string | null;
  /** Namespaces this dataset's react-query cache (e.g. ['live','daily-candles',
   * code, timeframe]). Distinct datasets / variants MUST differ here. */
  baseKey: readonly unknown[];
  /** Initial history window size in calendar days (e.g. initialHistoricalDaysFor). */
  seedCalendarDays: number;
  today: string;
  /** Shared settle-loop cursor — the SOLE trigger for pulling older slices. */
  historicalFromDate: string | null;
  enabled: boolean;
  /** Dumb wire call returning the slice's items for [from, to]. */
  fetchSlice: (code: string, from: string, to: string) => Promise<T[]>;
  /** Stable (module-level) ms extractor used for dedup + sort. */
  getMs: (item: T) => number;
}

/** Loads a daily-granular dataset (candles, investor net, …) INCREMENTALLY:
 * immutable older slices accumulated via useInfiniteQuery (staleTime:Infinity,
 * no interval → never re-downloaded) + a tiny live today slice (refetchInterval
 * 60s). `historicalFromDate` stays the sole trigger — a bridge effect pulls the
 * next disjoint slice when the cursor drops below the lowest range requested, so
 * total transfer is O(K) not the prior O(K²) re-fetch of [cursor, today]. See
 * `useDailyCandlesAccumulated` / `useInvestorNetAccumulated` for the wrappers. */
export function useAccumulatedDailyRange<T>(args: AccumulatedDailyRangeArgs<T>): AccumulatedDailyRange<T> {
  const { code, baseKey, seedCalendarDays, today, historicalFromDate, enabled, fetchSlice, getMs } = args;
  const on = !!(code && enabled);
  const yesterday = subtractDaysKst(today, 1);
  const initialFrom = subtractDaysKst(today, seedCalendarDays);

  const hist = useInfiniteQuery({
    queryKey: [...baseKey, 'hist', today] as const,
    enabled: on,
    initialPageParam: { from: initialFrom, to: yesterday } as PageParam,
    queryFn: ({ pageParam }) => fetchSlice(code as string, pageParam.from, pageParam.to),
    getNextPageParam: (_lastPage, _allPages, lastPageParam): PageParam | undefined => {
      if (historicalFromDate == null || historicalFromDate >= lastPageParam.from) return undefined;
      return { from: historicalFromDate, to: subtractDaysKst(lastPageParam.from, 1) };
    },
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });

  const todayQ = useQuery({
    queryKey: [...baseKey, 'today', today] as const,
    enabled: on,
    queryFn: () => fetchSlice(code as string, today, today),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Bridge: settle-loop drops historicalFromDate → pull the next disjoint slice.
  // MUST wait for the seed page to land (`hist.data`): fetchNextPage is a no-op
  // while the initial query is still pending (no first page yet), and the bridge
  // only re-fires on a dep change — so firing it early (on the initialFrom
  // fallback) would silently never retry once the seed settles. A slow seed (the
  // investor endpoint can take ~2s) made this miss every extension. Gating on
  // `seedLoaded` flips wantsMore false→true exactly when the seed lands, which
  // re-triggers the effect with the first page in place. isFetchingNextPage
  // serializes against the settle-loop's isExtending edge.
  const seedLoaded = hist.data != null;
  const lowestRequestedFrom =
    (hist.data?.pageParams?.at(-1) as PageParam | undefined)?.from ?? initialFrom;
  const wantsMore =
    on && seedLoaded && historicalFromDate != null && historicalFromDate < lowestRequestedFrom;
  const { fetchNextPage, isFetchingNextPage } = hist;
  useEffect(() => {
    if (wantsMore && !isFetchingNextPage) fetchNextPage();
  }, [wantsMore, isFetchingNextPage, fetchNextPage]);

  const items = useMemo<T[]>(() => {
    const pages = hist.data?.pages;
    const todayItems = todayQ.data;
    if (!pages && !todayItems) return EMPTY as T[];
    // Dedup by ms (today overrides any same-key historical row at the rollover
    // boundary), then sort ascending.
    const byMs = new Map<number, T>();
    if (pages) for (const p of pages) for (const it of p) byMs.set(getMs(it), it);
    if (todayItems) for (const it of todayItems) byMs.set(getMs(it), it);
    return [...byMs.values()].sort((a, b) => getMs(a) - getMs(b));
  }, [hist.data?.pages, todayQ.data, getMs]);

  return {
    items,
    isLoading: on && hist.isLoading,
    isExtending: isFetchingNextPage,
    error: hist.error ?? todayQ.error ?? null,
  };
}
