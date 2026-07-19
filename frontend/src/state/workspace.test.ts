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
});
