import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOK_WINDOW_DEFAULT_W } from '../live/workspace/bookPanelMetrics';
import { NARROW_CANVAS_W } from '../workspace/referenceCanvas';

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
    // 10호가(십자 배치)가 보이면 우측 열이 BookPanel 폭 계약을 넘도록 넓어진다.
    // 0.58 = 하한 560→448 축소분을 차트에 넘긴 값(2026-08-16). 상한은 0.5966.
    expect(chart.rect).toEqual({ x: 0, y: 0, w: 0.58, h: 1 });
    // 데이터 창은 우측 열 스택 — book 은 3배 높이 가중(3/6), 나머지 1/6.
    const data = s.windows.slice(1);
    const expectedHeights = [0.5, 1 / 6, 1 / 6, 1 / 6];
    let expectedY = 0;
    data.forEach((w, i) => {
      expect(w.rect.x).toBeCloseTo(0.58);
      expect(w.rect.w).toBeCloseTo(0.42);
      expect(w.rect.y).toBeCloseTo(expectedY);
      expect(w.rect.h).toBeCloseTo(expectedHeights[i]);
      expectedY += expectedHeights[i];
    });
    // 좁은 쪽 실측 캔버스에서도 BookPanel 폭 계약을 만족해야 한다 — 기준은 패널 하한이
    // 아니라 창 기본 폭(스크롤바 여유 포함, `bookPanelMetrics`). 캔버스 폭은 `/live` 와
    // **같은 상수**를 쓴다: 2026-08-17 여백 통일로 두 페이지 캔버스가 같아졌고, 손으로
    // 복제됐던 1190 은 탭 스트립이 있던 시절 값이라 이미 실제(1208)보다 좁았다.
    expect(data[0].rect.w * NARROW_CANVAS_W).toBeGreaterThanOrEqual(BOOK_WINDOW_DEFAULT_W);
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
    // 가중: program 1 + book 3 + vdist 1 = 5.
    const expectedHeights = [0.2, 0.6, 0.2];
    let expectedY = 0;
    s.windows.slice(1).forEach((w, i) => {
      expect(w.rect.y).toBeCloseTo(expectedY);
      expect(w.rect.h).toBeCloseTo(expectedHeights[i]);
      expectedY += expectedHeights[i];
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

  it('addWindow(chart) — 차트 창을 새로 만든다 (#801: 1개 고정 해제)', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const chartId = store.getState().windows.find((w) => w.kind === 'chart')!.id;

    const returned = store.getState().addWindow('chart');
    const s = store.getState();
    expect(returned).not.toBe(chartId);
    expect(s.windows.filter((w) => w.kind === 'chart').length).toBe(2);
    expect(s.zOrder[s.zOrder.length - 1]).toBe(returned);
  });

  it('새 차트 창은 포커스된 차트의 봉을 복제한다 — "복제 후 한쪽만 일봉" 흐름', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const store = useStudyWorkspaceStore;
    const chartId = store.getState().windows.find((w) => w.kind === 'chart')!.id;
    store.getState().setChartTimeframe(chartId, 'D');

    const secondId = store.getState().addWindow('chart');
    const second = store.getState().windows.find((w) => w.id === secondId);
    expect(second?.chart?.timeframe).toBe('D');
    // 값이지 상태다 — 참조를 나눠 가지면 한쪽 봉 전환이 다른 창에 샌다.
    const first = store.getState().windows.find((w) => w.id === chartId);
    expect(second?.chart).not.toBe(first?.chart);
    store.getState().setChartTimeframe(secondId, '5m');
    expect(store.getState().windows.find((w) => w.id === chartId)?.chart?.timeframe).toBe('D');
  });

  it('차트 창은 둘 이상일 때만 닫힌다 — 마지막 하나는 거부', async () => {
    const { useStudyWorkspaceStore, canCloseStudyWindow } = await importFresh();
    const store = useStudyWorkspaceStore;
    const chartId = store.getState().windows.find((w) => w.kind === 'chart')!.id;
    expect(canCloseStudyWindow(store.getState().windows, chartId)).toBe(false);

    const secondId = store.getState().addWindow('chart');
    expect(canCloseStudyWindow(store.getState().windows, chartId)).toBe(true);
    store.getState().closeWindow(secondId);
    expect(store.getState().windows.filter((w) => w.kind === 'chart').length).toBe(1);
    // 다시 하나 — 어포던스도 술어도 닫힘을 막는다.
    expect(canCloseStudyWindow(store.getState().windows, chartId)).toBe(false);
    store.getState().closeWindow(chartId);
    expect(store.getState().windows.filter((w) => w.kind === 'chart').length).toBe(1);
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
      // 화면 오른쪽으로 걸친 배치 — ADR-0127 이후 유효하다.
      { id: a.id, rect: { x: 0.9, y: 0.1, w: 0.5, h: 0.5 } },
      { id: b.id, rect: { x: 748, y: 16, w: 680, h: 560 } }, // 레거시 px — 무효
    ]);
    const s = store.getState();
    expect(s.windows.find((w) => w.id === a.id)?.rect).toEqual({ x: 0.9, y: 0.1, w: 0.5, h: 0.5 });
    expect(s.windows.find((w) => w.id === b.id)?.rect).toEqual(b.rect);
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

