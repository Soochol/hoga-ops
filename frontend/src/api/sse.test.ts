import { describe, expect, it, beforeEach } from 'vitest';
import { __resetForTests, subscribeToCaptureEvents } from './sse';
import type { SSEEvent } from './types';

// Helper that mounts a fake EventSource so addEventListener traps capture events.
// Instances tracked at module scope rather than as a static class field — tsconfig's
// `erasableSyntaxOnly` rejects static class fields.
const _fakeInstances: FakeEventSource[] = [];
class FakeEventSource {
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    _fakeInstances.push(this);
  }
  addEventListener(t: string, cb: (e: MessageEvent) => void) {
    const arr = this.listeners.get(t) ?? [];
    arr.push(cb);
    this.listeners.set(t, arr);
  }
  fire(t: string, data: unknown) {
    (this.listeners.get(t) ?? []).forEach((cb) =>
      cb({ data: JSON.stringify(data) } as MessageEvent),
    );
  }
  close() {}
}

beforeEach(() => {
  __resetForTests();
  _fakeInstances.length = 0;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

describe('subscribeToCaptureEvents', () => {
  it('delivers capture_queued events to subscribers', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    // Let open() resolve.
    await new Promise((r) => setTimeout(r, 0));
    const src = _fakeInstances[0];
    src.fire('capture_queued', { items: [{ item_id: 'x', code: '005930', date: '20260520' }] });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('capture_queued');
  });

  it('delivers capture_queue_paused, capture_queue_resumed, capture_queue_drained', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0));
    const src = _fakeInstances[0];
    src.fire('capture_queue_paused', { reason: 'cookie_expired', message: 'expired' });
    src.fire('capture_queue_resumed', { reason: 'user_resume' });
    src.fire('capture_queue_drained', { total_done: 1, total_failed: 0, total_cancelled: 0, total_skipped: 0 });
    expect(events.map((e) => e.type)).toEqual([
      'capture_queue_paused', 'capture_queue_resumed', 'capture_queue_drained',
    ]);
  });

  it('drops non-capture events (inventory_added) through the capture filter', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0));
    const src = _fakeInstances[0];
    src.fire('inventory_added', { code: '005930', date: '20260520' });
    expect(events).toHaveLength(0);
  });
});
