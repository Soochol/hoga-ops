import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiCall } from './client';
import { oneYearAgo, useExecutionHistoryRange, type ExecutionHistoryRangePage } from './executionHistoryRange';

vi.mock('./client', () => ({ apiCall: vi.fn() }));
const a = `acc_${'a'.repeat(32)}`, b = `acc_${'b'.repeat(32)}`;
const from = '20251029', to = '20261029';
const clients: QueryClient[] = [];
const page = (next_key: string | null = null, account = a): ExecutionHistoryRangePage => ({ account_ref: account,
  from_date: from, to_date: to, rows: [], next_key, scanned_through: '20261028', fetched_at_ms: 1, events_connected: true });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
beforeEach(() => vi.mocked(apiCall).mockReset());
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it('uses a calendar year including the leap-day clamp', () => {
  expect(oneYearAgo('20261029')).toBe('20251029');
  expect(oneYearAgo('20240229')).toBe('20230228');
  expect(oneYearAgo('20250301')).toBe('20240301');
});

it('automatically advances one page at a time and shares a completed year across windows without refetching', async () => {
  vi.mocked(apiCall).mockImplementation(async url => page(String(url).includes('next_key') ? null : 'opaque+/='));
  const { wrapper } = setup();
  const first = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  const second = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  await waitFor(() => expect(first.result.current.data?.pages).toHaveLength(2));
  expect(apiCall).toHaveBeenCalledTimes(2);
  expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('next_key=opaque%2B%2F%3D');
  expect(second.result.current.hasNextPage).toBe(false);
  first.unmount(); second.unmount();
  const reopened = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  expect(reopened.result.current.data?.pages).toHaveLength(2);
  expect(apiCall).toHaveBeenCalledTimes(2);
});

it('cancels on close and resumes from the unfinished cursor, retaining completed pages', async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(apiCall).mockImplementation((url, options) => {
    if (!String(url).includes('next_key')) return Promise.resolve(page('older'));
    signal = options?.signal as AbortSignal;
    return new Promise(() => {});
  });
  const { wrapper } = setup();
  const initial = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(2));
  initial.unmount();
  expect(signal?.aborted).toBe(true);
  vi.mocked(apiCall).mockResolvedValue(page());
  const resumed = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  await waitFor(() => expect(resumed.result.current.data?.pages).toHaveLength(2));
  expect(apiCall).toHaveBeenCalledTimes(3);
  expect(vi.mocked(apiCall).mock.calls[2][0]).toContain('next_key=older');
});

it('pauses further pages during commands and isolates new accounts and mismatched metadata', async () => {
  vi.mocked(apiCall).mockImplementation(async url => page(null, String(url).includes(b) ? b : a));
  const { wrapper } = setup();
  const view = renderHook(({ account, enabled }) => useExecutionHistoryRange(account, from, to, enabled),
    { wrapper, initialProps: { account: a, enabled: false } });
  expect(apiCall).not.toHaveBeenCalled();
  view.rerender({ account: a, enabled: true });
  await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
  view.rerender({ account: b, enabled: true });
  await waitFor(() => expect(view.result.current.data?.pages[0].account_ref).toBe(b));
  vi.mocked(apiCall).mockResolvedValue(page(null, a));
  await act(async () => { await view.result.current.restart(); });
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.result.current.data).toBeUndefined();
});

it('stops cursor cycles with an error while preserving already verified pages', async () => {
  vi.mocked(apiCall).mockImplementation(async url => {
    const cursor = new URL(String(url), 'http://localhost').searchParams.get('next_key');
    return page(cursor === null ? 'A' : cursor === 'A' ? 'B' : 'A');
  });
  const { wrapper } = setup();
  const view = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.result.current.data?.pages).toHaveLength(2);
  expect(apiCall).toHaveBeenCalledTimes(3);
});

it('restarts expired signed cursors on explicit retry instead of repeatedly requesting the expired page', async () => {
  let expired = true;
  vi.mocked(apiCall).mockImplementation(async url => {
    if (!String(url).includes('next_key')) return page(expired ? 'old' : 'new');
    if (expired) throw Object.assign(new Error('expired'), { code: 'execution-cursor-expired' });
    return page();
  });
  const { wrapper } = setup();
  const view = renderHook(() => useExecutionHistoryRange(a, from, to, true), { wrapper });
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expired = false;
  await act(async () => { await view.result.current.retryPage(); });
  await waitFor(() => expect(view.result.current.data?.pages).toHaveLength(2));
  expect(view.result.current.isError).toBe(false);
  expect(vi.mocked(apiCall).mock.calls.at(-1)?.[0]).toContain('next_key=new');
});