describe('차트 창 설정 신설 (#906)', () => {
  it('설정이 없던 기존 저장분에 시드를 붙이되 배치는 그대로 둔다', async () => {
    localStorage.setItem('study.lastMinuteTimeframe.v1', JSON.stringify({ lastMinuteTimeframe: '15m' }));
    // 사용자가 직접 옮겨둔 배치 — 설정 신설이 이걸 초기화하면 과잉 무효화다(#577).
    const saved = {
      schema_version: 1,
      windows: [
        { id: 'c1', kind: 'chart', rect: { x: 0.1, y: 0.2, w: 0.6, h: 0.7 } },
        { id: 'b1', kind: 'book', rect: { x: 0.7, y: 0, w: 0.3, h: 1 } },
      ],
      zOrder: ['c1', 'b1'],
    };
    localStorage.setItem('study.workspace.v1', JSON.stringify(saved));

    const { useStudyWorkspaceStore } = await importFresh();
    const s = useStudyWorkspaceStore.getState();

    // 배치·id·zOrder 전부 보존.
    expect(s.windows.map((w) => w.id)).toEqual(['c1', 'b1']);
    expect(s.windows[0].rect).toEqual({ x: 0.1, y: 0.2, w: 0.6, h: 0.7 });
    expect(s.windows[1].rect).toEqual({ x: 0.7, y: 0, w: 0.3, h: 1 });
    expect(s.zOrder).toEqual(['c1', 'b1']);

    // 차트 창에만 설정이 붙는다. 지표는 창이 소유하지 않으므로 시드 대상이 아니다.
    expect(s.windows[1].chart).toBeUndefined();
    const chart = s.windows[0].chart!;
    expect(chart && 'indicators' in chart).toBe(false);
    // 봉은 탭이 시드하기 전까지 `/study` 의 마지막 분봉을 쓴다('1m' 아님).
    expect(chart.timeframe).toBe('15m');
    expect(chart.lastMinuteTimeframe).toBe('15m');
  });

  it('시드는 즉시 persist 되어 재방문에 전역 키를 다시 읽지 않는다', async () => {
    localStorage.setItem('study.lastMinuteTimeframe.v1', JSON.stringify({ lastMinuteTimeframe: '15m' }));
    localStorage.setItem('study.workspace.v1', JSON.stringify({
      schema_version: 1,
      windows: [{ id: 'c1', kind: 'chart', rect: { x: 0, y: 0, w: 1, h: 1 } }],
      zOrder: ['c1'],
    }));

    const first = await importFresh();
    first.useStudyWorkspaceStore.getState().setChartTimeframe('c1', '10m');

    // 전역 키가 바뀌어도 창이 이미 자기 봉을 갖고 있으므로 덮이지 않는다.
    localStorage.setItem('study.lastMinuteTimeframe.v1', JSON.stringify({ lastMinuteTimeframe: '30m' }));
    const second = await importFresh();
    expect(second.useStudyWorkspaceStore.getState().windows[0].chart!.timeframe).toBe('10m');
  });

  it('전역 키가 비어 있으면 공장 기본값으로 시작한다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    const chart = useStudyWorkspaceStore.getState().windows[0].chart!;
    // 분봉 기본값은 `/study` 의 '3m'(전역 키 부재 폴백).
    expect(chart.timeframe).toBe('3m');
  });

  it('주입된 차트 창·새 시드 배치에도 설정이 붙는다', async () => {
    localStorage.setItem('study.workspace.v1', JSON.stringify({
      schema_version: 1,
      windows: [{ id: 'b1', kind: 'book', rect: { x: 0.5, y: 0, w: 0.4, h: 0.5 } }],
      zOrder: ['b1'],
    }));
    const { useStudyWorkspaceStore } = await importFresh();
    const chart = useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart');
    expect(chart?.chart).toBeDefined();
  });

  it('저장된 설정은 관대 파싱 — 무효 필드만 기본값으로 채우고 나머지는 살린다', async () => {
    localStorage.setItem('study.workspace.v1', JSON.stringify({
      schema_version: 1,
      windows: [{
        id: 'c1',
        kind: 'chart',
        rect: { x: 0, y: 0, w: 1, h: 1 },
        chart: {
          timeframe: 'nope',
          lastMinuteTimeframe: 'D', // 분봉이 아니다 — 드롭 대상
          indicators: { paneOrder: [], paneStretch: {}, byTimeframe: { minute: { ratioEnabled: true } } },
        },
      }],
      zOrder: ['c1'],
    }));
    const { useStudyWorkspaceStore } = await importFresh();
    const chart = useStudyWorkspaceStore.getState().windows[0].chart!;
    expect(chart.timeframe).toBe('3m');
    expect(chart.lastMinuteTimeframe).toBe('3m'); // 무효값 → 현재 분봉에서 파생
    // 구 스냅샷의 창별 지표 사본은 읽지 않는다(전역으로 1회 승격된 뒤 소멸).
    expect(chart && 'indicators' in chart).toBe(false);
  });
});

