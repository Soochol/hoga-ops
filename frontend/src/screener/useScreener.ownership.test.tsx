import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useState, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiAction, apiCall } from '../api/client';
import { readContinuousResult, runScan, type ScanRequest, type ScreenerResponse } from '../api/screener';
import { activeRunId, preparationKey, runPreparedScan, type ScreenerRun } from '../api/screenerRuns';
import { useScreener } from './useScreener';

vi.mock('../api/client', () => ({ apiCall: vi.fn(), apiAction: vi.fn(async () => {}) }));
vi.mock('../api/screener', async original => ({
  ...await original<typeof import('../api/screener')>(), readContinuousResult: vi.fn(), runScan: vi.fn(),
}));

vi.mock('../api/screenerRuns', async original => ({
  ...await original<typeof import('../api/screenerRuns')>(), runPreparedScan: vi.fn(),
}));

const response: ScreenerResponse = { status: 'ok', rows: [], warnings: [] };
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
  const [client] = useState(() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.mocked(apiCall).mockResolvedValue({ id: 'monitor-1' });
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

it('releases the first explicit Page monitor on unmount before continuous becomes true', async () => {
  const read = deferred<ScreenerResponse>();
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  const { result, unmount } = renderHook(() => useScreener({ continuous: false, identity: 'page', request }), { wrapper });
  act(() => { void result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledWith('monitor-1'));
  unmount();
  expect(apiAction).toHaveBeenCalledWith('/api/screener/monitors/monitor-1', { method: 'DELETE' });
  read.resolve({ status: 'ok', rows: [], warnings: [] });
});

it('renders idle after retiring a pending read even when that read rejects with a real 404', async () => {
  const read = deferred<ScreenerResponse>();
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  const { result, rerender } = renderHook(({ anchor }) => useScreener({ continuous: true, identity: anchor, request }), {
    wrapper, initialProps: { anchor: 'old' },
  });
  let done!: Promise<unknown>;
  act(() => { done = result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledWith('monitor-1'));
  rerender({ anchor: 'new' });
  await act(async () => {
    read.reject(Object.assign(new Error('감시를 찾을 수 없습니다.'), { status: 404 }));
    await done;
  });
  expect(result.current.state.kind).toBe('idle');
});

it('releases a late initial POST without touching a replacement lease', async () => {
  const post = deferred<{ id: string }>();
  vi.mocked(apiCall).mockReturnValueOnce(post.promise).mockResolvedValue({ id: 'replacement' });
  vi.mocked(readContinuousResult).mockResolvedValue(response);
  const { result, rerender } = renderHook(({ identity }) => useScreener({ identity, request }), {
    wrapper, initialProps: { identity: 'old' },
  });
  let old!: ReturnType<typeof result.current.run>;
  act(() => { old = result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(apiCall).toHaveBeenCalledTimes(1));
  rerender({ identity: 'new' });
  await act(async () => { expect(await result.current.run({ mode: 'monitor' })).toBe('success'); });
  await act(async () => { post.resolve({ id: 'late' }); expect(await old).toBe('retired'); });
  expect(apiAction).toHaveBeenCalledWith('/api/screener/monitors/late', { method: 'DELETE' });
  expect(apiAction).not.toHaveBeenCalledWith('/api/screener/monitors/replacement', { method: 'DELETE' });
  expect(result.current.acceptsVolumeEvent('replacement')).toBe(true);
  await waitFor(() => expect(result.current.state.kind).toBe('success'));
});

it('heartbeats during the initial pending result and keeps the lease across false-to-true', async () => {
  vi.useFakeTimers();
  const read = deferred<ScreenerResponse>();
  const reading = deferred<void>();
  vi.mocked(readContinuousResult).mockImplementation(() => { reading.resolve(); return read.promise; });
  const { result, rerender, unmount } = renderHook(({ continuous }) => useScreener({ continuous, request }), {
    wrapper, initialProps: { continuous: false },
  });
  let done!: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'monitor' }); });
  await act(async () => { await reading.promise; });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(apiCall).toHaveBeenCalledWith('/api/screener/monitors/monitor-1/heartbeat', { method: 'POST' });
  await act(async () => { read.resolve(response); expect(await done).toBe('success'); });
  rerender({ continuous: true });
  expect(apiAction).not.toHaveBeenCalledWith('/api/screener/monitors/monitor-1', { method: 'DELETE' });
  expect(result.current.acceptsVolumeEvent('monitor-1')).toBe(true);
  unmount();
  expect(apiAction).toHaveBeenCalledWith('/api/screener/monitors/monitor-1', { method: 'DELETE' });
  const calls = vi.mocked(apiCall).mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  expect(apiCall).toHaveBeenCalledTimes(calls);
});

