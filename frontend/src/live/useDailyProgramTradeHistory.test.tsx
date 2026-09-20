import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

import * as client from '../api/client';
import type { LiveDailyProgramTradeResponse } from '../api/liveDailyProgramTrade';
import { useDailyProgramTradeHistory } from './useDailyProgramTradeHistory';

function response(url: string): LiveDailyProgramTradeResponse {
  const params = new URL(url, 'http://localhost').searchParams;
  return {
    code: params.get('code')!, from: params.get('from')!, to: params.get('to')!,
    points: [], cached_batches: [], fresh_batches: [], data_warnings: [],
  };
}

function setup(code: string | null = '005930') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    ({ currentCode }: { currentCode: string | null }) => ({
      ...useDailyProgramTradeHistory(currentCode, currentCode ? '20260505' : null),
    }),
    {
      initialProps: { currentCode: code },
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    },
  );
}

afterEach(() => vi.restoreAllMocks());

it('fetches only on demand in adjacent 130-day windows and isolates code caches', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => response(url));
  const { result, rerender } = setup();
  expect(spy).not.toHaveBeenCalled();

  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[0][0]).toContain('code=005930&from=20251226&to=20260504');
  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[1][0]).toContain('code=005930&from=20250818&to=20251225');
  await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));

  rerender({ currentCode: '000660' });
  expect(result.current.data).toBeUndefined();
  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[2][0]).toContain('code=000660');
});

it('does not advance past a partial response and retries the same window', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => response(url));
  const { result } = setup();
  await act(async () => { await result.current.fetchNextPage(); });
  spy.mockImplementationOnce(async (url) => ({
    ...response(url),
    data_warnings: [{ batch: 'test', reason: 'api_error', msg: 'failed' }],
  }));
  await act(async () => { await result.current.fetchNextPage(); });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data?.pages).toHaveLength(1);

  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[2][0]).toEqual(spy.mock.calls[1][0]);
  await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
});

it('keeps a disabled, unlinked window inert', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => response(url));
  setup(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(spy).not.toHaveBeenCalled();
});
