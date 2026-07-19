import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useWorkspaceStore,
  activeGroupOf,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceWindow,
} from './workspace';

function chart(id: string, group: number): WorkspaceWindow {
  return {
    id,
    kind: 'chart',
    group,
    rect: { x: 0, y: 0, w: 500, h: 400 },
    chart: {
      timeframe: '1m',
      indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} },
    },
  };
}

function book(id: string, group: number): WorkspaceWindow {
  return { id, kind: 'book', group, rect: { x: 0, y: 0, w: 236, h: 440 } };
}

describe('activeGroupOf', () => {
  it('포커스 창(zOrder 마지막)의 그룹을 반환한다', () => {
    const state = { windows: [chart('a', 3), chart('b', 7)], zOrder: ['a', 'b'] };
    expect(activeGroupOf(state)).toBe(7);
  });
  it('창이 없으면 그룹 1', () => {
    expect(activeGroupOf({ windows: [], zOrder: [] })).toBe(1);
  });
});

describe('useWorkspaceStore 액션', () => {
  beforeEach(() => {
    // 알려진 상태로 초기화 — 싱글톤 하이드레이션·이전 테스트 잔여 제거.
    useWorkspaceStore.setState({ windows: [chart('a', 3)], zOrder: ['a'], groupSymbols: {} });
    localStorage.clear();
  });

  it('addWindow 는 활성 그룹을 상속한다(#711)', () => {
    const id = useWorkspaceStore.getState().addWindow('book');
    const win = useWorkspaceStore.getState().windows.find((w) => w.id === id);
    expect(win?.group).toBe(3); // 포커스 차트 'a' 의 그룹
    expect(win?.kind).toBe('book');
  });

  it('새 차트 창은 포커스 차트 창의 timeframe 을 복제한다(#712)', () => {
    useWorkspaceStore.setState({
      windows: [{ ...chart('a', 3), chart: { timeframe: 'D', indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} } } }],
      zOrder: ['a'],
      groupSymbols: {},
    });
    const id = useWorkspaceStore.getState().addWindow('chart');
    const win = useWorkspaceStore.getState().windows.find((w) => w.id === id);
    expect(win?.chart?.timeframe).toBe('D');
  });

  it('closeWindow 는 창과 zOrder 에서 함께 제거한다', () => {
    const id = useWorkspaceStore.getState().addWindow('book');
    useWorkspaceStore.getState().closeWindow(id);
    const s = useWorkspaceStore.getState();
    expect(s.windows.some((w) => w.id === id)).toBe(false);
    expect(s.zOrder.includes(id)).toBe(false);
  });

  it('focusWindow 는 zOrder 끝으로 올린다', () => {
    useWorkspaceStore.setState({ windows: [chart('a', 1), book('b', 1)], zOrder: ['a', 'b'], groupSymbols: {} });
    useWorkspaceStore.getState().focusWindow('a');
    expect(useWorkspaceStore.getState().zOrder).toEqual(['b', 'a']);
  });

  it('setWindowGroup 은 범위 밖 그룹을 거부한다', () => {
    useWorkspaceStore.getState().setWindowGroup('a', 11);
    expect(useWorkspaceStore.getState().windows[0].group).toBe(3); // 불변
    useWorkspaceStore.getState().setWindowGroup('a', 5);
    expect(useWorkspaceStore.getState().windows[0].group).toBe(5);
  });

  it('setWindowRects 는 여러 창을 한 번에 커밋한다(스플리터)', () => {
    useWorkspaceStore.setState({ windows: [chart('a', 1), book('b', 1)], zOrder: ['a', 'b'], groupSymbols: {} });
    useWorkspaceStore.getState().setWindowRects([
      { id: 'a', rect: { x: 0, y: 0, w: 300, h: 400 } },
      { id: 'b', rect: { x: 300, y: 0, w: 200, h: 400 } },
    ]);
    const s = useWorkspaceStore.getState();
    expect(s.windows.find((w) => w.id === 'a')?.rect.w).toBe(300);
    expect(s.windows.find((w) => w.id === 'b')?.rect.x).toBe(300);
  });

  it('tidyAll 은 겹침 없는 타일로 재배치한다', () => {
    useWorkspaceStore.setState({
      windows: [chart('a', 1), chart('b', 2)],
      zOrder: ['a', 'b'],
      groupSymbols: {},
    });
    useWorkspaceStore.getState().tidyAll({ w: 1000, h: 800 });
    const s = useWorkspaceStore.getState();
    const a = s.windows.find((w) => w.id === 'a')!.rect;
    const b = s.windows.find((w) => w.id === 'b')!.rect;
    expect(a.x + a.w).toBe(b.x); // 나란히, 겹침 없음
  });

  it('액션은 localStorage 로 영속화한다', () => {
    useWorkspaceStore.getState().addWindow('book');
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).windows.length).toBe(2);
  });
});