describe('차트 창 설정 쓰기 경로 (#906 — windowView 핸들 계약)', () => {
  async function freshChart() {
    const mod = await importFresh();
    const id = mod.useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
    return { store: mod.useStudyWorkspaceStore, id };
  }

  it('setChartTimeframe — 봉 변경이 persist 된다', async () => {
    const { store, id } = await freshChart();
    store.getState().setChartTimeframe(id, '10m');
    const saved = (storedWorkspace().windows as Array<Record<string, unknown>>)
      .find((w) => w.id === id);
    expect(saved).toHaveProperty('chart');
    expect((saved!.chart as { timeframe: string }).timeframe).toBe('10m');
  });

  it('setChartTimeframe — 분봉이면 lastMinuteTimeframe 도 따라가고 백필을 리셋한다', async () => {
    const { store, id } = await freshChart();
    store.getState().extendChartHistoricalRange(id, '2026-01-02');
    store.getState().setChartTimeframe(id, '10m');
    expect(store.getState().windows.find((w) => w.id === id)!.chart!.lastMinuteTimeframe).toBe('10m');
    expect(store.getState().chartRuntime[id].historicalFromDate).toBeNull();

    // 분봉을 떠날 때 그 pan 창을 기억한다.
    store.getState().extendChartHistoricalRange(id, '2026-01-03');
    store.getState().setChartTimeframe(id, 'D');
    const chart = store.getState().windows.find((w) => w.id === id)!.chart!;
    expect(chart.timeframe).toBe('D');
    expect(chart.lastMinuteTimeframe).toBe('10m'); // D 로 덮이지 않는다
    expect(store.getState().chartRuntime[id].lastMinuteHistoricalFromDate).toBe('2026-01-03');
  });

  it('차트 창이 아닌 id 는 조용히 no-op — 데이터 창에 chart 가 생기지 않는다', async () => {
    const { store } = await freshChart();
    const bookId = store.getState().windows.find((w) => w.kind === 'book')!.id;
    store.getState().setChartTimeframe(bookId, 'D');
    expect(store.getState().windows.find((w) => w.id === bookId)!.chart).toBeUndefined();
  });

  it('extendChartHistoricalRange — 단조 감소 가드(뒷 날짜는 무시)', async () => {
    const { store, id } = await freshChart();
    store.getState().extendChartHistoricalRange(id, '2026-01-05');
    store.getState().extendChartHistoricalRange(id, '2026-01-09'); // 더 최근 → 무시
    expect(store.getState().chartRuntime[id].historicalFromDate).toBe('2026-01-05');

    store.getState().extendChartHistoricalRange(id, '2026-01-01'); // 더 과거 → 확장
    expect(store.getState().chartRuntime[id].historicalFromDate).toBe('2026-01-01');

    store.getState().resetChartHistoricalRange(id);
    expect(store.getState().chartRuntime[id]).toBeUndefined();
  });

  it('chartRuntime 은 비영속 — 저장 블롭에 실리지 않는다', async () => {
    const { store, id } = await freshChart();
    store.getState().extendChartHistoricalRange(id, '2026-01-05');
    expect(storedWorkspace()).not.toHaveProperty('chartRuntime');
  });
});

