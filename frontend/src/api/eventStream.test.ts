import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';
import * as client from './client';
import {
  LIST_SYNC_AXES,
  subscribeToCaptureEvents,
  subscribeToScreenerUpdateEvents,
  useEventStream,
} from './eventStream';
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

describe('subscribeToScreenerUpdateEvents 이름 경계', () => {
  it('screener_saves_changed 는 갱신 job 소비처로 새지 않는다', async () => {
    // 필터가 `startsWith('screener_update')` 라, 저장 목록 신호를 그 접두사로
    // 이름 지었다면 드로어·칩의 판별 유니온이 헛돈다. 이름이 경계를 지고 있으므로
    // 그 사실을 테스트로 고정한다.
    const events: PushEvent[] = [];
    subscribeToScreenerUpdateEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'screener_saves_changed' } });
    sock.message({ ch: 'event', data: { type: 'screener_update_progress', done: 1, total: 2 } });
    expect(events.map((e) => e.type)).toEqual(['screener_update_progress']);
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

describe('useEventStream 목록 교차 창 동기화', () => {
  // 서버가 브로드캐스트하는 "바뀌었다" 신호(hoga/api/mutation_broadcast.py)를 받으면
  // 이 창은 목록을 다시 읽어야 한다. 그게 다른 브라우저에서 추가한 종목이 새로고침
  // 없이 나타나는 유일한 경로다.
  function mount() {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useEventStream(), { wrapper });
    return spy;
  }

  function keys(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls
      .map((call) => call[0] as { queryKey?: unknown } | undefined)
      .filter((arg): arg is { queryKey: unknown[] } => Array.isArray(arg?.queryKey))
      .map((arg) => arg.queryKey.join(','));
  }

  it('watchlist_changed 를 받으면 관심목록을 다시 읽는다', async () => {
    vi.useFakeTimers();
    try {
      const spy = mount();
      await vi.advanceTimersByTimeAsync(0);
      fakeSockets[0].open();
      fakeSockets[0].message({ ch: 'event', data: { type: 'watchlist_changed' } });

      expect(keys(spy)).not.toContain('watchlist');   // 접기 창이 끝나기 전
      await vi.advanceTimersByTimeAsync(250);
      expect(keys(spy)).toContain('watchlist');
      // 히트맵은 독립 스토어다(ADR-0068) — 관심목록 신호가 건드리면 안 된다.
      expect(keys(spy)).not.toContain('heatmap');
    } finally {
      vi.useRealTimers();
    }
  });

  it('heatmap_changed 는 지수·업종 랭킹까지 함께 무효화한다', async () => {
    // 랭킹 응답이 히트맵 그룹 구성을 그대로 투영하므로, 히트맵만 무효화하면
    // **원격 창에서만** 옛 그룹이 남는다 — 로컬 mutation 경로와 같은 집합이어야 한다.
    vi.useFakeTimers();
    try {
      const spy = mount();
      await vi.advanceTimersByTimeAsync(0);
      fakeSockets[0].open();
      fakeSockets[0].message({ ch: 'event', data: { type: 'heatmap_changed' } });
      await vi.advanceTimersByTimeAsync(250);

      expect(keys(spy)).toContain('heatmap');
      expect(keys(spy)).toContain('live,index-sector-rankings');
      expect(keys(spy)).not.toContain('watchlist');
    } finally {
      vi.useRealTimers();
    }
  });

  it('연속 변경 버스트를 한 번의 무효화로 접는다', async () => {
    // 다중 선택 이동은 변경 라우트를 여러 번 친다 → 서버 신호도 그 횟수만큼 온다.
    vi.useFakeTimers();
    try {
      const spy = mount();
      await vi.advanceTimersByTimeAsync(0);
      fakeSockets[0].open();
      for (let i = 0; i < 8; i += 1) {
        fakeSockets[0].message({ ch: 'event', data: { type: 'watchlist_changed' } });
      }
      await vi.advanceTimersByTimeAsync(250);

      expect(keys(spy).filter((k) => k === 'watchlist')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('screener_saves_changed / study_views_changed 를 각자 목록만 다시 읽는다', async () => {
    vi.useFakeTimers();
    try {
      const spy = mount();
      await vi.advanceTimersByTimeAsync(0);
      fakeSockets[0].open();
      fakeSockets[0].message({ ch: 'event', data: { type: 'screener_saves_changed' } });
      fakeSockets[0].message({ ch: 'event', data: { type: 'study_views_changed' } });
      await vi.advanceTimersByTimeAsync(250);

      expect(keys(spy)).toContain('screener-saves');
      expect(keys(spy)).toContain('study-view-saves');
      // 축이 넷이어도 서로를 건드리지 않는다.
      expect(keys(spy)).not.toContain('watchlist');
      expect(keys(spy)).not.toContain('heatmap');
    } finally {
      vi.useRealTimers();
    }
  });

  it('레이아웃 프리셋 2종도 각자 목록만 다시 읽는다', async () => {
    vi.useFakeTimers();
    try {
      const spy = mount();
      await vi.advanceTimersByTimeAsync(0);
      fakeSockets[0].open();
      fakeSockets[0].message({ ch: 'event', data: { type: 'live_layout_presets_changed' } });
      fakeSockets[0].message({ ch: 'event', data: { type: 'study_layout_presets_changed' } });
      await vi.advanceTimersByTimeAsync(250);

      expect(keys(spy)).toContain('live-layout-presets');
      expect(keys(spy)).toContain('study-layout-presets');
      expect(keys(spy)).not.toContain('watchlist');
    } finally {
      vi.useRealTimers();
    }
  });

  it('축 등록부가 기대한 6개 그대로다 (누락·오타 감지)', () => {
    // 테이블이 단일 출처라 아래 재연결 단언이 자동으로 새 축을 덮는다. 그 자동성이
    // "축을 조용히 빠뜨려도 초록" 을 뜻하지 않도록, 등록부 자체를 여기서 못박는다.
    // 축을 늘렸다면 이 목록도 같이 늘리는 것이 의도된 마찰이다.
    expect(LIST_SYNC_AXES.map((a) => a.event)).toEqual([
      'watchlist_changed',
      'heatmap_changed',
      'screener_saves_changed',
      'study_views_changed',
      'live_layout_presets_changed',
      'study_layout_presets_changed',
    ]);
  });

  it('모든 축이 재연결 복구에도 들어 있다 (짝 규칙)', async () => {
    // 축을 추가하면서 재연결 복구를 빠뜨리는 것이 이 기능에서 가장 놓치기 쉬운
    // 실수다 — 평상시엔 멀쩡하고 **재연결한 창에서만** 조용히 어긋나기 때문이다.
    // 축별 무효화 키를 각각 모아, 재연결 한 번이 그 합집합을 덮는지 잰다.
    const perAxis = new Set<string>();
    for (const axis of LIST_SYNC_AXES) {
      const qc = new QueryClient();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      axis.invalidate(qc);
      keys(spy).forEach((k) => perAxis.add(k));
    }
    expect(perAxis.size).toBeGreaterThan(0);

    const spy = mount();
    await new Promise((r) => setTimeout(r, 0));
    fakeSockets[0].open();
    fakeSockets[0].serverClose();
    await new Promise((r) => setTimeout(r, 0));

    const onReconnect = new Set(keys(spy));
    const missing = [...perAxis].filter((k) => !onReconnect.has(k));
    expect(missing).toEqual([]);
  });

  it('재연결 시 끊겨 있던 동안의 목록 변경을 따라잡는다', async () => {
    // EventBus 는 큐를 연결에 매달아 두므로 끊긴 사이의 신호는 재전송되지 않는다.
    const spy = mount();
    await new Promise((r) => setTimeout(r, 0));
    fakeSockets[0].open();
    fakeSockets[0].serverClose();
    await new Promise((r) => setTimeout(r, 0));

    expect(keys(spy)).toContain('watchlist');
    expect(keys(spy)).toContain('heatmap');
    expect(keys(spy)).toContain('live,index-sector-rankings');
    expect(keys(spy)).toContain('screener-saves');
    expect(keys(spy)).toContain('study-view-saves');
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
