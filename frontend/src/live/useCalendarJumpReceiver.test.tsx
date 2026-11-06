import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiCall } from '../api/client';
import type { LivePastDailyCandlesResponse } from '../api/livePastDailyCandles';
import { createVirtualAxis } from '../util/virtualAxis';
import { calendarJumpSource } from './calendarJump';
import { useCalendarJumpReceiver } from './useCalendarJumpReceiver';
import { useLiveCursorStore } from './useLiveCursorStore';

vi.mock('../api/client', () => ({ apiCall: vi.fn() }));
const source = calendarJumpSource({ range: { fromMs: Date.UTC(2026, 2, 2), toMs: Date.UTC(2026, 2, 31) },
  timeframe: 'M', code: '005930', venue: 'KRX', source: 'vendor', sourceKey: 'source', cutoffDate: '20261107' });
const origin = { windowId: 'monthly', group: 1, code: '005930', timeframe: 'M' } satisfies Parameters<ReturnType<typeof useLiveCursorStore.getState>['requestTimeframeJump']>[2];
const response: LivePastDailyCandlesResponse = { code: '005930', from: source.from, to: source.to, venue: 'KRX',
  candles: [{ t_ms: Date.UTC(2026, 2, 30), open: 1, high: 2, low: 1, close: 2, volume: 10 }],
  cached_batches: [], fresh_batches: [], data_warnings: [] };
const extend = vi.fn();
const defaults = { target: { windowId: 'daily', group: 1, code: '005930', stockCode: '005930', timeframe: 'D' },
  identity: 'daily', viewKey: 'view', inputRevision: 0, chart: null, axis: createVirtualAxis([]), candles: [],
  ready: false, queryStatus: { kind: 'ready', from: '20260401', to: '20261107' }, extend } satisfies Parameters<typeof useCalendarJumpReceiver>[0];
type Props = Parameters<typeof useCalendarJumpReceiver>[0];
const clients: QueryClient[] = [];
function mount(props: Props = defaults) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return renderHook((p: Props) => useCalendarJumpReceiver(p), { initialProps: props,
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
function publish() {
  act(() => useLiveCursorStore.getState().requestTimeframeJump(Date.UTC(2026, 2, 2), Date.UTC(2026, 2, 31), origin, source));
}
beforeEach(() => {
  useLiveCursorStore.getState().resetCursor();
  vi.mocked(apiCall).mockReset();
  vi.mocked(apiCall).mockResolvedValue(response);
  extend.mockReset();
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); });

it('extends an empty cold target while waiting to capture its initial geometry', async () => {
  const hook = mount();
  publish();
  await waitFor(() => expect(hook.result.current.state?.status).toBe('seeking-target'));
  expect(apiCall).toHaveBeenCalledWith('/api/live/past-daily-candles?code=005930&from=20260301&to=20260331&venue=KRX', expect.any(Object));
  expect(extend).toHaveBeenCalledExactlyOnceWith('20260330');
  hook.rerender({ ...defaults, queryStatus: { kind: 'ready', from: '20260330', to: '20261107' } });
  await waitFor(() => expect(hook.result.current.state?.status).toBe('no-data'));
  hook.rerender({ ...defaults, candles: [{ ts_ms: Date.UTC(2026, 2, 30) }] });
  expect(hook.result.current.state?.status).toBe('no-data');
  expect(apiCall).toHaveBeenCalledTimes(1);
});

it('cancels delayed results permanently after actual input, new view or identity', async () => {
  for (const changed of [{ inputRevision: 1 }, { viewKey: 'new' }, { identity: 'other' }]) {
    let release: (value: LivePastDailyCandlesResponse) => void = () => {};
    vi.mocked(apiCall).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const hook = mount();
    publish();
    expect(hook.result.current.state?.status).toBe('seeking-daily');
    hook.rerender({ ...defaults, ...changed });
    await act(async () => { release(response); });
    hook.rerender(defaults);
    expect(hook.result.current.state?.status).toBe('cancelled');
    expect(extend).not.toHaveBeenCalled();
    hook.unmount();
  }
});

it('consumes ineligible seq and mount baselines rather than joining old commands', async () => {
  const hook = mount({ ...defaults, target: { ...defaults.target, group: 2 } });
  publish();
  hook.rerender(defaults);
  expect(hook.result.current.state).toBeNull();
  expect(apiCall).not.toHaveBeenCalled();
  hook.unmount();
  const remount = mount();
  expect(remount.result.current.state).toBeNull();
});

it('clear and source-only invalidation preserve the common minute command', async () => {
  let release: (value: LivePastDailyCandlesResponse) => void = () => {};
  vi.mocked(apiCall).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const hook = mount();
  publish();
  const request = useLiveCursorStore.getState().jumpRequest;
  act(() => hook.result.current.clear());
  await act(async () => { release(response); });
  expect(hook.result.current.state).toBeNull();
  expect(useLiveCursorStore.getState().jumpRequest).toBe(request);
  publish();
  const current = useLiveCursorStore.getState().jumpRequest;
  if (!current) throw new Error('missing publication');
  act(() => useLiveCursorStore.getState().invalidateCalendarJumpSource(current.seq, source.sourceKey));
  expect(hook.result.current.state).toBeNull();
  expect(useLiveCursorStore.getState().jumpRequest).toEqual({ fromMs: current.fromMs, toMs: current.toMs, seq: current.seq, origin: current.origin });
});

it.each(['empty', 'error', 'partial'] as const)('settles %s without reopening on a refetch', async mode => {
  if (mode === 'error') vi.mocked(apiCall).mockRejectedValue(new Error('offline'));
  else vi.mocked(apiCall).mockResolvedValue({ ...response,
    candles: mode === 'empty' ? [] : response.candles,
    data_warnings: mode === 'partial' ? [{ batch: '1', reason: 'transport_error', msg: 'partial' }] : [] });
  const hook = mount();
  publish();
  await waitFor(() => expect(hook.result.current.state?.status).toBe(mode === 'empty' ? 'no-data' : 'failed'));
  const final = hook.result.current.state;
  for (const client of clients) await client.invalidateQueries();
  expect(hook.result.current.state).toEqual(final);
  expect(apiCall).toHaveBeenCalledTimes(1);
});

it('accepts a new sequence while the previous daily lookup is pending', () => {
  vi.mocked(apiCall).mockImplementation(() => new Promise(() => {}));
  const hook = mount();
  publish();
  expect(hook.result.current.state?.status).toBe('seeking-daily');
  publish();
  expect(hook.result.current.state?.status).toBe('seeking-daily');
});

it('repeats a terminal no-data sequence without requiring clear', async () => {
  vi.mocked(apiCall).mockResolvedValue({ ...response, candles: [] });
  const hook = mount();
  publish();
  await waitFor(() => expect(hook.result.current.state?.status).toBe('no-data'));
  publish();
  await waitFor(() => expect(hook.result.current.state?.status).toBe('no-data'));
});
