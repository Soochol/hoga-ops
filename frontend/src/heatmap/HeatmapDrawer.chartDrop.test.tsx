import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { HeatmapResponse } from '../api/heatmap';

/**
 * 히트맵 드로어 행을 **차트 창에 드롭**하는 경로.
 *
 * 이 드래그는 재정렬·그룹 이동과 dnd-kit 제스처 **하나를 공유**한다(관심종목과 같은 부류).
 * 그래서 이 파일이 못박는 것은 "차트 드롭이 되는가" 뿐 아니라 **"차트 드롭이 그룹 이동을
 * 먹지 않는가 / 그룹 이동이 차트 드롭에 새지 않는가"** 다 — 두 목적지가 한 드래그를 나눠
 * 갖는 구조라 경계가 곧 계약이다.
 *
 * **판정은 `over` 가 아니라 좌표다.** collision 억제가 차트 위에서 over 를 비우므로 over 로
 * 물으면 "아무 데도 안 놓음" 과 구별되지 않는다. 아래 테스트가 over 를 그대로 실어 보내면서
 * 좌표만 바꾸는 것이 그 축을 재기 위함이다.
 *
 * **못 보는 것**: 실제 포인터·충돌·자동스크롤(e2e 담당). 여기서는 dnd-kit 을 passthrough 로
 * 목킹해 주입된 핸들러를 직접 부르는 wiring contract 만 본다.
 */
const h = vi.hoisted(() => ({
  onDragStart: null as null | ((e: unknown) => void),
  onDragMove: null as null | ((e: unknown) => void),
  onDragEnd: null as null | ((e: unknown) => void),
  onDragCancel: null as null | (() => void),
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragStart, onDragMove, onDragEnd, onDragCancel }: {
      children: ReactNode;
      onDragStart: (e: unknown) => void;
      onDragMove: (e: unknown) => void;
      onDragEnd: (e: unknown) => void;
      onDragCancel: () => void;
    }) => {
      h.onDragStart = onDragStart;
      h.onDragMove = onDragMove;
      h.onDragEnd = onDragEnd;
      h.onDragCancel = onDragCancel;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
    useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, attributes: {}, transform: null, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
    useSortable: () => ({
      setNodeRef: () => {}, setActivatorNodeRef: () => {},
      listeners: {}, attributes: {}, transform: null, transition: undefined, isDragging: false,
    }),
  };
});

const api = vi.hoisted(() => ({
  getHeatmap: vi.fn<() => Promise<HeatmapResponse>>(),
  addToHeatmapFolder: vi.fn(() => Promise.resolve({ code: '', name: '', folder_id: 'f1', order: 0 })),
  removeFromHeatmap: vi.fn(() => Promise.resolve()),
  removeFromHeatmapFolder: vi.fn(() => Promise.resolve()),
  createHeatmapFolder: vi.fn(() => Promise.resolve({ id: 'fNew', name: '', order: 9 })),
  renameHeatmapFolder: vi.fn(() => Promise.resolve()),
  deleteHeatmapFolder: vi.fn(() => Promise.resolve()),
  reorderHeatmapFolders: vi.fn(() => Promise.resolve()),
  moveHeatmapEntries: vi.fn(() => Promise.resolve()),
  reorderHeatmapEntries: vi.fn(() => Promise.resolve()),
  removeHeatmapEntries: vi.fn(() => Promise.resolve()),
}));
vi.mock('../api/heatmap', () => api);
vi.mock('../api/indexSectorRankings', () => ({ INDEX_SECTOR_RANKINGS_KEY: ['index-sector-rankings'] }));

const jump = vi.hoisted(() => vi.fn());
vi.mock('../live/useJumpToLive', () => ({ useJumpToLive: () => jump }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { activeCode: string | null }) => unknown) => sel({ activeCode: null }),
}));
vi.mock('../api/liveQuotes', () => ({ useQuoteByCode: () => new Map(), isStaleLiveQuote: () => false }));
vi.mock('../capture/SymbolSearch', () => ({ SymbolSearch: () => <div /> }));

import { HeatmapDrawer } from './HeatmapDrawer';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useEntryDragStore } from '../state/entryDrag';

function makeData(): HeatmapResponse {
  return {
    capture_markers: {},
    next_run_at_ms: 0,
    folders: [
      { id: 'f1', name: '2차전지', order: 0 },
      { id: 'f2', name: '반도체', order: 1 },
    ],
    entries: [
      { code: '000001', name: '에코프로', folder_id: 'f1', order: 0 },
      { code: '000003', name: '삼성전자', folder_id: 'f2', order: 0 },
    ],
  };
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/**
 * 드래그 이벤트. `over` 는 **항상 다른 그룹의 드롭존**으로 채운다 — 좌표만으로 분기가
 * 갈리는지 보기 위해서다(over 가 이동을 가리키는데도 좌표가 차트면 이동이 아니라 드롭이
 * 되어야 한다). `dropPoint` 는 activatorEvent 좌표 + delta 로 최종 좌표를 복원한다.
 */
function dragTo(x: number, y: number) {
  return {
    active: {
      id: 'f1:000001',
      data: { current: { type: 'entry', code: '000001', name: '에코프로', folderId: 'f1' } },
    },
    over: { id: 'folder:f2', data: { current: { type: 'entry-target', folderId: 'f2' } } },
    activatorEvent: { clientX: 0, clientY: 0 },
    delta: { x, y },
  };
}

/** 캔버스 등록 흉내 — x<100 이 "차트 위". 실제 등록자는 WorkspaceCanvas 다. */
const CHART_HIT = (x: number) => x < 100;

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockClear());
  jump.mockClear();
  h.onDragStart = h.onDragMove = h.onDragEnd = null;
  h.onDragCancel = null;
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  useEntryDragStore.setState({
    draggingCode: null, overChart: false, dragPoint: null,
    targets: {}, hitTestChart: null, chartDropResolver: null,
  });
  api.getHeatmap.mockResolvedValue(makeData());
});
afterEach(() => cleanup());

