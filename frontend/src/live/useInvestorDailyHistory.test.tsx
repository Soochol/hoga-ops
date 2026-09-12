import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import type { LivePastInvestorNetResponse, InvestorNetAxis } from '../api/livePastInvestorNet';
import { useInvestorDailyHistory } from './useInvestorDailyHistory';

const response = (url: string): LivePastInvestorNetResponse => {
  const params = new URL(url, 'http://localhost').searchParams;
  return { code: params.get('code')!, from: params.get('from')!, to: params.get('to')!,
    unit: params.get('axis') === 'qty' ? 'qty_shares' : 'amt_mwon', points: [],
    cached_batches: [], fresh_batches: [], data_warnings: [] };
};
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(({ code, axis }: { code: string; axis: InvestorNetAxis }) =>
    ({ ...useInvestorDailyHistory(code, '20260505', axis) }), {
    initialProps: { code: '005930', axis: 'qty' },
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
}
afterEach(() => vi.restoreAllMocks());

it('only fetches on demand, requests adjacent 130-day windows and isolates code/axis caches', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => response(url));
  const { result, rerender } = setup();
  expect(spy).not.toHaveBeenCalled();
  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[0][0]).toContain('from=20251226&to=20260504&axis=qty');
  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[1][0]).toContain('to=20251225&axis=qty');
  await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
  rerender({ code: '005930', axis: 'amount' });
  expect(result.current.data).toBeUndefined();
  await act(async () => { await result.current.fetchNextPage(); });
  await waitFor(() => expect(result.current.data?.pages[0].unit).toBe('amt_mwon'));
  rerender({ code: '000660', axis: 'amount' });
  expect(result.current.data).toBeUndefined();
  rerender({ code: '005930', axis: 'qty' });
  await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
  expect(spy).toHaveBeenCalledTimes(3);
});

it('does not advance past partial failures; retries the same window and preserves earlier pages', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => response(url));
  const { result } = setup();
  await act(async () => { await result.current.fetchNextPage(); });
  spy.mockImplementationOnce(async (url) => ({ ...response(url),
    data_warnings: [{ batch: 'test', reason: 'api_error', msg: 'failed' }] }));
  await act(async () => { await result.current.fetchNextPage(); });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.data?.pages).toHaveLength(1);
  await act(async () => { await result.current.fetchNextPage(); });
  expect(spy.mock.calls[2][0]).toEqual(spy.mock.calls[1][0]);
  await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
});
