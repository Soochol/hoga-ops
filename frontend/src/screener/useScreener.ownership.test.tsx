import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiCall } from '../api/client';
import { readContinuousResult, type ScanRequest, type ScreenerResponse } from '../api/screener';
import { useScreener } from './useScreener';

vi.mock('../api/client', () => ({ apiCall: vi.fn() }));
vi.mock('../api/screener', async original => ({
  ...await original<typeof import('../api/screener')>(), readContinuousResult: vi.fn(),
}));

const request: ScanRequest = { universe: { scopes: ['watchlist'] }, conditions: [
  { id: 'v', type: 'new_high_vol', params: { timeframe: '1m', period: 10, lookback: 3 } },
] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.mocked(apiCall).mockResolvedValue({ id: 'monitor-1' });
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('releases the first explicit Page monitor on unmount before continuous becomes true', async () => {
  const read = deferred<ScreenerResponse>();
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  const { result, unmount } = renderHook(() => useScreener({ continuous: false, anchor: 'page', request }), { wrapper });
  act(() => { void result.current.mutateAsync({ request, mode: 'monitor' }).catch(() => {}); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledWith('monitor-1'));
  unmount();
  expect(apiCall).toHaveBeenCalledWith('/api/screener/monitors/monitor-1', { method: 'DELETE' });
  read.resolve({ status: 'ok', rows: [], warnings: [] });
});

it('renders idle after retiring a pending read even when that read rejects with a real 404', async () => {
  const read = deferred<ScreenerResponse>();
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  const { result, rerender } = renderHook(({ anchor }) => useScreener({ continuous: true, anchor, request }), {
    wrapper, initialProps: { anchor: 'old' },
  });
  let done!: Promise<unknown>;
  act(() => { done = result.current.mutateAsync(request).catch(() => {}); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledWith('monitor-1'));
  rerender({ anchor: 'new' });
  await act(async () => {
    read.reject(Object.assign(new Error('감시를 찾을 수 없습니다.'), { status: 404 }));
    await done;
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(result.current.isError).toBe(false);
  expect(result.current.isIdle).toBe(true);
});