/** 탭 격리 — /live 와 같은 계약(state/workspace.ts 스코프 주석). `persistFromState` 가
 *  스냅샷 전체를 쓰므로 공유 키 하나를 두 탭이 나눠 쓰면 오래된 탭의 조작 하나가
 *  다른 탭의 배치를 통째로 되돌린다. 자기 탭 저장소를 authoritative 로 두어 끊는다. */
describe('탭 격리 (study.workspace.v1)', () => {
  /** 창 1개짜리 raw 스냅샷 — 어느 저장소에 심었는지 구분하려고 id 를 달리 준다.
   *  `chart` 설정을 채워 둔다: 없으면 `needsChartConfigSeed`(#906) 가 하이드레이션
   *  중 설정을 붙이고 즉시 persist 하므로, "열기만 해서는 안 쓴다" 를 볼 수 없다. */
  function seed(store: Storage, windowId: string) {
    store.setItem(
      'study.workspace.v1',
      JSON.stringify({
        schema_version: 1,
        windows: [{
          id: windowId,
          kind: 'chart',
          rect: { x: 0, y: 0, w: 0.7, h: 1 },
          chart: {
            timeframe: '1m',
            indicators: { paneOrder: [], paneStretch: {}, byTimeframe: {} },
          },
        }],
        zOrder: [windowId],
      }),
    );
  }

  it('변경은 자기 탭(session)과 공유 시드(local)에 함께 기록된다', async () => {
    const { useStudyWorkspaceStore } = await importFresh();
    useStudyWorkspaceStore.getState().addWindow('memo');

    const session = JSON.parse(sessionStorage.getItem('study.workspace.v1') ?? 'null');
    const local = JSON.parse(localStorage.getItem('study.workspace.v1') ?? 'null');
    expect(session.windows.some((w: { kind: string }) => w.kind === 'memo')).toBe(true);
    // 공유 키는 "새 탭의 시드" — 열린 탭은 읽지 않으므로 갱신해도 경합이 아니다.
    expect(local.windows.some((w: { kind: string }) => w.kind === 'memo')).toBe(true);
  });

  it('회귀 핵심: 다른 탭이 공유 시드를 덮어써도 이미 열린 탭은 밟히지 않는다', async () => {
    seed(sessionStorage, 'mine');
    seed(localStorage, 'theirs');

    const { useStudyWorkspaceStore } = await importFresh();

    expect(useStudyWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(['mine']);
  });

  it('자기 저장소가 비어 있으면 공유 시드를 물려받고, 열기만 해서는 쓰지 않는다', async () => {
    seed(localStorage, 'theirs');

    const { useStudyWorkspaceStore } = await importFresh();

    expect(useStudyWorkspaceStore.getState().windows.map((w) => w.id)).toEqual(['theirs']);
    // 시드는 읽기 전용 — 하이드레이션만으로 탭 저장소가 생기지 않는다(유효 창이
    // 있으므로 재시드 persist 경로를 타지 않는다).
    expect(sessionStorage.getItem('study.workspace.v1')).toBeNull();
  });
});

/** 프리셋이 이 스냅샷을 저장본으로 쓴다 — 스토어 내부 참조를 물고 있으면 저장 뒤의
 *  조작이 이미 저장한 프리셋을 소급 오염시킨다. 왕복 테스트는 rect 교체만 보므로
 *  참조 공유가 가장 위험한 chart 설정을 따로 못 박는다. */
describe('snapshotStudyWorkspace — 깊은 복사(프리셋 저장본 오염 방지)', () => {
  it('스냅샷 후 차트 설정을 바꿔도 스냅샷은 변하지 않는다', async () => {
    const { useStudyWorkspaceStore, snapshotStudyWorkspace } = await importFresh();
    const store = useStudyWorkspaceStore;
    const chartId = store.getState().windows.find((w) => w.kind === 'chart')!.id;

    const snap = snapshotStudyWorkspace();
    const before = snap.windows.find((w) => w.id === chartId)!.chart!.timeframe;

    store.getState().setChartTimeframe(chartId, before === 'D' ? '5m' : 'D');
    store.getState().setWindowRect(chartId, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });

    const after = snap.windows.find((w) => w.id === chartId)!;
    expect(after.chart!.timeframe).toBe(before);
    expect(after.rect).not.toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  });
});

