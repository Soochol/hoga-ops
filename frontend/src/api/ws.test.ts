import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeWebSocket, fakeSockets, installFakeWebSocket } from '../test/fakeWebSocket';
import { __resetForTests, lastHeartbeat, subscribeEvents, subscribeLive, subscribeLiveLatest, historyPartial } from './ws';
import * as client from './client';

beforeEach(() => {
  installFakeWebSocket();
  __resetForTests();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
});

async function connect(): Promise<FakeWebSocket> {
  await new Promise((r) => setTimeout(r, 0));
  const s = fakeSockets[0];
  s.open();
  return s;
}

describe('ws.ts', () => {
  it('delivers ch:event frames and emits connected on open', async () => {
    const got: any[] = [];
    subscribeEvents((e) => got.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'inventory_added', code: '005930', date: '20260530' } });
    expect(got).toContainEqual({ type: 'connected' });
    expect(got).toContainEqual({ type: 'inventory_added', code: '005930', date: '20260530' });
  });

  it('delivers ch:live frames only to the matching code', async () => {
    const a: any[] = []; const b: any[] = [];
    subscribeLive('005930', (d) => a.push(d));
    subscribeLive('000660', (d) => b.push(d));
    const sock = await connect();
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '005930', protocol: 2 });
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '000660', protocol: 2 });
    sock.message({ ch: 'live', code: '005930', data: { t_ms: 1, kind: 'ob' } });
    expect(a).toEqual([{ t_ms: 1, kind: 'ob' }]);
    expect(b).toEqual([]);
  });

  it('stamps lastHeartbeat on open and on any frame', async () => {
    subscribeEvents(() => {});
    const sock = await connect();
    // onopen stamps liveness so the watchdog has a baseline from connect.
    expect(lastHeartbeat()).toBeGreaterThan(0);
    const afterOpen = lastHeartbeat();
    sock.message({ ch: 'heartbeat' });
    // Any incoming frame also re-stamps liveness.
    expect(lastHeartbeat()).toBeGreaterThanOrEqual(afterOpen);
  });

  it('emits disconnected once on close', async () => {
    const got: any[] = [];
    subscribeEvents((e) => got.push(e));
    const sock = await connect();
    sock.serverClose();
    expect(got.filter((e) => e.type === 'disconnected')).toHaveLength(1);
  });

  it('no-ops when WebSocket is undefined (jsdom default)', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    __resetForTests();
    expect(() => subscribeEvents(() => {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeSockets.length).toBe(0);
  });

  it('force-closes and reconnects a silently-stale socket (no onclose)', async () => {
    vi.useFakeTimers();
    try {
      subscribeEvents(() => {});
      await vi.advanceTimersByTimeAsync(0); // resolve wsUrl
      const sock = fakeSockets[0];
      sock.open(); // onopen stamps lastHeartbeat
      // No frames arrive; advance past the liveness timeout + a watchdog tick.
      const closeSpy = vi.spyOn(sock, 'close');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(closeSpy).toHaveBeenCalled(); // watchdog force-closed the dead socket
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects after close and resubscribes active codes', async () => {
    // Fake timers scoped to this test: the backoff reconnect lives behind a
    // setTimeout, and open() suspends on `await wsUrl(...)` (a microtask), so we
    // interleave *Async timer advances (which also drain microtasks) to drive
    // both the timer and the awaited URL resolution deterministically.
    vi.useFakeTimers();
    try {
      subscribeLive('005930', () => {});
      await vi.advanceTimersByTimeAsync(0); // flush open()'s `await wsUrl(...)`
      fakeSockets[0].open();
      expect(fakeSockets[0].parsedSent()).toContainEqual({ action: 'subscribe', code: '005930', protocol: 2 });

      fakeSockets[0].serverClose(); // onclose schedules a reconnect timer (500ms)
      await vi.advanceTimersByTimeAsync(500); // fire timer → open() reconstructs socket
      expect(fakeSockets.length).toBe(2);

      fakeSockets[1].open();
      // The reconnected socket re-sends the subscribe for the still-active code.
      expect(fakeSockets[1].parsedSent()).toContainEqual({ action: 'subscribe', code: '005930', protocol: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

it('delivers latest before ordered history and rejects stale latest batches', async () => {
  const latest: number[] = []; const history: number[] = [];
  subscribeLiveLatest('A', (d) => latest.push(d.t_ms));
  subscribeLive('A', (d) => history.push(d.t_ms));
  const sock = await connect();
  const row = (seq: number) => ({ seq, t_ms: seq, venue: 'KRX', kind: 'ob' });
  sock.message({ ch: 'live_batch', code: 'A', latest: [row(10)], data: [row(1), row(2)], dropped: 3 });
  sock.message({ ch: 'live_batch', code: 'A', latest: [row(4)], data: [row(3), row(4)], dropped: 0 });
  expect(latest).toEqual([10]);
  expect(history).toEqual([1, 2, 3, 4]);
  expect(historyPartial('A')).toBe(true);
});

it('reports reconnect gaps and accepts new server sequence numbers', async () => {
  vi.useFakeTimers();
  try {
    const latest: number[] = [];
    subscribeLiveLatest('A', (d) => latest.push(d.t_ms));
    await vi.advanceTimersByTimeAsync(0);
    const sock = fakeSockets[0]; sock.open();
    const row = (seq: number) => ({ seq, t_ms: seq, kind: 'ob' });
    sock.message({ ch: 'live_batch', code: 'A', latest: [row(10)], data: [], dropped: 0 });
    sock.serverClose();
    expect(historyPartial('A')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    fakeSockets[1].open();
    fakeSockets[1].message({ ch: 'live_batch', code: 'A', latest: [row(1)], data: [], dropped: 0 });
    expect(latest).toEqual([10, 1]);
  } finally { vi.useRealTimers(); }
});
