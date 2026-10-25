import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { apiCall } from './client';
import { useSecondAggregates, type SecondAggregates } from './secondAggregates';
import type { LiveVenueOption } from '../state/liveVenue';
import { regularSessionOpenMs, regularSessionCloseMs } from '../live/liveDateTime';
import { isRegularSessionMs } from '../live/aggregateCandles';
import { realMsToYyyymmdd, todayKstYyyymmdd } from '../live/liveDateTime';

export const SECOND_INITIAL_BARS = 240;
export const SECOND_HISTORY_PAGE_LIMIT = 64;
export type SecondTradeDatesResponse = { dates: string[] };
type PageParam = { date: string; endMs: number | null };
type Page = { result: SecondAggregates; fromMs: number };
const midnight = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+09:00`);

export async function fetchSecondPage(code: string, venue: LiveVenueOption, seconds: SecondAggregates['seconds'], page: PageParam, signal: AbortSignal, regularSessionOnly = false): Promise<Page> {
  const start = regularSessionOnly ? regularSessionOpenMs(page.date) : midnight(page.date);
  // Include the 15:30:00 closing execution's one-second source bucket.
  const sessionEnd = regularSessionOnly ? regularSessionCloseMs(page.date) + 1000 : start + 86_400_000;
  let end = Math.min(page.endMs ?? sessionEnd, sessionEnd);
  const read = (from: number) => apiCall<SecondAggregates>(`/api/live/second-aggregates?${new URLSearchParams({ code, venue, date: page.date, seconds: String(seconds), regular_session_only: String(regularSessionOnly), from_ms: String(from), to_ms: String(end) })}`, { signal });
  let from = Math.max(start, end - SECOND_INITIAL_BARS * seconds * 1000);
  let result = await read(from);
  if (!result.bars.length && result.last_observed_ms !== null && result.last_observed_ms < from) {
    end = Math.min(end, Math.floor(result.last_observed_ms / (seconds * 1000)) * seconds * 1000 + seconds * 1000);
    from = Math.max(start, end - SECOND_INITIAL_BARS * seconds * 1000);
    result = await read(from);
  }
  return { result, fromMs: from };
}

export function nextSecondPage(last: Page, dates: string[], regularSessionOnly = false): PageParam | undefined {
  if (last.result.first_observed_ms !== null && last.fromMs > (regularSessionOnly ? Math.max(regularSessionOpenMs(last.result.date), last.result.first_observed_ms) : last.result.first_observed_ms)) {
    return { date: last.result.date, endMs: last.fromMs };
  }
  const previous = dates.filter(date => date < last.result.date).sort().at(-1);
  return previous ? { date: previous, endMs: null } : undefined;
}

/** A tape jump may cross a long unobserved interval or the ordinary 64-page
 * scrollback budget. Read one bounded chart slice at that time, then let the
 * existing prepend/viewport writer own its installation. */
export async function loadSecondHistoryAt(client: QueryClient, code: string, venue: LiveVenueOption,
  date: string, seconds: SecondAggregates['seconds'], regularSessionOnly: boolean, cursorMs: number) {
  const key = ['second-history', code, venue, date, seconds, regularSessionOnly];
  const pageParam = { date: realMsToYyyymmdd(cursorMs), endMs: cursorMs + seconds * 1000 };
  const page = await client.fetchQuery({ queryKey: [...key, 'at', cursorMs],
    queryFn: ({ signal }) => fetchSecondPage(code, venue, seconds, pageParam, signal, regularSessionOnly),
    staleTime: Infinity, retry: false });
  client.setQueryData<InfiniteData<Page, PageParam>>(key, old => {
    if (!old || old.pageParams.some(p => p.date === pageParam.date && p.endMs === pageParam.endMs)) return old;
    const entries = [...old.pages.map((value, i) => ({ page: value, param: old.pageParams[i] })), { page, param: pageParam }]
      .sort((a, b) => b.param.date.localeCompare(a.param.date) || b.page.fromMs - a.page.fromMs);
    return { pages: entries.map(e => e.page), pageParams: entries.map(e => e.param) };
  });
}

export function useSecondHistory(code: string | null, venue: LiveVenueOption, date: string, seconds: SecondAggregates['seconds'], regularSessionOnly = false) {
  const client = useQueryClient();
  const loadAt = useCallback((cursorMs: number) => code
    ? loadSecondHistoryAt(client, code, venue, date, seconds, regularSessionOnly, cursorMs) : Promise.resolve(),
  [client, code, venue, date, seconds, regularSessionOnly]);
  const catalog = useQuery({ queryKey: ['second-trade-dates', code, venue], enabled: code !== null,
    queryFn: ({ signal }) => apiCall<SecondTradeDatesResponse>(`/api/live/second-trade-dates?${new URLSearchParams({ code: code!, venue })}`, { signal }),
    staleTime: 30_000 });
  const history = useInfiniteQuery({ queryKey: ['second-history', code, venue, date, seconds, regularSessionOnly], enabled: code !== null,
    initialPageParam: { date, endMs: null } as PageParam,
    queryFn: ({ pageParam, signal }) => fetchSecondPage(code!, venue, seconds, pageParam, signal, regularSessionOnly),
    getNextPageParam: (last, pages) => pages.length < SECOND_HISTORY_PAGE_LIMIT ? nextSecondPage(last, catalog.data?.dates ?? [], regularSessionOnly) : undefined,
    staleTime: Infinity });
  const first = history.data?.pages[0];
  const liveFromMs = useMemo(() => {
    const loaded = history.data?.pages.filter(page => page.result.date === date).map(page => page.fromMs) ?? [];
    return loaded.length ? Math.min(...loaded) : first?.fromMs ?? null;
  }, [history.data, date, first?.fromMs]);
  const live = useSecondAggregates(date === todayKstYyyymmdd() && first ? code : null, venue, date, liveFromMs, false, seconds, regularSessionOnly);
  const historicalBars = useMemo(() => {
    const merged = new Map(history.data?.pages.flatMap(page => page.result.bars.map(bar => [bar.t_ms, bar] as const)) ?? []);
    return [...merged.values()].filter(bar => !regularSessionOnly || isRegularSessionMs(bar.t_ms)).sort((a, b) => a.t_ms - b.t_ms);
  }, [history.data, regularSessionOnly]);
  const bars = useMemo(() => mergeSecondBars(historicalBars, live.data?.bars ?? []), [historicalBars, live.data?.bars]);
  return { ...history, bars, loadAt, catalogPending: catalog.isPending, catalogError: catalog.isError,
    source: first?.result.source, storageError: live.data?.storage_error ?? first?.result.storage_error };
}

/** Both inputs are ordered. Live revisions replace matching historical bars. */
export function mergeSecondBars(history: readonly SecondAggregates['bars'][number][], live: readonly SecondAggregates['bars'][number][]): SecondAggregates['bars'] {
  if (!live.length) return history as SecondAggregates['bars'];
  const result: SecondAggregates['bars'] = [];
  let h = 0, l = 0;
  while (h < history.length && l < live.length) {
    if (history[h].t_ms < live[l].t_ms) result.push(history[h++]);
    else {
      if (history[h].t_ms === live[l].t_ms) h++;
      result.push(live[l++]);
    }
  }
  while (h < history.length) result.push(history[h++]);
  while (l < live.length) result.push(live[l++]);
  return result;
}
