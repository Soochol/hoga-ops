import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import * as client from './client';
import { useLiveSeries, type LiveSeriesResponse } from './liveSeries';
import { hydrateLiveSeries, readLiveSeries, subscribeLiveSeries, LIVE_FLUSH_MS, RETAINED_BOOK_MS, __resetRetainedBooksForTests } from './sharedLiveSeries';
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

it('keeps coalesced latest book out of the indicator history', async () => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  const frame = (seq: number) => ({ seq, t_ms: seq, kind: 'ob', venue: 'KRX' });
  sock.message({ ch: 'live_batch', code: CODE, data: [frame(1), frame(2)], latest: [frame(99)], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  const data = readLiveSeries(CODE, DATE, 'KRX');
  expect(data.ob.map((row) => row.t_ms)).toEqual([1, 2]);
  expect(data.latestOb?.t_ms).toBe(99);
  expect(readLiveSeries(CODE, DATE, 'NXT').latestOb).toBeUndefined();
});

it('converges to a newer REST book after the Symtec stale-WS sequence without rewriting history', async () => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  const at = (s: string) => Date.parse(`2026-10-23T${s}+09:00`);
  const book = (time: string, qty: number) => ({ t_ms: at(time), kind: 'ob', venue: 'KRX',
    asks: [{ price: 112100, qty }], bids: [] });
  const old = book('16:56:47', 1);
  sock.message({ ch: 'live_batch', code: CODE, latest: [{ ...old, seq: 100 }], data: [old], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  const fresh = book('16:57:19', 2);
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: fresh }));
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.t_ms).toBe(fresh.t_ms);
  expect(readLiveSeries(CODE, DATE, 'KRX').ob).toEqual([old]);
  // A slow prior response cannot rewind either the selected book or same-second WS values.
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: old }));
  sock.message({ ch: 'live_batch', code: CODE, latest: [{ ...fresh, seq: 101, asks: [{ price: 112100, qty: 3 }] }], data: [], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: fresh }));
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.asks?.[0].qty).toBe(3);
  expect(readLiveSeries(CODE, DATE, 'NXT').latestOb).toBeUndefined();
});
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
  __resetRetainedBooksForTests();
  resetWs(); vi.useRealTimers(); vi.restoreAllMocks();
});

it('restores a recent latest ladder on revisit without retaining history or subscriptions', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-05T10:00:00+09:00'));
  const stop = subscribe();
  const sock = await socket();
  const book = { t_ms: Date.now(), kind: 'ob', venue: 'KRX', asks: [{ price: 70000, qty: 2 }], bids: [] };
  sock.message({ ch: 'live_batch', code: CODE, data: [], latest: [book], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  stop();
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb).toBeUndefined();
  subscribe();
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb).toEqual(book);
  expect(readLiveSeries(CODE, DATE, 'KRX').ob).toEqual([]);
  expect(readLiveSeries(CODE, DATE, 'NXT').latestOb).toBeUndefined();
  hydrateLiveSeries(CODE, DATE, 'KRX', body());
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb).toEqual(book);
});

it('expires the retained ladder and never transfers it across dates', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-05T10:00:00+09:00'));
  const stop = subscribe();
  const sock = await socket();
  sock.message({ ch: 'live_batch', code: CODE, data: [], latest: [{ t_ms: Date.now(), kind: 'ob', venue: 'KRX' }], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  stop();
  subscribe('20260906');
  expect(readLiveSeries(CODE, '20260906', 'KRX').latestOb).toBeUndefined();
  await vi.advanceTimersByTimeAsync(RETAINED_BOOK_MS + 1);
  subscribe();
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb).toBeUndefined();
});

it('tracks browser book receipts independently of REST, trades and other venues', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  subscribe();
  const sock = await socket();
  sock.message({ ch: 'live_batch', code: CODE, data: [], latest: [{ kind: 'ob', venue: 'KRX', t_ms: 5000, seq: 1 }], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').bookReceivedAtMs).toBe(10_000);
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: { kind: 'ob', venue: 'KRX', t_ms: 6000 } }));
  sock.message({ ch: 'live', code: CODE, data: { kind: 'trade', venue: 'KRX', t_ms: 7000 } });
  sock.message({ ch: 'live', code: CODE, data: { kind: 'ob', venue: 'NXT', t_ms: 7000 } });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').bookReceivedAtMs).toBe(10_000);
  expect(readLiveSeries(CODE, DATE, 'NXT').bookReceivedAtMs).toBe(10_000 + LIVE_FLUSH_MS);
});

