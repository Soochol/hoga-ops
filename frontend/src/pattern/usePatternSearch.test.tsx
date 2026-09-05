import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { DEFAULT_CONDITIONS } from './patternConditions';
import { DEFAULT_FILTERS, PATTERN_SEARCH_SETTLE_MS, usePatternSearch } from './usePatternSearch';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['now', 'history'] as const)('%s scrubbing sends only the last request and aborts it on unmount', async (mode) => {
  vi.useFakeTimers();
  const api = vi.spyOn(client, 'apiCall').mockImplementation(() => new Promise(() => {}));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { rerender, unmount } = renderHook(({ length }) => usePatternSearch({
    code: '005930', mode, length, filters: DEFAULT_FILTERS, conditions: DEFAULT_CONDITIONS,
  }), { initialProps: { length: 5 }, wrapper });
  for (let length = 6; length <= 10; length++) {
    await act(() => vi.advanceTimersByTimeAsync(25));
    rerender({ length });
  }
  expect(api).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(PATTERN_SEARCH_SETTLE_MS));
  expect(api).toHaveBeenCalledTimes(1);
  const [, init] = api.mock.calls[0];
  expect(JSON.parse(init!.body as string).lengths).toEqual([10]);
  expect(init?.signal?.aborted).toBe(false);
  unmount();
  expect(init?.signal?.aborted).toBe(true);
  expect(qc.isFetching()).toBe(0);
  qc.clear();
});

it('does not send a request when the panel closes during the settle window', async () => {
  vi.useFakeTimers();
  const api = vi.spyOn(client, 'apiCall');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { unmount } = renderHook(() => usePatternSearch({
    code: '005930', mode: 'now', length: 7, filters: DEFAULT_FILTERS,
  }), { wrapper });
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(PATTERN_SEARCH_SETTLE_MS));
  expect(api).not.toHaveBeenCalled();
  qc.clear();
});