it.each(['success', 'error'] as const)('an old rejection cannot replace a newer %s snapshot', async outcome => {
  const oldRead = deferred<ScreenerResponse>();
  const newError = new Error('current scan failed');
  vi.mocked(readContinuousResult).mockReturnValueOnce(oldRead.promise);
  if (outcome === 'success') vi.mocked(readContinuousResult).mockResolvedValueOnce(response);
  else vi.mocked(readContinuousResult).mockRejectedValueOnce(newError);
  const onResult = vi.fn();
  const { result } = renderHook(() => useScreener({ request, onResult }), { wrapper });
  let old!: ReturnType<typeof result.current.run>;
  act(() => { old = result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledTimes(1));
  await act(async () => {
    expect(await result.current.run({ mode: 'monitor' })).toBe(outcome === 'success' ? 'success' : 'failed');
  });
  await waitFor(() => expect(result.current.state.kind).toBe(outcome));
  await act(async () => {
    oldRead.reject(Object.assign(new Error('old missing'), { status: 404 }));
    expect(await old).toBe('retired');
  });
  expect(result.current.state.kind).toBe(outcome);
  if (result.current.state.kind === 'error') expect(result.current.state.error).toBe(newError);
  expect(onResult).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
});

it.each(['success', 'error', 'pending'] as const)('Stop preserves settled %s and retires pending publication', async outcome => {
  const read = deferred<ScreenerResponse>();
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  const onResult = vi.fn();
  const { result, rerender } = renderHook(({ continuous }) => useScreener({ continuous, request, onResult }), {
    wrapper, initialProps: { continuous: true },
  });
  let done!: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledTimes(1));
  if (outcome !== 'pending') {
    await act(async () => {
      if (outcome === 'success') read.resolve(response);
      else read.reject(new Error('current error'));
      await done;
    });
    await waitFor(() => expect(result.current.state.kind).toBe(outcome));
  }
  rerender({ continuous: false });
  expect(result.current.state.kind).toBe(outcome === 'pending' ? 'idle' : outcome);
  if (outcome === 'pending') {
    await act(async () => { read.reject(new Error('late failure')); expect(await done).toBe('retired'); });
    expect(onResult).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('idle');
  }
  expect(apiAction).toHaveBeenCalledWith('/api/screener/monitors/monitor-1', { method: 'DELETE' });
});

