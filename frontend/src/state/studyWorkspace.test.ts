import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 모듈 하이드레이션(시드)이 import 시점에 돌므로, 저장소를 세팅한 뒤 신선하게
 *  다시 불러온다 — workspace.tabScope 류의 격리 관례. */
async function importFresh() {
  vi.resetModules();
  return import('./studyWorkspace');
}

function storedWorkspace(): { schema_version: number; windows: { id: string; kind: string; rect: { x: number; y: number; w: number; h: number } }[]; zOrder: string[] } {
  return JSON.parse(localStorage.getItem('study.workspace.v1') ?? 'null');
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('시드 — study.layout.v1 → 기본 창 배치 (ADR-0123 PR-2)', () => {
  it('저장값이 없으면 차트 + 카드 4종을 기본 순서로 시드하고 즉시 persist 한다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const s = useStudyWorkspaceStore.getState();

    expect(s.windows.map((w) => w.kind)).toEqual(['chart', 'book', 'broker', 'vdist', 'program']);
    const chart = s.windows[0];
    expect(chart.rect).toEqual({ x: 0, y: 0, w: 0.72, h: 1 });
    // 데이터 창은 우측 열 등분 스택.
    const data = s.windows.slice(1);
    data.forEach((w, i) => {
      expect(w.rect.x).toBeCloseTo(0.72);
      expect(w.rect.w).toBeCloseTo(0.28);
      expect(w.rect.y).toBeCloseTo(i * 0.25);
      expect(w.rect.h).toBeCloseTo(0.25);
    });
    // 첫 포커스 = 차트(zOrder 마지막).
    expect(s.zOrder[s.zOrder.length - 1]).toBe(chart.id);
    // 시드 즉시 persist — 창 id 고정(재방문 재시드 없음).
    const stored = storedWorkspace();
    expect(stored.schema_version).toBe(1);
    expect(stored.windows.map((w) => w.id)).toEqual(s.windows.map((w) => w.id));
  });

  it('cardOrder 순서·cardHidden 숨김을 반영한다', async () => {
    localStorage.setItem('study.layout.v1', JSON.stringify({
      cardOrder: ['program', 'orderbook', 'brokers', 'volumeDistribution'],
      cardHidden: { brokers: true },
    }));
    const { useStudyWorkspaceStore } = await importFresh();
    const s = useStudyWorkspaceStore.getState();

    expect(s.windows.map((w) => w.kind)).toEqual(['chart', 'program', 'book', 'vdist']);
    s.windows.slice(1).forEach((w, i) => {
      expect(w.rect.y).toBeCloseTo(i * (1 / 3));
      expect(w.rect.h).toBeCloseTo(1 / 3);
    });
  });

  it('카드 전부 숨김이면 차트만 전폭으로 시드한다', async () => {
    localStorage.setItem('study.layout.v1', JSON.stringify({
      cardHidden: { orderbook: true, brokers: true, volumeDistribution: true, program: true },
    }));
    const { useStudyWorkspaceStore } = await importFresh();
    const s = useStudyWorkspaceStore.getState();
    expect(s.windows.map((w) => w.kind)).toEqual(['chart']);
    expect(s.windows[0].rect.w).toBe(1);
  });

  it('이미 시드된 워크스페이스는 layout 변경에도 재시드하지 않는다', async () => {
    const first = await importFresh();
    const ids = first.useStudyWorkspaceStore.getState().windows.map((w) => w.id);

    localStorage.setItem('study.layout.v1', JSON.stringify({
      cardHidden: { orderbook: true, brokers: true, volumeDistribution: true, program: true },
    }));
    const second = await importFresh();
    expect(second.useStudyWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(ids);
  });

  it('손상 저장값(유효 창 0)은 시드로 폴백한다', async () => {
    localStorage.setItem('study.workspace.v1', JSON.stringify({
      schema_version: 1,
      windows: [{ id: 'x', kind: 'nope', rect: { x: 0, y: 0, w: 2, h: 2 } }],
      zOrder: ['x'],
    }));
    const { useStudyWorkspaceStore } = await importFresh();
    expect(useStudyWorkspaceStore.getState().windows.map((w) => w.kind))
      .toEqual(['chart', 'book', 'broker', 'vdist', 'program']);
  });

  it('저장값에 차트가 없으면 차트 창을 주입한다(차트 1개 불변식)', async () => {
    localStorage.setItem('study.workspace.v1', JSON.stringify({
      schema_version: 1,
      windows: [{ id: 'b1', kind: 'book', rect: { x: 0.5, y: 0, w: 0.4, h: 0.5 } }],
      zOrder: ['b1'],
    }));
    const { useStudyWorkspaceStore } = await importFresh();
    const s = useStudyWorkspaceStore.getState();
    expect(s.windows.some((w) => w.kind === 'chart')).toBe(true);
    // 주입된 차트가 포커스(zOrder 마지막).
    const chart = s.windows.find((w) => w.kind === 'chart');
    expect(s.zOrder[s.zOrder.length - 1]).toBe(chart?.id);
  });
});

describe('액션', () => {
  it('addWindow — 데이터 창은 중복 허용, 추가 즉시 persist·포커스', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const before = store.getState().windows.length;

    const id1 = store.getState().addWindow('memo');
    const id2 = store.getState().addWindow('book');
    const s = store.getState();
    expect(s.windows.length).toBe(before + 2);
    expect(s.windows.filter((w) => w.kind === 'book').length).toBe(2);
    expect(s.zOrder[s.zOrder.length - 1]).toBe(id2);
    expect(storedWorkspace().windows.some((w) => w.id === id1)).toBe(true);
    // 비율 좌표 불변식.
    for (const w of s.windows) {
      expect(w.rect.x + w.rect.w).toBeLessThanOrEqual(1.0001);
      expect(w.rect.y + w.rect.h).toBeLessThanOrEqual(1.0001);
    }
  });

  it('addWindow(chart) — 차트 1개 고정: 기존 차트를 포커스하고 그 id 를 반환한다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const chartId = store.getState().windows.find((w) => w.kind === 'chart')?.id;
    store.getState().addWindow('memo'); // 포커스를 다른 창으로.

    const returned = store.getState().addWindow('chart');
    const s = store.getState();
    expect(returned).toBe(chartId);
    expect(s.windows.filter((w) => w.kind === 'chart').length).toBe(1);
    expect(s.zOrder[s.zOrder.length - 1]).toBe(chartId);
  });

  it('closeWindow — 데이터 창은 닫히고, 차트 창은 거부된다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const chartId = store.getState().windows.find((w) => w.kind === 'chart')!.id;
    const bookId = store.getState().windows.find((w) => w.kind === 'book')!.id;

    store.getState().closeWindow(bookId);
    expect(store.getState().windows.some((w) => w.id === bookId)).toBe(false);
    expect(storedWorkspace().windows.some((w) => w.id === bookId)).toBe(false);

    store.getState().closeWindow(chartId);
    expect(store.getState().windows.some((w) => w.id === chartId)).toBe(true);
  });

  it('focusWindow — zOrder 마지막으로 올린다(미존재 id 는 no-op)', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const first = store.getState().windows[1].id;

    store.getState().focusWindow(first);
    expect(store.getState().zOrder[store.getState().zOrder.length - 1]).toBe(first);

    const before = store.getState().zOrder;
    store.getState().focusWindow('missing');
    expect(store.getState().zOrder).toEqual(before);
  });

  it('setWindowRects — 비율 rect 만 반영하고 무효 rect 는 무시한다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const [a, b] = store.getState().windows;

    store.getState().setWindowRects([
      { id: a.id, rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
      { id: b.id, rect: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }, // x+w>1 — 무효
    ]);
    const s = store.getState();
    expect(s.windows.find((w) => w.id === a.id)?.rect).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(s.windows.find((w) => w.id === b.id)?.rect).toEqual(b.rect);
  });

  it('tidyAll — 차트 좌측·데이터 우측 열로 비율 커밋한다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    // 배치를 흐뜨린 뒤 tidy.
    const chart = store.getState().windows.find((w) => w.kind === 'chart')!;
    store.getState().setWindowRect(chart.id, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });

    store.getState().tidyAll({ w: 1200, h: 800 });
    const s = store.getState();
    const tidiedChart = s.windows.find((w) => w.kind === 'chart')!;
    expect(tidiedChart.rect.x).toBe(0);
    for (const w of s.windows) {
      expect(w.rect.x + w.rect.w).toBeLessThanOrEqual(1.0001);
      expect(w.rect.y + w.rect.h).toBeLessThanOrEqual(1.0001);
    }
    const data = s.windows.filter((w) => w.kind !== 'chart');
    expect(data.every((w) => w.rect.x > tidiedChart.rect.w - 0.01)).toBe(true);
  });

  it('스냅샷 왕복 — snapshot → 변형 → applySnapshot 으로 복원된다', async () => {
    const { useStudyWorkspaceStore, snapshotStudyWorkspace } = await importFresh();
    const store = useStudyWorkspaceStore;
    const snap = snapshotStudyWorkspace();

    store.getState().addWindow('memo');
    store.getState().setWindowRect(snap.windows[0].id, { x: 0.2, y: 0.2, w: 0.3, h: 0.3 });
    expect(store.getState().windows.length).toBe(snap.windows.length + 1);

    store.getState().applySnapshot(snap);
    const s = store.getState();
    expect(s.windows).toEqual(snap.windows);
    expect(s.zOrder).toEqual(snap.zOrder);
    expect(storedWorkspace().windows.length).toBe(snap.windows.length);
  });

  it('applySnapshot — 쓰레기 입력은 시드 폴백(차트 포함)으로 안전하다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    store.getState().applySnapshot({ windows: 'garbage' });
    const s = store.getState();
    expect(s.windows.length).toBeGreaterThan(0);
    expect(s.windows.some((w) => w.kind === 'chart')).toBe(true);
  });
});
