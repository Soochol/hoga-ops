import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiCall } from './client';
import { mergeExecutionRows, useExecutionHistory, type ExecutionHistoryPage, type ExecutionHistoryRow } from './executionHistory';
const REF = `acc_${'a'.repeat(32)}`, OTHER = `acc_${'b'.repeat(32)}`;
vi.mock('./client', () => ({ apiCall: vi.fn() }));
vi.mock('./ws', () => ({ subscribeEvents: () => () => {} }));
const row = (qty = '30'): ExecutionHistoryRow => ({ order_ref: 'one', broker_order_id: 'one', code: '007810', name: null,
  side: 'BUY', quantity: qty, order_quantity: '100', price: '80500', price_basis: 'average', amount: null,
  filled_at: null, ordered_at: '2026-10-28T15:00:00+09:00', route: 'SOR' });
const page = (ref = REF, rows = [row()], next: string | null = null): ExecutionHistoryPage => ({ account_ref: ref,
  date: '20261028', rows, next_key: next, events_connected: true, fetched_at_ms: 1 });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { wrapper, client };
}
beforeEach(() => vi.mocked(apiCall).mockReset());
afterEach(cleanup);

it('deduplicates cumulative snapshots without summing partial fills or reverting to an older quantity', () => {
  expect(mergeExecutionRows(page(REF, [row('50')]), page(REF, [row('30')]))).toEqual([row('50')]);
  expect(mergeExecutionRows(page(REF, [row('30')]), page(REF, [row('50')]))).toEqual([row('50')]);
  expect(mergeExecutionRows(page(REF, [row('0')]))).toEqual([]);
});

it('isolates account switches including late responses and rejects mismatched metadata', async () => {
  let resolve!: (p: ExecutionHistoryPage) => void;
  vi.mocked(apiCall).mockImplementation(url => String(url).includes(OTHER) ? Promise.resolve(page(OTHER, []))
    : new Promise<ExecutionHistoryPage>(done => { resolve = done; }));
  const { wrapper } = setup();
  const { result, rerender } = renderHook(({ account }) => useExecutionHistory(account, '20261028'), { wrapper, initialProps: { account: REF } });
  await waitFor(() => expect(apiCall).toHaveBeenCalled());
  rerender({ account: OTHER });
  await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
  await act(async () => resolve(page()));
  expect(result.current.rows).toEqual([]);
  vi.mocked(apiCall).mockResolvedValue(page(REF));
  await act(async () => { await result.current.first.refetch(); });
  await waitFor(() => expect(result.current.first.isError).toBe(true));
});

it('loads older pages on demand while keeping the newest quantity and no venue parameter', async () => {
  vi.mocked(apiCall).mockImplementation(url => Promise.resolve(String(url).includes('next_key')
    ? page(REF, [row('20'), { ...row('12'), order_ref: 'older' }]) : page(REF, [row('50')], 'opaque+/=')));
  const { wrapper } = setup();
  const { result } = renderHook(() => useExecutionHistory(REF, '20261028'), { wrapper });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  expect(apiCall).toHaveBeenCalledTimes(1);
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.rows).toHaveLength(2));
  expect(result.current.rows.find(r => r.order_ref === 'one')?.quantity).toBe('50');
  expect(result.current.hasMore).toBe(false);
  expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('next_key=opaque%2B%2F%3D');
  expect(vi.mocked(apiCall).mock.calls.every(([url]) => !String(url).includes('venue'))).toBe(true);
});

it('retains observed fills after they move off the newest page and resets them on a new day', async () => {
  vi.mocked(apiCall).mockResolvedValue(page());
  const { wrapper } = setup();
  const { result, rerender } = renderHook(({ date }) => useExecutionHistory(REF, date), { wrapper, initialProps: { date: '20261028' } });
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  vi.mocked(apiCall).mockResolvedValue(page(REF, [{ ...row('5'), order_ref: 'newer' }]));
  await act(async () => { await result.current.first.refetch(); });
  await waitFor(() => expect(result.current.rows).toHaveLength(2));
  expect(result.current.rows.find(r => r.order_ref === 'one')?.quantity).toBe('30');
  vi.mocked(apiCall).mockResolvedValue({ ...page(REF, []), date: '20261029' });
  rerender({ date: '20261029' });
  expect(result.current.rows).toEqual([]);
});
