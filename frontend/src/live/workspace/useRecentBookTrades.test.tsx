import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiCall } from '../../api/client';
import { useTradeHistory, type TradeHistoryResponse } from '../../api/tradeHistory';
import type { TradeSnapshot } from '../bucketHogaSeries';
import { useRecentBookTrades } from './useRecentBookTrades';

vi.mock('../../api/client', () => ({ apiCall: vi.fn() }));
const T = Date.UTC(2026, 9, 21, 1);
const source = { code: '005930', date: '20261021', venue: 'KRX' };
const options = { ...source, frames: [] as TradeSnapshot[], enabled: true };
const frame = (qty: number): TradeSnapshot => ({ t_ms: T + qty * 1000, cum_volume: qty * 10,
  trades: [{ price: 70000 + qty, qty, side: 1 }] });
function response(scope = source): TradeHistoryResponse {
  return { ...scope, rows: Array.from({ length: 12 }, (_, i) => {
    const qty = 12 - i;
    return { event_id: `rest-${qty}`, t_ms: T + qty * 1000, price: 70000 + qty, qty, side: 1, cum_volume: qty * 10 };
  }), latest_at_ms: T + 12000, latest_volume: 120, next_key: 'older', prev_close: 69000 };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
beforeEach(() => { vi.mocked(apiCall).mockReset(); });
afterEach(cleanup);

it('seeds both books from one shared tape query and keeps the initial page for scrolling without pagination', async () => {
  vi.mocked(apiCall).mockResolvedValue(response());
  const { wrapper } = setup();
  const { result } = renderHook(() => ({ book: useRecentBookTrades(options), order: useRecentBookTrades(options),
    tape: useTradeHistory(source.code, source.date, source.venue) }), { wrapper });
  await waitFor(() => expect(result.current.book).toHaveLength(12));
  expect(result.current.order).toEqual(result.current.book);
  expect(result.current.book.map(tick => tick.qty)).toEqual(Array.from({ length: 12 }, (_, i) => 12 - i));
  expect(result.current.tape.data?.pages).toHaveLength(1);
  expect(apiCall).toHaveBeenCalledTimes(1);
});

it('keeps arriving WS ticks while REST is pending, removes overlap, and retains the recent window after buffer eviction', async () => {
  let resolve!: (value: TradeHistoryResponse) => void;
  vi.mocked(apiCall).mockImplementation(() => new Promise(done => { resolve = done; }));
  const { wrapper } = setup();
  const { result, rerender } = renderHook(props => useRecentBookTrades(props), {
    wrapper, initialProps: { ...options, frames: [frame(12), frame(13)] },
  });
  expect(result.current.map(tick => tick.qty)).toEqual([13, 12]);
  await act(async () => resolve(response()));
  await waitFor(() => expect(result.current.map(tick => tick.qty)).toEqual(Array.from({ length: 13 }, (_, i) => 13 - i)));
  rerender({ ...options, frames: [] });
  expect(result.current.map(tick => tick.qty)).toEqual(Array.from({ length: 13 }, (_, i) => 13 - i));
  expect(apiCall).toHaveBeenCalledTimes(1);
});

it('falls back to valid current-day WS data on API failure', async () => {
  vi.mocked(apiCall).mockRejectedValue(new Error('unavailable'));
  const { client, wrapper } = setup();
  const { result } = renderHook(() => useRecentBookTrades({ ...options, frames: [
    { ...frame(1), t_ms: T - 86400000 }, frame(2),
  ] }), { wrapper });
  await waitFor(() => expect(client.getQueryState(['live', 'trade-history', source.code, source.date, source.venue])?.status).toBe('error'));
  expect(result.current.map(tick => tick.qty)).toEqual([2]);
});

it('does not fetch or expose cached current data when disabled for a spot cursor or single-price book', () => {
  const { client, wrapper } = setup();
  client.setQueryData(['live', 'trade-history', source.code, source.date, source.venue], { pages: [response()], pageParams: [null] });
  const { result, rerender } = renderHook(props => useRecentBookTrades(props), { wrapper,
    initialProps: { ...options, frames: [frame(13)], enabled: false } });
  expect(result.current).toEqual([]);
  expect(apiCall).not.toHaveBeenCalled();
  rerender({ ...options, frames: [frame(13)], enabled: true });
  expect(result.current.map(tick => tick.qty)).toEqual(Array.from({ length: 13 }, (_, i) => 13 - i));
  expect(apiCall).not.toHaveBeenCalled();
});

it.each([{ code: '000660' }, { venue: 'NXT' }, { date: '20261022' }])('clears the previous scope immediately when %j changes', async change => {
  vi.mocked(apiCall).mockResolvedValueOnce(response());
  const { wrapper } = setup();
  const { result, rerender } = renderHook(props => useRecentBookTrades(props), { wrapper,
    initialProps: { ...options, frames: [frame(13)] } });
  await waitFor(() => expect(result.current).toHaveLength(13));
  vi.mocked(apiCall).mockImplementationOnce(() => new Promise(() => {}));
  rerender({ ...options, ...change });
  expect(result.current).toEqual([]);
  await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(2));
});

it('ignores mismatched response metadata rather than showing another symbol or venue', async () => {
  vi.mocked(apiCall).mockResolvedValue(response({ ...source, code: '000660' }));
  const { client, wrapper } = setup();
  const { result } = renderHook(() => useRecentBookTrades({ ...options, frames: [frame(13)] }), { wrapper });
  await waitFor(() => expect(client.getQueryState(['live', 'trade-history', source.code, source.date, source.venue])?.status).toBe('success'));
  expect(result.current.map(tick => tick.qty)).toEqual([13]);
});

it('caps a large shared initial page at 200 without requesting another page', async () => {
  const page = response();
  page.rows = Array.from({ length: 250 }, (_, index) => ({ ...page.rows[0], event_id: `row-${index}`,
    t_ms: T - index * 1000, qty: index + 1, cum_volume: null }));
  page.latest_volume = null;
  page.latest_at_ms = T;
  vi.mocked(apiCall).mockResolvedValue(page);
  const { wrapper } = setup();
  const { result } = renderHook(() => useRecentBookTrades(options), { wrapper });
  await waitFor(() => expect(result.current).toHaveLength(200));
  expect(result.current.at(-1)?.qty).toBe(200);
  expect(apiCall).toHaveBeenCalledTimes(1);
});