it('keeps a newer reset over delayed REST and accepts new-connection same-second WS sequence', async () => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  const row = (t_ms: number, qty: number) => ({ kind: 'ob', venue: 'KRX', t_ms,
    asks: [{ price: 112100, qty }], bids: [] });
  sock.message({ ch: 'live_batch', code: CODE, data: [], latest: [{ ...row(1000, 1), seq: 100 }], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: { ...row(2000, 0), asks: [], bids: [] } }));
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: row(1000, 2) }));
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.t_ms).toBe(2000);
  expect(readLiveSeries(CODE, DATE, 'KRX').lastValidOb?.t_ms).toBe(1000);
  sock.serverClose();
  await vi.advanceTimersByTimeAsync(501);
  fakeSockets[1].open();
  fakeSockets[1].message({ ch: 'live_batch', code: CODE, data: [], latest: [{ ...row(2000, 3), seq: 1 }], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.asks?.[0].qty).toBe(3);
});

it('retains usable ladders through empty resets and never rewinds on delayed WS or REST frames', async () => {
  vi.useFakeTimers();
  subscribe();
  const sock = await socket();
  const book = (t_ms: number, price: number, seq = t_ms) => ({ t_ms, seq, kind: 'ob', venue: 'KRX',
    asks: [{ price, qty: 1 }], bids: [{ price, qty: 1 }] });
  const valid = book(100, 33350);
  sock.message({ ch: 'live', code: CODE, data: valid });
  sock.message({ ch: 'live', code: CODE, data: book(110, 0) });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.t_ms).toBe(110);
  expect(readLiveSeries(CODE, DATE, 'KRX').lastValidOb).toEqual(valid);
  const early = book(120, 33400);
  sock.message({ ch: 'live_batch', code: CODE, data: [book(99, 33000)], latest: [early], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  hydrateLiveSeries(CODE, DATE, 'KRX', body({ last_ob: book(115, 33200) }));
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.asks).toEqual(early.asks);
  expect(readLiveSeries(CODE, DATE, 'KRX').lastValidOb?.asks).toEqual(early.asks);
  sock.message({ ch: 'live_batch', code: CODE, data: [], latest: [book(120, 33100, 119)], dropped: 0 });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb?.asks).toEqual(early.asks);
  const sameSecond = book(120, 33450, 121);
  sock.message({ ch: 'live', code: CODE, data: sameSecond });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, DATE, 'KRX').latestOb).toEqual(sameSecond);
  expect(readLiveSeries(CODE, DATE, 'NXT').lastValidOb).toBeUndefined();
});

it('preserves the pre-auction WS ladder even after auction/reset frames and history eviction', async () => {
  vi.useFakeTimers();
  subscribe('20261014');
  const sock = await socket();
  const at = (hour: number, minute: number, second = 0) => Date.UTC(2026, 9, 14, hour - 9, minute, second);
  const preAuction = { t_ms: at(15, 19, 59), kind: 'ob', venue: 'KRX', asks: [{ price: 33400, qty: 2 }], bids: [{ price: 33350, qty: 3 }] };
  sock.message({ ch: 'live', code: CODE, data: preAuction });
  sock.message({ ch: 'live', code: CODE, data: { ...preAuction, t_ms: at(15, 25), asks: [{ price: 33500, qty: 10 }] } });
  sock.message({ ch: 'live', code: CODE, data: { ...preAuction, t_ms: at(15, 40), asks: [], bids: [] } });
  await vi.advanceTimersByTimeAsync(LIVE_FLUSH_MS);
  expect(readLiveSeries(CODE, '20261014', 'KRX').preAuctionOb).toEqual(preAuction);
  expect(readLiveSeries(CODE, '20261014', 'KRX').ob.some(row => row.t_ms === preAuction.t_ms)).toBe(false);
  expect(readLiveSeries(CODE, '20261014', 'NXT').preAuctionOb).toBeUndefined();
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