async function mounted() {
  wrap(<HeatmapDrawer />);
  await screen.findByTestId('heatmap-drawer-row-000001');
}

describe('히트맵 드로어 → 차트 창 드롭', () => {
  it('창 위에 놓으면 그 창 리졸버가 종목을 받고, 그룹 이동은 일어나지 않는다', async () => {
    // over 는 f2 이동을 가리키지만 좌표가 차트 위다 — 좌표가 이긴다.
    await mounted();
    useEntryDragStore.getState().registerChartTarget(CHART_HIT);
    const resolver = vi.fn(() => true);
    useEntryDragStore.getState().registerChartDropResolver(resolver);

    h.onDragEnd!(dragTo(10, 10));

    expect(resolver).toHaveBeenCalledWith({ x: 10, y: 10 }, { code: '000001', name: '에코프로' });
    await Promise.resolve();
    expect(api.moveHeatmapEntries).not.toHaveBeenCalled();
  });

  it('창 밖(캔버스 여백)이면 클릭과 같은 목적지 규칙으로 폴백한다', async () => {
    // 리졸버가 false = 좌표 아래 창 없음 → onPick(useJumpToLive) 이 받는다.
    await mounted();
    useEntryDragStore.getState().registerChartTarget(CHART_HIT);
    useEntryDragStore.getState().registerChartDropResolver(() => false);

    h.onDragEnd!(dragTo(10, 10));

    expect(jump).toHaveBeenCalledWith('000001', '에코프로');
    expect(api.moveHeatmapEntries).not.toHaveBeenCalled();
  });

  it('차트 밖에 놓으면 종전대로 그룹 이동 — 차트 드롭이 이동을 먹지 않는다', async () => {
    await mounted();
    useEntryDragStore.getState().registerChartTarget(CHART_HIT);
    useEntryDragStore.getState().registerChartDropResolver(vi.fn(() => true));

    h.onDragEnd!(dragTo(500, 10));

    await waitFor(() => expect(api.moveHeatmapEntries).toHaveBeenCalledWith(['000001'], 'f1', 'f2'));
    expect(jump).not.toHaveBeenCalled();
  });

  it('캔버스 미등록(/heatmap 전체 페이지 등)이면 좌표와 무관하게 그룹 이동', async () => {
    // 등록 의존을 못박는다 — 캔버스가 없는 표면에서 이 배선은 완전히 무해해야 한다.
    await mounted();

    h.onDragEnd!(dragTo(10, 10));

    await waitFor(() => expect(api.moveHeatmapEntries).toHaveBeenCalledWith(['000001'], 'f1', 'f2'));
  });
});

describe('드래그 수명주기 — 캔버스 어포던스', () => {
  it('시작하면 draggingCode 가 서고, 끝나면 걷힌다', async () => {
    // 걷지 않으면 드래그가 끝난 뒤에도 캔버스 드롭 오버레이가 화면에 남는다.
    await mounted();
    useEntryDragStore.getState().registerChartTarget(CHART_HIT);

    h.onDragStart!({ ...dragTo(0, 0), activatorEvent: { ctrlKey: false, clientX: 0, clientY: 0 } });
    expect(useEntryDragStore.getState().draggingCode).toBe('000001');

    h.onDragEnd!(dragTo(500, 10));
    expect(useEntryDragStore.getState().draggingCode).toBeNull();
  });

  it('취소(ESC)도 걷는다', async () => {
    await mounted();
    h.onDragStart!({ ...dragTo(0, 0), activatorEvent: { ctrlKey: false, clientX: 0, clientY: 0 } });

    h.onDragCancel!();

    expect(useEntryDragStore.getState().draggingCode).toBeNull();
  });

  it('그룹 헤더(folder) 드래그는 어포던스를 켜지 않는다 — 차트에 놓을 것이 없다', async () => {
    await mounted();

    h.onDragStart!({
      active: { id: 'f1', data: { current: { type: 'folder' } } },
      activatorEvent: { clientX: 0, clientY: 0 },
    });

    expect(useEntryDragStore.getState().draggingCode).toBeNull();
  });

  it('onDragMove 가 좌표를 발행한다 — 창별 드롭 어포던스의 입력', async () => {
    await mounted();
    useEntryDragStore.getState().registerChartTarget(CHART_HIT);
    h.onDragStart!({ ...dragTo(0, 0), activatorEvent: { ctrlKey: false, clientX: 0, clientY: 0 } });

    h.onDragMove!(dragTo(10, 20));

    // rAF 스로틀 — 프레임 경계에서 한 번만 발행한다(useDragPointPublisher).
    await waitFor(() => {
      expect(useEntryDragStore.getState().dragPoint).toEqual({ x: 10, y: 20 });
      expect(useEntryDragStore.getState().overChart).toBe(true);
    });
  });
});