describe('손상된 저장값 방어(관대한 per-entry 검증)', () => {
  it('손상된 창은 드롭하고 정상 창만 하이드레이션한다', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [
          { id: 'good', kind: 'book', group: 2, rect: { x: 1, y: 2, w: 300, h: 300 } },
          { id: 'badGroup', kind: 'book', group: 99, rect: { x: 0, y: 0, w: 200, h: 200 } },
          { id: 'badKind', kind: 'nope', group: 1, rect: { x: 0, y: 0, w: 200, h: 200 } },
          { noId: true },
        ],
        zOrder: ['good', 'ghost'],
        groupSymbols: { 2: { code: '005930', name: '삼성전자' }, 99: { code: 'x', name: 'y' } },
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['good']);
    expect(s.zOrder).toEqual(['good']); // ghost 드롭
    expect(s.groupSymbols[2]).toEqual({ code: '005930', name: '삼성전자' });
    expect(s.groupSymbols[99]).toBeUndefined(); // 범위 밖 그룹 드롭
  });

  it('그룹 심볼 kind=index 는 code 가 실제 LiveIndexId 일 때만 보존한다(리뷰 #2)', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [{ id: 'c', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 500, h: 400 }, chart: { timeframe: '1m' } }],
        zOrder: ['c'],
        groupSymbols: {
          1: { code: 'KOSPI', name: '코스피', kind: 'index' },   // 유효 → 보존
          2: { code: 'FOO', name: '가짜', kind: 'index' },        // 무효 code → kind 강등
        },
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const gs = mod.useWorkspaceStore.getState().groupSymbols;
    expect(gs[1]).toEqual({ code: 'KOSPI', name: '코스피', kind: 'index' });
    expect(gs[2]).toEqual({ code: 'FOO', name: '가짜' }); // kind 없음(stock 기본)
  });

  it('차트 창 하이드레이션: 손상 timeframe→1m, 지표 누락→정규화 사본', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [{ id: 'c', kind: 'chart', group: 1, rect: { x: 0, y: 0, w: 500, h: 400 }, chart: { timeframe: 'ZZZ' } }],
        zOrder: ['c'],
        groupSymbols: {},
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const win = mod.useWorkspaceStore.getState().windows[0];
    expect(win.chart?.timeframe).toBe('1m'); // 손상값 폴백
    // 지표 누락 → normalizeIndicatorsV2 로 유효 구조 복원
    expect(win.chart?.indicators).toBeTruthy();
    expect(Array.isArray(win.chart?.indicators.paneOrder)).toBe(true);
    expect(typeof win.chart?.indicators.byTimeframe).toBe('object');
  });

  it('readRect: 부분/비유한 rect 는 드롭, 미달 크기는 MIN 으로 클램프', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        windows: [
          { id: 'tiny', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 50, h: 30 } }, // MIN 미달 → 클램프
          { id: 'partial', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 300 } }, // h 누락 → 드롭
          { id: 'nonfinite', kind: 'book', group: 1, rect: { x: 0, y: 0, w: 'x', h: 200 } }, // 비유한 → 드롭
        ],
        zOrder: ['tiny', 'partial', 'nonfinite'],
        groupSymbols: {},
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.map((w) => w.id)).toEqual(['tiny']); // partial·nonfinite 드롭
    expect(s.windows[0].rect.w).toBe(160); // MIN_W 클램프
    expect(s.windows[0].rect.h).toBe(120); // MIN_H 클램프
  });

  it('모든 창이 손상되면 기본 레이아웃으로 폴백한다', async () => {
    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ windows: [{ bad: 1 }, { kind: 'nope' }], zOrder: [], groupSymbols: {} }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.length).toBe(3); // defaultWindows: chart + book + broker
    expect(s.windows[0].kind).toBe('chart');
    expect(s.zOrder.length).toBe(3);
  });

  it('windows 가 배열이 아니면 기본 레이아웃으로 폴백한다', async () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ windows: 'foo', zOrder: [], groupSymbols: {} }));
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.length).toBe(3);
    expect(s.windows[0].kind).toBe('chart');
  });
});

describe('레거시 마이그레이션 하이드레이션(#713, PR-C)', () => {
  it('live.workspace.v1 부재 + 레거시 키 존재 → 마이그레이션 시드로 하이드레이션한다', async () => {
    localStorage.clear();
    // live.workspace.v1 는 없고, 레거시 단일 뷰 상태만 존재.
    localStorage.setItem(
      'live.page.v1',
      JSON.stringify({ candleTimeframe: 'D', activeInstrument: { kind: 'stock', code: '000660', label: 'SK하이닉스' }, activeCode: '000660' }),
    );
    localStorage.setItem(
      'live.layout.v1',
      JSON.stringify({
        rightCardOrder: ['brokers', 'orderbook'],
        // 나머지 3종은 숨김 → 순서 보존 + 숨김 제외를 함께 검증.
        rightCardHidden: { volumeDistribution: true, program: true, investor: true },
      }),
    );
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    const chart = s.windows.find((w) => w.kind === 'chart')!;
    expect(chart.chart?.timeframe).toBe('D'); // 레거시 봉 계승
    expect(s.groupSymbols[1]).toEqual({ code: '000660', name: 'SK하이닉스' });
    // 레거시 카드 순서 보존 → brokers(broker), orderbook(book); 나머지 숨김 → 제외
    const dataKinds = s.windows.filter((w) => w.kind !== 'chart').map((w) => w.kind);
    expect(dataKinds).toEqual(['broker', 'book']);
  });

  it('레거시 키도 없으면 공장 기본 레이아웃', async () => {
    localStorage.clear();
    vi.resetModules();
    const mod = await import('./workspace');
    const s = mod.useWorkspaceStore.getState();
    expect(s.windows.length).toBe(3); // defaultWindows
    expect(s.groupSymbols[1]).toBeUndefined();
  });
});