it.each(['success', 'error'] as const)('a manual %s survives the falling edge while its old DELETE is held', async outcome => {
  const read = deferred<ScreenerResponse>();
  const deleted = deferred<void>();
  const prepared = deferred<ScreenerResponse>();
  let signal: AbortSignal | undefined;
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  vi.mocked(runPreparedScan).mockImplementation((_request, ownSignal) => { signal = ownSignal; return prepared.promise; });
  const onResult = vi.fn();
  const { result, rerender } = renderHook(({ continuous }) => useScreener({ continuous, request, onResult }), {
    wrapper, initialProps: { continuous: true },
  });
  let old!: ReturnType<typeof result.current.run>;
  act(() => { old = result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledTimes(1));
  vi.mocked(apiAction).mockReturnValueOnce(deleted.promise);
  let once!: ReturnType<typeof result.current.run>;
  act(() => { once = result.current.run({ mode: 'once' }); });
  rerender({ continuous: false });
  await waitFor(() => expect(result.current.state.kind).toBe('pending'));
  expect(runPreparedScan).not.toHaveBeenCalled();
  await act(async () => { deleted.resolve(); });
  await waitFor(() => expect(signal).toBeDefined());
  expect(signal?.aborted).toBe(false);
  await act(async () => {
    if (outcome === 'success') prepared.resolve(response);
    else prepared.reject(new Error('current manual failure'));
    expect(await once).toBe(outcome === 'success' ? 'success' : 'failed');
  });
  await waitFor(() => expect(result.current.state.kind).toBe(outcome));
  await act(async () => { read.reject(Object.assign(new Error('old missing'), { status: 404 })); await old; });
  expect(signal?.aborted).toBe(false);
  expect(result.current.state.kind).toBe(outcome);
  expect(onResult).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
});

it.each(['success', 'error'] as const)('uses the latest publisher for preparation and retains its information on %s', async outcome => {
  const prepared = deferred<ScreenerResponse>();
  let progress!: (run: ScreenerRun) => void;
  vi.mocked(runPreparedScan).mockImplementation((_request, _signal, send) => { progress = send; return prepared.promise; });
  const publish = vi.fn();
  const { result, rerender } = renderHook(({ name, updated }) => useScreener({ request,
    onResult: event => publish({ ...event, name, updated }),
  }), { wrapper, initialProps: { name: 'old', updated: 1 } });
  let done!: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'once', background: true }); });
  await waitFor(() => expect(progress).toBeDefined());
  rerender({ name: 'new', updated: 2 });
  const run: ScreenerRun = { id: 'prepare', request, status: 'partial', result: response, total: 1, evaluated: 1,
    preparing: 0, waiting: 0, failed: 0, errors: {}, revision: 1, result_revision: 1, next_retry_at_ms: null,
    started_at_ms: 1, updated_at_ms: 2 };
  act(() => { progress(run); });
  await act(async () => {
    if (outcome === 'success') prepared.resolve(response);
    else prepared.reject(new Error('preparation failed'));
    expect(await done).toBe(outcome === 'success' ? 'success' : 'failed');
  });
  await waitFor(() => expect(result.current.state.kind).toBe(outcome));
  expect(publish.mock.calls.map(([event]) => [event.phase, event.name, event.updated, event.background]))
    .toEqual(outcome === 'success' ? [['progress', 'new', 2, true], ['complete', 'new', 2, true]] : [['progress', 'new', 2, true]]);
  expect(result.current.preparation).toBe(run);
});

it('renders a current AbortError as a failure rather than suppressing every aborted response', async () => {
  const error = new DOMException('current transport aborted', 'AbortError');
  vi.mocked(readContinuousResult).mockRejectedValue(error);
  const { result } = renderHook(() => useScreener({ request }), { wrapper });
  await act(async () => { expect(await result.current.run({ mode: 'monitor' })).toBe('failed'); });
  await waitFor(() => expect(result.current.state).toEqual({ kind: 'error', error }));
});

it('drops progress and final success after scope replacement and aborts preparation', async () => {
  const prepared = deferred<ScreenerResponse>();
  let progress!: (run: ScreenerRun) => void;
  let signal!: AbortSignal;
  vi.mocked(runPreparedScan).mockImplementation((_request, ownSignal, send) => {
    signal = ownSignal; progress = send; return prepared.promise;
  });
  const onResult = vi.fn();
  const { result, rerender } = renderHook(({ identity }) => useScreener({ identity, request, onResult }), {
    wrapper, initialProps: { identity: 'old' },
  });
  let done!: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'once' }); });
  await waitFor(() => expect(progress).toBeDefined());
  rerender({ identity: 'new' });
  expect(signal.aborted).toBe(true);
  expect(() => progress({ id: 'late', request, result: response, status: 'partial', total: 1, evaluated: 1,
    preparing: 0, waiting: 0, failed: 0, errors: {}, revision: 1, result_revision: 1, next_retry_at_ms: null,
    started_at_ms: 1, updated_at_ms: 2 })).toThrow();
  await act(async () => { prepared.resolve(response); expect(await done).toBe('retired'); });
  expect(onResult).not.toHaveBeenCalled();
  expect(result.current.state.kind).toBe('idle');
});

