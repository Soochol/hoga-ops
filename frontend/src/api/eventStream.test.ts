import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';
import * as client from './client';
import { subscribeToCaptureEvents, useEventStream } from './eventStream';
import { useLivePromotionStore } from '../state/livePromotion';
import type { PushEvent } from './types';

beforeEach(() => {
  installFakeWebSocket();
  resetWs();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
});

async function connect() {
  await new Promise((r) => setTimeout(r, 0));
  const sock = fakeSockets[0];
  sock.open();
  return sock;
}

describe('subscribeToCaptureEvents', () => {
  it('delivers capture_queued events', async () => {
    const events: PushEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_queued', items: [] } });
    expect(events.map((e) => e.type)).toEqual(['capture_queued']);
  });

  it('delivers capture_dismissed (regression: dropped at two levels before)', async () => {
    const events: PushEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_dismissed', item_ids: ['x'] } });
    expect(events.map((e) => e.type)).toEqual(['capture_dismissed']);
  });

  it('drops non-capture events (inventory_added)', async () => {
    const events: PushEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'inventory_added', code: '005930', date: '20260520' } });
    expect(events).toHaveLength(0);
  });
});

describe('useEventStream promotion handler', () => {
  it('stamps the promotion + invalidates the code range on promotion_completed', async () => {
    useLivePromotionStore.setState({ byCode: {} });
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useEventStream(), { wrapper });
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'promotion_completed', code: '005930', date: '20260708' } });
    await new Promise((r) => setTimeout(r, 0));
    // per-code stamp advanced → delta hooks recompute refreshDue
    expect(useLivePromotionStore.getState().byCode['005930']).toBeGreaterThan(0);
    // simple useRange consumers invalidated via predicate on ['range', code]
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: any) => typeof c?.predicate === 'function')).toBe(true);
  });
});

describe('useEventStream disconnect handler', () => {
  it('invalidates queue + calendar + stock dates on disconnect', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useEventStream(), { wrapper });
    const sock = await connect();
    sock.serverClose();
    await new Promise((r) => setTimeout(r, 0));
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: any) => Array.isArray(c?.queryKey) && c.queryKey[0] === 'stock-dates')).toBe(true);
    expect(calls.some((c: any) => Array.isArray(c?.queryKey) && c.queryKey.join(',') === 'capture,queue')).toBe(true);
    expect(calls.some((c: any) => typeof c?.predicate === 'function')).toBe(true);
  });
});

describe('useEventStream inventory 무효화 접기', () => {
  function mount() {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const view = renderHook(() => useEventStream(), { wrapper });
    return { spy, view };
  }

  function stockDatesCalls(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls
      .map((call) => call[0] as { queryKey?: unknown } | undefined)
      .filter((arg) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === 'stock-dates')
      .length;
  }

  it('버스트를 한 번의 무효화로 접는다', async () => {
    // `/api/stock-dates` 는 응답 하나가 parquet 트리 전체 순회다(warm 274ms). 접기
    // 없이는 캡처 100건 배치가 274ms 순회 100회를 낸다. inotify 가 meta.json 한 번
    // 쓰기에 두 이벤트를 내는 것까지 겹친다.
    vi.useFakeTimers();
    try {
      const { spy } = mount();
      // connect()는 실시간 타이머를 쓰므로 fake timer 아래서 직접 진행시킨다.
      await vi.advanceTimersByTimeAsync(0);
      const sock = fakeSockets[0];
      sock.open();

      for (let i = 0; i < 10; i += 1) {
        sock.message({
          ch: 'event',
          data: { type: 'inventory_added', code: '005930', date: `202607${10 + i}` },
        });
      }
      expect(stockDatesCalls(spy)).toBe(0);   // 창이 끝나기 전엔 아직 안 나간다

      await vi.advanceTimersByTimeAsync(250);
      expect(stockDatesCalls(spy)).toBe(1);   // 10건 → 1회
    } finally {
      vi.useRealTimers();
    }
  });

  it('언마운트 시 예약된 타이머를 취소한다', async () => {
    vi.useFakeTimers();
    try {
      const { spy, view } = mount();
      await vi.advanceTimersByTimeAsync(0);
      const sock = fakeSockets[0];
      sock.open();
      sock.message({
        ch: 'event',
        data: { type: 'inventory_added', code: '005930', date: '20260710' },
      });

      view.unmount();
      await vi.advanceTimersByTimeAsync(250);

      // 정리된 클라이언트를 무효화하면 안 된다.
      expect(stockDatesCalls(spy)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
