import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { apiCall } from './client';
import { useSecondAggregates, type SecondAggregates } from './secondAggregates';
import type { LiveVenueOption } from '../state/liveVenue';
import { realMsToYyyymmdd, regularSessionOpenMs, regularSessionCloseMs, todayKstYyyymmdd } from '../live/liveDateTime';
import { isRegularSessionMs } from '../live/aggregateCandles';

export const SECOND_INITIAL_BARS = 240;
export const SECOND_HISTORY_PAGE_LIMIT = 64;
export type SecondTradeDatesResponse = { dates: string[] };
export type SecondHistoryOptions = { endMs?: number; fromMs?: number; live?: boolean; includePrices?: boolean };
type PageParam = { date: string; endMs: number | null };
type Page = { result: SecondAggregates; fromMs: number; includesPrices?: boolean };
const midnight = (date: string) => Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T00:00:00+09:00`);

export async function fetchSecondPage(code: string, venue: LiveVenueOption, seconds: SecondAggregates['seconds'], page: PageParam, signal: AbortSignal, regularSessionOnly = false, options: SecondHistoryOptions = {}): Promise<Page> {
  const dayStart = regularSessionOnly ? regularSessionOpenMs(page.date) : midnight(page.date);
  const start = Math.max(dayStart, options.fromMs ?? dayStart);
  // Include the 15:30:00 closing execution's one-second source bucket.
  const sessionEnd = regularSessionOnly ? regularSessionCloseMs(page.date) + 1000 : midnight(page.date) + 86_400_000;
  let end = Math.min(page.endMs ?? sessionEnd, sessionEnd);
  if (end <= start) return { fromMs: start, includesPrices: options.includePrices, result: { code, venue, date: page.date, seconds,
    source: null, status: 'unavailable', coverage: 'unverified', storage_error: null,
    first_observed_ms: null, last_observed_ms: null, bars: [], prices: [] } };
  const read = (from: number) => apiCall<SecondAggregates>(`/api/live/second-aggregates?${new URLSearchParams({ code, venue, date: page.date, seconds: String(seconds), include_prices: String(options.includePrices ?? false), regular_session_only: String(regularSessionOnly), from_ms: String(from), to_ms: String(end) })}`, { signal });
  let from = Math.max(start, end - SECOND_INITIAL_BARS * seconds * 1000);
  let result = await read(from);
  if (!result.bars.length && result.last_observed_ms !== null && result.last_observed_ms < from && result.last_observed_ms >= start) {
    end = Math.min(end, Math.floor(result.last_observed_ms / (seconds * 1000)) * seconds * 1000 + seconds * 1000);
    from = Math.max(start, end - SECOND_INITIAL_BARS * seconds * 1000);
    result = await read(from);
  }
  return { result, fromMs: from, includesPrices: options.includePrices };
}

export function nextSecondPage(last: Page, dates: string[], regularSessionOnly = false): PageParam | undefined {
  if (last.result.first_observed_ms !== null && last.fromMs > (regularSessionOnly ? Math.max(regularSessionOpenMs(last.result.date), last.result.first_observed_ms) : last.result.first_observed_ms)) {
    return { date: last.result.date, endMs: last.fromMs };
  }
  const previous = dates.filter(date => date < last.result.date).sort().at(-1);
  return previous ? { date: previous, endMs: null } : undefined;
}

function secondHistoryKey(code: string | null, venue: LiveVenueOption, date: string, seconds: number, regular: boolean, options: SecondHistoryOptions) {
  const base = ['second-history', code, venue, date, seconds, regular];
  return options.endMs !== undefined || options.fromMs !== undefined || options.includePrices
    ? [...base, options.endMs ?? null, options.fromMs ?? null, options.includePrices ?? false] : base;
}

/** A tape jump may cross a long unobserved interval or the ordinary 64-page
 * scrollback budget. Read one bounded chart slice at that time, then let the
 * existing prepend/viewport writer own its installation. */
export async function loadSecondHistoryAt(client: QueryClient, code: string, venue: LiveVenueOption,
  date: string, seconds: SecondAggregates['seconds'], regularSessionOnly: boolean, cursorMs: number, options: SecondHistoryOptions = {}) {
  const key = secondHistoryKey(code, venue, date, seconds, regularSessionOnly, options);
  const pageParam = { date: realMsToYyyymmdd(cursorMs), endMs: cursorMs + seconds * 1000 };
  const page = await client.fetchQuery({ queryKey: [...key, 'at', cursorMs],
    queryFn: ({ signal }) => fetchSecondPage(code, venue, seconds, pageParam, signal, regularSessionOnly, options),
    staleTime: Infinity, retry: false });
  client.setQueryData<InfiniteData<Page, PageParam>>(key, old => {
    if (!old || old.pageParams.some(p => p.date === pageParam.date && p.endMs === pageParam.endMs)) return old;
    const entries = [...old.pages.map((value, i) => ({ page: value, param: old.pageParams[i] })), { page, param: pageParam }]
      .sort((a, b) => b.param.date.localeCompare(a.param.date) || b.page.fromMs - a.page.fromMs);
    return { pages: entries.map(e => e.page), pageParams: entries.map(e => e.param) };
  });
}

export function useSecondHistory(code: string | null, venue: LiveVenueOption, date: string, seconds: SecondAggregates['seconds'], regularSessionOnly = false, options: SecondHistoryOptions = {}) {
  const client = useQueryClient();
  const { endMs, fromMs, includePrices } = options;
  const plainKey = secondHistoryKey(code, venue, date, seconds, regularSessionOnly, { ...options, includePrices: false });
  const pricesKey = secondHistoryKey(code, venue, date, seconds, regularSessionOnly, { ...options, includePrices: true });
  // Adding a trade pane must enrich all loaded pages, rather than replacing a
  // panned historical viewport with the initial latest page. Once enriched,
  // retain that history even when the pane is hidden again.
  const historyPrices = !!includePrices || client.getQueryData(pricesKey) !== undefined;
  const historyOptions = { ...options, includePrices: historyPrices };
  const loadAt = useCallback((cursorMs: number) => code
    ? loadSecondHistoryAt(client, code, venue, date, seconds, regularSessionOnly, cursorMs, { endMs, fromMs, includePrices: historyPrices }) : Promise.resolve(),
  [client, code, venue, date, seconds, regularSessionOnly, endMs, fromMs, historyPrices]);
  const catalog = useQuery({ queryKey: ['second-trade-dates', code, venue], enabled: code !== null,
    queryFn: ({ signal }) => apiCall<SecondTradeDatesResponse>(`/api/live/second-trade-dates?${new URLSearchParams({ code: code!, venue })}`, { signal }),
    staleTime: 30_000 });
  const history = useInfiniteQuery({ queryKey: historyPrices ? pricesKey : plainKey, enabled: code !== null,
    initialData: () => historyPrices ? client.getQueryData<InfiniteData<Page, PageParam>>(plainKey) : undefined,
    initialPageParam: { date, endMs: options.endMs ?? null } as PageParam,
    queryFn: ({ pageParam, signal }) => fetchSecondPage(code!, venue, seconds, pageParam, signal, regularSessionOnly, historyOptions),
    getNextPageParam: (last, pages) => {
      if (pages.length >= SECOND_HISTORY_PAGE_LIMIT || (options.fromMs !== undefined && last.fromMs <= options.fromMs)) return undefined;
      const next = nextSecondPage(last, catalog.data?.dates ?? [], regularSessionOnly);
      return next && (options.fromMs === undefined || next.date >= realMsToYyyymmdd(options.fromMs)) ? next : undefined;
    },
    staleTime: query => historyPrices && query.state.data?.pages.some(page => !page.includesPrices) ? 0 : Infinity });
  const first = history.data?.pages[0];
  const liveFromMs = useMemo(() => {
    const loaded = history.data?.pages.filter(page => page.result.date === date).map(page => page.fromMs) ?? [];
    return loaded.length ? Math.min(...loaded) : first?.fromMs ?? null;
  }, [history.data, date, first?.fromMs]);
  const live = useSecondAggregates(options.live !== false && date === todayKstYyyymmdd() && first ? code : null, venue, date, liveFromMs, options.includePrices ?? false, seconds, regularSessionOnly);
  const historicalBars = useMemo(() => {
    const merged = new Map(history.data?.pages.flatMap(page => page.result.bars.map(bar => [bar.t_ms, bar] as const)) ?? []);
    return [...merged.values()].filter(bar => !regularSessionOnly || isRegularSessionMs(bar.t_ms)).sort((a, b) => a.t_ms - b.t_ms);
  }, [history.data, regularSessionOnly]);
  const bars = useMemo(() => mergeSecondBars(historicalBars, live.data?.bars ?? []), [historicalBars, live.data?.bars]);
  const prices = useMemo(() => {
    if (!options.includePrices) return [];
    const cells = new Map<string, SecondAggregates['prices'][number]>();
    for (const page of history.data?.pages ?? []) for (const cell of page.result.prices) {
      if (live.data && realMsToYyyymmdd(cell.t_ms) === date && cell.t_ms >= (liveFromMs ?? 0)) continue;
      cells.set(`${cell.t_ms}|${cell.price}|${cell.side}`, cell);
    }
    for (const cell of live.data?.prices ?? []) cells.set(`${cell.t_ms}|${cell.price}|${cell.side}`, cell);
    return [...cells.values()].filter(p => !regularSessionOnly || isRegularSessionMs(p.t_ms)).sort((a, b) => a.t_ms - b.t_ms);
  }, [options.includePrices, history.data, live.data, date, liveFromMs, regularSessionOnly]);
  return { ...history, bars, prices, loadAt, oldestLoadedMs: history.data?.pages.at(-1)?.fromMs ?? null,
    catalogPending: catalog.isPending, catalogError: catalog.isError, refetchCatalog: catalog.refetch,
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