it('survives StrictMode effect replay and resumes only persisted preparation', async () => {
  vi.mocked(runPreparedScan).mockResolvedValue(response);
  sessionStorage.setItem('screener.active-runs.v1', JSON.stringify({ [preparationKey(request)]: 'persisted' }));
  expect(activeRunId(request)).toBe('persisted');
  const onResult = vi.fn();
  const { result } = renderHook(() => useScreener({ request, onResult }), {
    wrapper: ({ children }) => {
      const Provider = wrapper;
      return <StrictMode><Provider>{children}</Provider></StrictMode>;
    },
  });
  await waitFor(() => expect(result.current.state.kind).toBe('success'));
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(runPreparedScan).toHaveBeenLastCalledWith(request, expect.any(AbortSignal), expect.any(Function), 'persisted');
});

it('unmount retires an ordinary scan as well as monitor and preparation work', async () => {
  const scanned = deferred<ScreenerResponse>();
  vi.mocked(runScan).mockReturnValue(scanned.promise);
  const onResult = vi.fn();
  const plain: ScanRequest = { universe: {}, conditions: [] };
  const { result, unmount } = renderHook(() => useScreener({ request: plain, onResult }), { wrapper });
  let done!: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'once' }); });
  await waitFor(() => expect(runScan).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => { scanned.resolve(response); expect(await done).toBe('retired'); });
  expect(onResult).not.toHaveBeenCalled();
});

const requestChanges: { name: string; next: ScanRequest }[] = [
  { name: 'conditions', next: { ...request, conditions: [] } },
  { name: 'universe', next: { ...request, universe: { scopes: ['heatmap'] } } },
  { name: 'expression', next: { ...request, expression: 'NOT A' } },
  { name: 'calculation policy', next: { ...request, calculation_policy: 'separate_bases_v2' } },
  { name: 'snapshot', next: { ...request, snapshot_id: 'snapshot' } },
  { name: 'basis', next: { ...request, basis: 'eod' } },
  { name: 'limit', next: { ...request, limit: 20 } },
  { name: 'venue', next: { ...request, venue: 'NXT' } },
];
it.each(requestChanges)('a same-selection $name change retires the complete effective request', async ({ next }) => {
  const read = deferred<ScreenerResponse>();
  vi.mocked(readContinuousResult).mockReturnValue(read.promise);
  const onResult = vi.fn();
  const { result, rerender } = renderHook(({ body }) => useScreener({ identity: 'same-save', request: body, onResult }), {
    wrapper, initialProps: { body: request },
  });
  let done!: ReturnType<typeof result.current.run>;
  act(() => { done = result.current.run({ mode: 'monitor' }); });
  await waitFor(() => expect(readContinuousResult).toHaveBeenCalledTimes(1));
  const previous = result.current.scopeKey;
  rerender({ body: next });
  expect(result.current.scopeKey).not.toBe(previous);
  expect(apiAction).toHaveBeenCalledWith('/api/screener/monitors/monitor-1', { method: 'DELETE' });
  await act(async () => { read.resolve(response); expect(await done).toBe('retired'); });
  expect(onResult).not.toHaveBeenCalled();
  expect(result.current.state.kind).toBe('idle');
});

it('shows a current release failure when a manual query cannot finish its required DELETE', async () => {
  vi.mocked(readContinuousResult).mockResolvedValue(response);
  const { result } = renderHook(() => useScreener({ request }), { wrapper });
  await act(async () => { await result.current.run({ mode: 'monitor' }); });
  const error = new Error('release failed');
  vi.mocked(apiAction).mockRejectedValueOnce(error);
  await act(async () => { expect(await result.current.run({ mode: 'once' })).toBe('failed'); });
  await waitFor(() => expect(result.current.state).toEqual({ kind: 'error', error }));
  expect(runPreparedScan).not.toHaveBeenCalled();
});
