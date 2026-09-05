import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import * as client from './client';
import { useLiveSeries, type LiveSeriesResponse } from './liveSeries';
import { hydrateLiveSeries, readLiveSeries, subscribeLiveSeries, LIVE_FLUSH_MS } from './sharedLiveSeries';
import { LiveSnapshotBuffer } from '../live/liveSnapshotBuffer';
import { fakeSockets, installFakeWebSocket } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';

const CODE = '005930';
const DATE = '20260905';
const cleanups: Array<() => void> = [];
function body(extra: Partial<LiveSeriesResponse> = {}): LiveSeriesResponse {
  return { code: CODE, date: DATE, session_open_ms: 1000, session_close_ms: null, is_open: true,
    snapshots: [], trades: [], brokers: [], programs: [], after_hours: [], expected: [], ask_peak_today: null, ...extra };
}
function subscribe(date = DATE) {
  const stop = subscribeLiveSeries(CODE, date, () => {});
  cleanups.push(stop);
  return stop;
}
async function socket() {
  await Promise.resolve();
  expect(fakeSockets).toHaveLength(1);
  const sock = fakeSockets[0];
  sock.open();
  return sock;
}

beforeEach(() => {
  installFakeWebSocket(); resetWs();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
});
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
  resetWs(); vi.useRealTimers(); vi.restoreAllMocks();
});

it('eight same-code views share one push and snapshot; closing one leaves the others live', async () => {
  const response = body();
  const api = vi.spyOn(client, 'apiCall').mockImplementation(async (path) => path.startsWith('/api/live/series') ? response : []);
  const push = vi.spyOn(LiveSnapshotBuffer.prototype, 'push');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hooks = Array.from({ length: 8 }, () => renderHook(() => useLiveSeries(CODE, 'KRX'), { wrapper }));
  await waitFor(() => expect(hooks.every((h) => !!h.result.current.initial)).toBe(true));
  const sock = await socket();
  act(() => sock.message({ ch: 'live', code: CODE, data: { t_ms: 1_000_000, kind: 'ob', venue: 'KRX' } }));
  await waitFor(() => expect(hooks.every((h) => h.result.current.ob.length === 1)).toBe(true));
  expect(push).toHaveBeenCalledTimes(1);
  expect(new Set(hooks.map((h) => h.result.current.ob)).size).toBe(1);
  expect(api.mock.calls.filter(([p]) => p.startsWith('/api/live/series'))).toHaveLength(1);
  hooks[0].unmount();
  expect(sock.parsedSent().filter((f) => f.action === 'unsubscribe')).toHaveLength(0);
  act(() => sock.message({ ch: 'live', code: CODE, data: { t_ms: 1_000_001, kind: 'ob', venue: 'KRX' } }));
  await waitFor(() => expect(hooks[1].result.current.ob).toHaveLength(2));
  expect(push).toHaveBeenCalledTimes(2);
  for (const h of hooks.slice(1)) h.unmount();
  expect(sock.parsedSent().filter((f) => f.action === 'unsubscribe')).toHaveLength(1);
  qc.clear();
});

it('late REST hydration keeps pending live ticks and the existing history of other windows', async () => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  const frame = (t_ms: number, qty: number) => ({ t_ms, kind: 'ob', venue: 'KRX', qty });
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ snapshots: [frame(100, 1)] }));
  sock.message({ ch: 'live', code: CODE, data: frame(300, 3) });
  // 2번째 창의 REST가 더 늦게 도착한다. 아직 150ms flush 전인 tick도 남아야 한다.
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ snapshots: [frame(200, 2), frame(300, 0), frame(400, 4)] }));
  expect(readLiveSeries(CODE, DATE, 'KRX').ob.map((f) => [f.t_ms, f.qty])).toEqual([[100, 1], [200, 2], [300, 0], [300, 3], [400, 4]]);
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').ob).toHaveLength(5);
});

it.each([
  ['ob', 'snapshots', 'ob'], ['trade', 'trades', 'trade'], ['broker', 'brokers', 'broker'],
  ['program', 'programs', 'program'], ['ah', 'after_hours', 'afterHours'], ['expected', 'expected', 'expected'],
] as const)('%s hydration preserves distinct same-time events and their multiplicity', async (kind, field, output) => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  const frame = (qty: number) => ({ t_ms: 100, kind, venue: 'KRX', values: [{ price: 50_000, qty }] });
  for (const qty of [2, 3, 3]) sock.message({ ch: 'live', code: CODE, data: frame(qty) });
  const snapshots = [1, 2, 2, 3].map((qty) => ({
    // REST JSON key order can differ, including inside a nested payload.
    values: [{ qty, price: 50_000 }], venue: 'KRX', kind, t_ms: 100,
  }));
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ [field]: snapshots }));
  const qtys = () => readLiveSeries(CODE, DATE, 'KRX')[output].map((f) =>
    (f.values as Array<{ qty: number }>)[0].qty);
  expect(qtys()).toEqual([1, 2, 2, 3, 3]);
  expect(readLiveSeries(CODE, DATE, 'NXT')[output]).toHaveLength(0);
  // A later REST fetch of the same records must not multiply already merged events.
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ [field]: structuredClone(snapshots) }));
  expect(qtys()).toEqual([1, 2, 2, 3, 3]);
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(qtys()).toEqual([1, 2, 2, 3, 3]);
});

it('venue projections remain stable on unrelated ticks and preserve the last KRX book on eviction', async () => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ snapshots: [{ t_ms: 100, kind: 'ob', venue: 'KRX' }] }));
  const before = readLiveSeries(CODE, DATE, 'KRX');
  sock.message({ ch: 'live', code: CODE, data: { t_ms: 200, kind: 'ob', venue: 'NXT' } });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX')).toBe(before);
  expect(readLiveSeries(CODE, DATE, 'NXT').ob.map((f) => f.t_ms)).toEqual([200]);
  sock.message({ ch: 'live', code: CODE, data: { t_ms: 1_000_000, kind: 'ob', venue: 'NXT' } });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').ob).toBe(before.ob);
  expect(readLiveSeries(CODE, DATE, 'NXT').ob.map((f) => f.t_ms)).toEqual([1_000_000]);
});

it('last unsubscribe cancels the pending flush and a new date starts empty', async () => {
  vi.useFakeTimers();
  const stop = subscribe();
  const sock = await socket();
  sock.message({ ch: 'live', code: CODE, data: { t_ms: 100, kind: 'trade', venue: 'KRX' } });
  stop();
  subscribe('20260906');
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').trade).toHaveLength(0);
  expect(readLiveSeries(CODE, '20260906', 'KRX').trade).toHaveLength(0);
});

it('hydrates after StrictMode remount without leaking the first subscription', async () => {
  vi.spyOn(client, 'apiCall').mockImplementation(async (path) => path.startsWith('/api/live/series')
    ? body({ snapshots: [{ t_ms: 100, kind: 'ob', venue: 'KRX' }] }) : []);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    <StrictMode><QueryClientProvider client={qc}>{children}</QueryClientProvider></StrictMode>;
  const { result, unmount } = renderHook(() => useLiveSeries(CODE, 'KRX'), { wrapper });
  await waitFor(() => expect(result.current.ob).toHaveLength(1));
  const sock = await socket();
  unmount();
  expect(sock.parsedSent().filter((f) => f.action === 'unsubscribe')).toHaveLength(1);
  qc.clear();
});
