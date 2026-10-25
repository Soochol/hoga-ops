import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { nextSecondPage, fetchSecondPage, SECOND_INITIAL_BARS, SECOND_HISTORY_PAGE_LIMIT, loadSecondHistoryAt, useSecondHistory } from './secondHistory';
import { apiCall } from './client';
vi.mock('./client', () => ({ apiCall: vi.fn() }));
describe('second history paging', () => {
  it('pages within a day before skipping weekends to the previous captured day', () => {
    const page = { fromMs: 2000, result: { date: '20260928', first_observed_ms: 1000 } } as Parameters<typeof nextSecondPage>[0];
    expect(nextSecondPage(page, ['20260925', '20260928'])).toEqual({ date: '20260928', endMs: 2000 });
    page.fromMs = 1000;
    expect(nextSecondPage(page, ['20260925', '20260928'])).toEqual({ date: '20260925', endMs: null });
    expect(nextSecondPage(page, [])).toBeUndefined();
  });
  it('finds the last observations and fetches a bounded initial window', async () => {
    const last = Date.parse('2026-09-28T15:30:00+09:00');
    vi.mocked(apiCall).mockResolvedValueOnce({ bars: [], last_observed_ms: last })
      .mockResolvedValueOnce({ bars: [{ t_ms: last }], last_observed_ms: last });
    const page = await fetchSecondPage('042700', 'KRX', 5, { date: '20260928', endMs: null }, new AbortController().signal);
    expect(page.fromMs).toBe(last + 5000 - SECOND_INITIAL_BARS * 5000);
    expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('to_ms=' + (last + 5000));
  });
});

it('a tape jump reads one bounded target slice beyond the manual page budget and installs it without losing history', async () => {
  vi.mocked(apiCall).mockReset();
  const client = new QueryClient();
  const T = Date.parse('2026-09-29T09:00:00+09:00');
  const key = ['second-history', '042700', 'KRX', '20261001', 1, false];
  const pages = Array.from({ length: 64 }, (_, i) => ({ fromMs: T + (i + 1) * 60000,
    result: { date: '20260929', bars: [{ t_ms: T + (i + 1) * 60000 }] } }));
  client.setQueryData(key, { pages, pageParams: pages.map(p => ({ date: '20260929', endMs: p.fromMs + 240000 })) });
  vi.mocked(apiCall).mockResolvedValue({ date: '20260929', bars: [{ t_ms: T }], first_observed_ms: T, last_observed_ms: T });
  await loadSecondHistoryAt(client, '042700', 'KRX', '20261001', 1, false, T);
  expect(apiCall).toHaveBeenCalledOnce();
  const params = new URL(vi.mocked(apiCall).mock.calls[0][0], 'http://test').searchParams;
  expect(params.get('date')).toBe('20260929');
  expect(Number(params.get('to_ms')) - Number(params.get('from_ms'))).toBe(240000);
  const data = client.getQueryData<{ pages: typeof pages }>(key)!;
  expect(data.pages).toHaveLength(65);
  expect(data.pages.at(-1)!.result.bars[0].t_ms).toBe(T);
  await loadSecondHistoryAt(client, '042700', 'KRX', '20261001', 1, false, T);
  expect(apiCall).toHaveBeenCalledOnce();
  expect(client.getQueryData<{ pages: typeof pages }>(key)!.pages).toHaveLength(65);
  client.clear();
});

it('requests a selected past range directly, including prices, without falling back before its floor', async () => {
  vi.mocked(apiCall).mockClear();
  const from = Date.parse('2026-09-28T10:00:00+09:00'), end = from + 60000;
  vi.mocked(apiCall).mockResolvedValue({ bars: [], prices: [], last_observed_ms: from - 1000 });
  const result = await fetchSecondPage('005930', 'KRX', 5, { date: '20260928', endMs: end }, new AbortController().signal, false, { fromMs: from, includePrices: true });
  expect(vi.mocked(apiCall)).toHaveBeenCalledOnce();
  const url = new URL(String(vi.mocked(apiCall).mock.calls[0][0]), 'http://localhost');
  expect(url.searchParams.get('from_ms')).toBe(String(from));
  expect(url.searchParams.get('to_ms')).toBe(String(end));
  expect(url.searchParams.get('include_prices')).toBe('true');
  expect(result.fromMs).toBe(from);
});

