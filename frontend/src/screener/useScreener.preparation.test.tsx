import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { ScanRequest, ScreenerResponse } from '../api/screener';
import { runPreparedScan, type ScreenerRun } from '../api/screenerRuns';
import { useScreener } from './useScreener';

vi.mock('../api/screenerRuns', async importOriginal => ({
  ...await importOriginal<typeof import('../api/screenerRuns')>(), runPreparedScan: vi.fn(),
}));
const liveScan = vi.hoisted(() => vi.fn());
vi.mock('./continuousClient', async importOriginal => ({
  ...await importOriginal<typeof import('./continuousClient')>(),
  ContinuousClient: class { stop = vi.fn(async () => {}); heartbeat = vi.fn(async () => {}); scan = liveScan; },
}));
const body: ScanRequest = { calculation_policy: 'separate_bases_v2', universe: {},
  conditions: [{ id: 'high', type: 'new_high_today', params: { period: 3 } }] };
const response: ScreenerResponse = { status: 'ok', rows: [], warnings: [] };
const progress: ScreenerRun = { id: 'run1', request: body, status: 'preparing', total: 2, evaluated: 1,
  preparing: 1, waiting: 0, failed: 0, next_retry_at_ms: null, errors: {}, revision: 1, result_revision: 1, result: response,
  started_at_ms: 1, updated_at_ms: 1 };

function wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });

it('does not collect when editing, delivers partial results only for the current request, and drops late results', async () => {
  let send: ((run: ScreenerRun) => void) | undefined;
  let finish: ((result: ScreenerResponse) => void) | undefined;
  vi.mocked(runPreparedScan).mockImplementation((_body, _signal, callback) => {
    send = callback;
    return new Promise(resolve => { finish = resolve; });
  });
  const onResult = vi.fn();
  const { result, rerender } = renderHook(({ anchor }) => useScreener({ identity: anchor, request: body, onResult }), {
    initialProps: { anchor: 'old' }, wrapper,
  });
  expect(runPreparedScan).not.toHaveBeenCalled();
  let done: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'once' }); });
  await waitFor(() => expect(send).toBeDefined());
  act(() => { send!(progress); });
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(result.current.preparation?.preparing).toBe(1);
  const rejected = expect(done!).resolves.toBe('retired');
  rerender({ anchor: 'new' });
  expect(result.current.preparation).toBeNull();
  await act(async () => { finish!(response); await rejected; });
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(runPreparedScan).toHaveBeenCalledTimes(1);
});

it.each(['1m', '3m', '5m', '10m'] as const)('retains the scoped %s monitor after preparing the daily part of a mixed request', async timeframe => {
  const mixed: ScanRequest = { ...body, universe: { scopes: ['watchlist'] }, conditions: [
    ...body.conditions, { id: 'minute', type: 'new_high_vol_today', params: { timeframe, period: 3 } },
  ] };
  vi.mocked(runPreparedScan).mockResolvedValue(response);
  const live = { ...response, basis_at_ms: 123 };
  liveScan.mockResolvedValue(live);
  const { result, unmount } = renderHook(() => useScreener({ continuous: true, request: mixed }), { wrapper });
  await act(async () => { expect(await result.current.run({ mode: 'monitor' })).toBe('success'); });
  await waitFor(() => expect(result.current.state).toEqual({ kind: 'success', data: live }));
  expect(runPreparedScan).toHaveBeenCalledTimes(1);
  expect(liveScan).toHaveBeenCalledWith(mixed);
  unmount();
});

it.each(['3m', '5m', '10m'] as const)('keeps unscoped %s on the full API preparation path', async timeframe => {
  const unscoped: ScanRequest = { universe: {}, conditions: [{ id: 'minute', type: 'new_high_vol_today',
    params: { timeframe, period: 3 } }] };
  vi.mocked(runPreparedScan).mockResolvedValue(response);
  const { result, unmount } = renderHook(() => useScreener({ continuous: true, request: unscoped }), { wrapper });
  await act(async () => { expect(await result.current.run({ mode: 'monitor' })).toBe('success'); });
  await waitFor(() => expect(result.current.state).toEqual({ kind: 'success', data: response }));
  expect(runPreparedScan).toHaveBeenCalledTimes(1);
  expect(liveScan).not.toHaveBeenCalled();
  unmount();
});

it('an explicit one-shot invocation never starts a scoped WS monitor', async () => {
  const scoped: ScanRequest = { universe: { scopes: ['watchlist'] }, conditions: [
    { id: 'minute', type: 'new_high_vol', params: { timeframe: '3m', period: 40, lookback: 3 } },
  ] };
  vi.mocked(runPreparedScan).mockResolvedValue(response);
  const { result } = renderHook(() => useScreener({ continuous: true, request: scoped }), { wrapper });
  await act(async () => { await result.current.run({ mode: 'once' }); });
  expect(runPreparedScan).toHaveBeenCalledTimes(1);
  expect(runPreparedScan).toHaveBeenCalledWith(scoped, expect.any(AbortSignal), expect.any(Function), undefined);
  expect(liveScan).not.toHaveBeenCalled();
});

it('an explicit monitor invocation starts immediately before the active-state render', async () => {
  const scoped: ScanRequest = { universe: { scopes: ['watchlist'] }, conditions: [
    { id: 'minute', type: 'new_high_vol', params: { timeframe: '3m', period: 40, lookback: 3 } },
  ] };
  liveScan.mockResolvedValue(response);
  const { result } = renderHook(() => useScreener({ continuous: false, request: scoped }), { wrapper });
  await act(async () => { await result.current.run({ mode: 'monitor' }); });
  expect(liveScan).toHaveBeenCalledWith(scoped);
  expect(runPreparedScan).not.toHaveBeenCalled();
});
