import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeUsMinuteBars, retainUsMinuteWindow, useUsStockMinutes, type UsStockMinuteResponse } from './usDailyCandles';
import type { LiveInstrument } from '../live/liveInstrument';

const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./client', () => ({ apiCall: (...args: unknown[]) => mock.call(...args) }));
const stock: LiveInstrument = { kind: 'us_stock', exchange: 'NASDAQ', symbol: 'NVDA', label: 'NVDA' };
const payload = (times: number[], cursor: string | null): UsStockMinuteResponse => ({
  instrument_key: 'us-stock:NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA', timeframe: '1m', from: '20261016', to: '20261016',
  candles: times.map(t_ms => ({ t_ms, trading_date: '20261016', open: 10, high: 11, low: 9, close: 10, volume: 1 })),
  minute_metadata: { source: 'kiwoom', market_timezone: 'America/New_York', history_scope: 'bounded_recent_window',
    session_scope: 'vendor_extended_unverified', delay_status: 'unverified', available_from_ms: times[0], available_to_ms: times.at(-1)!,
    last_successful_check_at_ms: 1, refresh_status: 'normal', messages: [], price_basis: 'raw', currency: 'USD',
    bar_limit: 800, pages_fetched: 1, more_available: !!cursor, next_cursor: cursor },
});
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
async function flush(ms = 10) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => { vi.useFakeTimers(); mock.call.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); });
afterEach(() => { cleanup(); client.clear(); vi.clearAllTimers(); vi.useRealTimers(); });

it('preserves oldest cursor and data across polling while replacing overlap with newer prices', () => {
  const old = payload([100, 200, 300], 'before100');
  const latest = payload([300, 400], 'before300'); latest.candles[0].close = 10.5;
  const merged = retainUsMinuteWindow(old, latest);
  expect(merged.candles.map(c => c.t_ms)).toEqual([100, 200, 300, 400]);
  expect(merged.candles[2].close).toBe(10.5);
  expect(merged.minute_metadata.next_cursor).toBe('before100');
  expect(mergeUsMinuteBars(old.candles, latest.candles)).toEqual(merged.candles);
});

it('loads on demand, deduplicates concurrent gestures, stops at end and polls only latest', async () => {
  let finish!: (p: UsStockMinuteResponse) => void;
  mock.call.mockImplementation((url: string) => url.includes('cursor=') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(payload([300, 400], 'older')));
  const { result } = renderHook(() => useUsStockMinutes(stock, '1m'), { wrapper });
  await flush(); expect(mock.call).toHaveBeenCalledOnce();
  act(() => { result.current.loadOlder(); result.current.loadOlder(); });
  await flush(); expect(mock.call).toHaveBeenCalledTimes(2);
  await act(async () => finish(payload([100, 200, 300], null))); await flush();
  expect(result.current.data?.candles.map(c => c.t_ms)).toEqual([100, 200, 300, 400]);
  expect(result.current.historyHasMore).toBe(false);
  mock.call.mockResolvedValue(payload([400, 500], 'newer-root'));
  await flush(60_000);
  expect(result.current.data?.candles.map(c => c.t_ms)).toEqual([100, 200, 300, 400, 500]);
  expect(mock.call.mock.calls.filter(([url]) => String(url).includes('cursor='))).toHaveLength(1);
});

it('keeps data on failure and retries the same cursor without duplicates', async () => {
  let fail = true;
  mock.call.mockImplementation((url: string) => url.includes('cursor=')
    ? fail ? Promise.reject(new Error('temporary')) : Promise.resolve(payload([100, 200, 300], null))
    : Promise.resolve(payload([300, 400], 'older')));
  const { result } = renderHook(() => useUsStockMinutes(stock, '1m'), { wrapper });
  await flush(); act(() => result.current.loadOlder()); await flush();
  expect(result.current.historyError).toBeTruthy(); expect(result.current.data?.candles).toHaveLength(2);
  fail = false; act(() => result.current.retryHistory()); await flush();
  expect(result.current.historyError).toBeNull();
  expect(result.current.data?.candles.map(c => c.t_ms)).toEqual([100, 200, 300, 400]);
  expect(mock.call.mock.calls.filter(([url]) => String(url).includes('cursor=')).map(([url]) => url)).toEqual([
    expect.stringContaining('cursor=older'), expect.stringContaining('cursor=older')]);
});

it('isolates pending pages when the instrument switches', async () => {
  let finish!: (p: UsStockMinuteResponse) => void;
  mock.call.mockImplementation((url: string) => url.includes('cursor=') ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(url.includes('symbol=NVDA') ? payload([300, 400], 'older') : { ...payload([900], null), symbol: 'AAPL', instrument_key: 'us-stock:NASDAQ:AAPL' }));
  const { result, rerender } = renderHook(({ instrument }) => useUsStockMinutes(instrument, '1m'), { wrapper, initialProps: { instrument: stock } });
  await flush(); act(() => result.current.loadOlder()); await flush();
  rerender({ instrument: { ...stock, symbol: 'AAPL' } }); await flush();
  await act(async () => finish(payload([100, 200], null))); await flush();
  expect(result.current.data?.instrument_key).toBe('us-stock:NASDAQ:AAPL');
  expect(result.current.data?.candles.map(c => c.t_ms)).toEqual([900]);
});

it('replaces retained history and cursor when the adjustment anchor or basis changes', () => {
  const old = payload([100, 200, 300], 'old-cursor');
  old.minute_metadata = { ...old.minute_metadata, price_basis: 'adjusted', adjusted_as_of: '20261016' };
  const next = payload([300, 400], 'new-cursor');
  next.minute_metadata = { ...next.minute_metadata, price_basis: 'adjusted', adjusted_as_of: '20261019' };
  next.candles.forEach(c => { c.close = 1; });
  expect(retainUsMinuteWindow(old, next)).toBe(next);
  expect(retainUsMinuteWindow({ ...old, minute_metadata: { ...old.minute_metadata, adjusted_as_of: '20261019', price_basis: 'raw' } }, next)).toBe(next);
});

it('isolates an in-flight old history page when a newer adjustment anchor arrives', async () => {
  let finish!: (p: UsStockMinuteResponse) => void;
  const previous = payload([300, 400], 'old-cursor');
  previous.minute_metadata = { ...previous.minute_metadata, price_basis: 'adjusted', adjusted_as_of: '20261016' };
  mock.call.mockImplementation((url: string) => url.includes('cursor=')
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(previous));
  const { result } = renderHook(() => useUsStockMinutes(stock, '1m'), { wrapper });
  await flush(); act(() => result.current.loadOlder()); await flush();
  const next = payload([400, 500], 'new-cursor');
  next.minute_metadata = { ...next.minute_metadata, price_basis: 'adjusted', adjusted_as_of: '20261019' };
  next.candles.forEach(c => { c.close = 1; });
  mock.call.mockImplementation(() => Promise.resolve(next));
  await flush(60_000);
  const oldPage = payload([100, 200], null);
  oldPage.minute_metadata = { ...oldPage.minute_metadata, price_basis: 'adjusted', adjusted_as_of: '20261016' };
  await act(async () => finish(oldPage)); await flush();
  expect(result.current.data?.candles.map(c => c.t_ms)).toEqual([400, 500]);
  expect(result.current.data?.candles.every(c => c.close === 1)).toBe(true);
  act(() => result.current.loadOlder()); await flush();
  expect(mock.call.mock.calls.at(-1)?.[0]).toContain('cursor=new-cursor');
});