it('returns an honest empty interval when a selected period is outside the regular-session filter', async () => {
  vi.mocked(apiCall).mockClear();
  const from = Date.parse('2026-09-28T08:00:00+09:00');
  const page = await fetchSecondPage('005930', 'KRX', 5, { date: '20260928', endMs: from + 60000 }, new AbortController().signal, true, { fromMs: from });
  expect(page.result.bars).toEqual([]);
  expect(vi.mocked(apiCall)).not.toHaveBeenCalled();
});

it('enriches every loaded page with trade quantities and retains that history when the pane is hidden', async () => {
  vi.mocked(apiCall).mockReset();
  const start = Date.parse('2026-09-28T09:00:00+09:00'), end = start + 480000;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const bar = (t_ms: number) => ({ t_ms, open: 10, high: 10, low: 10, close: 10, volume: 3, count: 1, trade_value: 30 });
  const resultAt = (from: number) => ({ code: '005930', venue: 'KRX', date: '20260928', seconds: 1,
    source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null,
    first_observed_ms: start, last_observed_ms: end - 1000, bars: [bar(from)], prices: [] });
  client.setQueryData(['second-history', '005930', 'KRX', '20260928', 1, false, end, start, false], {
    pages: [start + 240000, start].map(fromMs => ({ fromMs, result: resultAt(fromMs) })),
    pageParams: [{ date: '20260928', endMs: end }, { date: '20260928', endMs: start + 240000 }],
  });
  vi.mocked(apiCall).mockImplementation(async path => {
    const url = new URL(path, 'http://test');
    if (url.pathname.endsWith('second-trade-dates')) return { dates: ['20260928'] } as never;
    const from = Number(url.searchParams.get('from_ms'));
    return { ...resultAt(from), prices: [{ t_ms: from, price: 10, side: 1, qty: 3, count: 1 }] } as never;
  });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(({ includePrices }) => useSecondHistory('005930', 'KRX', '20260928', 1, false,
    { fromMs: start, endMs: end, live: false, includePrices }), { wrapper, initialProps: { includePrices: false } });
  expect(hook.result.current.bars.map(b => b.t_ms)).toEqual([start, start + 240000]);
  hook.rerender({ includePrices: true });
  expect(hook.result.current.bars.map(b => b.t_ms)).toEqual([start, start + 240000]);
  await waitFor(() => expect(hook.result.current.prices).toHaveLength(2));
  expect(hook.result.current.data?.pages).toHaveLength(2);
  hook.rerender({ includePrices: false });
  expect(hook.result.current.bars.map(b => b.t_ms)).toEqual([start, start + 240000]);
  expect(hook.result.current.prices).toEqual([]);
  hook.unmount();
  client.clear();
});

it.each(['page limit', 'selected floor'] as const)('stops cursor paging at the %s even when older observations exist', async stop => {
  vi.mocked(apiCall).mockReset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const start = Date.parse('2026-09-28T09:00:00+09:00'), date = '20260928';
  const count = stop === 'page limit' ? SECOND_HISTORY_PAGE_LIMIT - 1 : 1;
  const page = (fromMs: number) => ({ fromMs, result: { code: '005930', venue: 'KRX', date, seconds: 1,
    source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null,
    first_observed_ms: start - 3600000, last_observed_ms: start + 20000000,
    bars: [{ t_ms: fromMs, open: 10, high: 10, low: 10, close: 10, volume: 1, count: 1, trade_value: 10 }], prices: [] } });
  const options = stop === 'selected floor' ? { fromMs: start, live: false } : { live: false };
  const key = ['second-history', '005930', 'KRX', date, 1, false,
    ...(stop === 'selected floor' ? [null, start, false] : [])];
  client.setQueryData(['second-trade-dates', '005930', 'KRX'], { dates: ['20260925', date] });
  const pages = Array.from({ length: count }, (_, i) => page(start + (count - i) * 240000));
  client.setQueryData(key, { pages, pageParams: pages.map(p => ({ date, endMs: p.fromMs + 240000 })) });
  vi.mocked(apiCall).mockResolvedValue(page(start).result);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useSecondHistory('005930', 'KRX', date, 1, false, options), { wrapper });
  expect(hook.result.current.hasNextPage).toBe(true);
  await act(async () => { await hook.result.current.fetchNextPage(); });
  await waitFor(() => expect(hook.result.current.hasNextPage).toBe(false));
  expect(hook.result.current.data?.pages).toHaveLength(count + 1);
  await act(async () => { await hook.result.current.fetchNextPage(); });
  expect(apiCall).toHaveBeenCalledOnce();
  hook.unmount();
  client.clear();
});
