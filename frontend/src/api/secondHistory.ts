import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiCall } from './client';
import { useSecondAggregates, type SecondAggregates } from './secondAggregates';
import type { LiveVenueOption } from '../state/liveVenue';
import { todayKstYyyymmdd } from '../live/liveDateTime';

export const SECOND_INITIAL_BARS = 240;
export const SECOND_HISTORY_PAGE_LIMIT = 64;
export type SecondTradeDatesResponse = { dates: string[] };
type PageParam = { date: string; endMs: number | null };
type Page = { result: SecondAggregates; fromMs: number };
const midnight = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+09:00`);

export async function fetchSecondPage(code: string, venue: LiveVenueOption, seconds: SecondAggregates['seconds'], page: PageParam, signal: AbortSignal): Promise<Page> {
  const start = midnight(page.date);
  let end = page.endMs ?? start + 86_400_000;
  const read = (from: number) => apiCall<SecondAggregates>(`/api/live/second-aggregates?${new URLSearchParams({ code, venue, date: page.date, seconds: String(seconds), from_ms: String(from), to_ms: String(end) })}`, { signal });
  let from = Math.max(start, end - SECOND_INITIAL_BARS * seconds * 1000);
  let result = await read(from);
  if (!result.bars.length && result.last_observed_ms !== null && result.last_observed_ms < from) {
    end = Math.min(end, Math.floor(result.last_observed_ms / (seconds * 1000)) * seconds * 1000 + seconds * 1000);
    from = Math.max(start, end - SECOND_INITIAL_BARS * seconds * 1000);
    result = await read(from);
  }
  return { result, fromMs: from };
}

export function nextSecondPage(last: Page, dates: string[]): PageParam | undefined {
  if (last.result.first_observed_ms !== null && last.fromMs > last.result.first_observed_ms) {
    return { date: last.result.date, endMs: last.fromMs };
  }
  const previous = dates.filter(date => date < last.result.date).sort().at(-1);
  return previous ? { date: previous, endMs: null } : undefined;
}

export function useSecondHistory(code: string | null, venue: LiveVenueOption, date: string, seconds: SecondAggregates['seconds']) {
  const catalog = useQuery({ queryKey: ['second-trade-dates', code, venue], enabled: code !== null,
    queryFn: ({ signal }) => apiCall<SecondTradeDatesResponse>(`/api/live/second-trade-dates?${new URLSearchParams({ code: code!, venue })}`, { signal }),
    staleTime: 30_000 });
  const history = useInfiniteQuery({ queryKey: ['second-history', code, venue, date, seconds], enabled: code !== null,
    initialPageParam: { date, endMs: null } as PageParam,
    queryFn: ({ pageParam, signal }) => fetchSecondPage(code!, venue, seconds, pageParam, signal),
    getNextPageParam: (last, pages) => pages.length < SECOND_HISTORY_PAGE_LIMIT ? nextSecondPage(last, catalog.data?.dates ?? []) : undefined,
    staleTime: Infinity });
  const first = history.data?.pages[0];
  const live = useSecondAggregates(date === todayKstYyyymmdd() && first ? code : null, venue, date, first?.fromMs ?? null, false, seconds);
  const bars = useMemo(() => {
    const merged = new Map(history.data?.pages.flatMap(page => page.result.bars.map(bar => [bar.t_ms, bar] as const)) ?? []);
    for (const bar of live.data?.bars ?? []) merged.set(bar.t_ms, bar);
    return [...merged.values()].sort((a, b) => a.t_ms - b.t_ms);
  }, [history.data, live.data]);
  return { ...history, bars, catalogPending: catalog.isPending, catalogError: catalog.isError,
    source: first?.result.source, storageError: live.data?.storage_error ?? first?.result.storage_error };
}
