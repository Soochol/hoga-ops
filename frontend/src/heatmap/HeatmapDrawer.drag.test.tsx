import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { HeatmapResponse } from '../api/heatmap';

// dnd-kit 을 passthrough 로 목킹해 주입된 onDragEnd 를 캡처하고, useDraggable/useDroppable/
// useSortable 은 no-op 으로 둔다(실제 포인터/충돌은 e2e 담당 — wiring contract 만 검증).
const h = vi.hoisted(() => ({
  onDragEnd: null as null | ((e: unknown) => void),
  onDragStart: null as null | ((e: unknown) => void),
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd, onDragStart }: {
      children: ReactNode;
      onDragEnd: (e: unknown) => void;
      onDragStart: (e: unknown) => void;
    }) => {
      h.onDragEnd = onDragEnd;
      h.onDragStart = onDragStart;
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
vi.mock('../live/useJumpToLive', () => ({ useJumpToLive: () => vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { activeCode: string | null }) => unknown) => sel({ activeCode: null }),
}));
vi.mock('../api/liveQuotes', () => ({ useQuoteByCode: () => new Map(), isStaleLiveQuote: () => false }));
vi.mock('../capture/SymbolSearch', () => ({ SymbolSearch: () => <div /> }));

import { HeatmapDrawer } from './HeatmapDrawer';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';

function makeData(): HeatmapResponse {
  return {
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

// onDragEnd 이벤트 헬퍼 — 종목을 다른 그룹 드롭존(entry-target)에 드롭(=이동).
const entryDrag = (code: string, from: string, to: string, name = '에코프로') => ({
  active: { id: `${from}:${code}`, data: { current: { type: 'entry', code, name, folderId: from } } },
  over: { id: `folder:${to}`, data: { current: { type: 'entry-target', folderId: to } } },
});
// 같은 그룹 형제 행(entry) 위에 드롭(=그룹 내 재정렬). over 는 행 code + 그 행의 folderId.
const entryReorder = (code: string, folderId: string, overCode: string) => ({
  active: { id: code, data: { current: { type: 'entry', code, folderId } } },
  over: { id: overCode, data: { current: { type: 'entry', code: overCode, folderId } } },
});

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockClear());
  h.onDragEnd = null;
  h.onDragStart = null;
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  api.getHeatmap.mockResolvedValue(makeData());
});
afterEach(() => cleanup());

describe('HeatmapDrawer 행 드래그 이동 wiring', () => {
  // from(출발 그룹)이 함께 실려야 한다 — 같은 종목이 여러 그룹에 등록될 수 있어
  // 코드만으로는 서버가 어느 등록을 옮길지 정할 수 없다.
  it('종목을 다른 그룹 드롭존에 드롭 → moveHeatmapEntries([code], from, to)', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    h.onDragEnd!(entryDrag('000001', 'f1', 'f2'));
    await waitFor(() => expect(api.moveHeatmapEntries).toHaveBeenCalledWith(['000001'], 'f1', 'f2'));
  });

  // Ctrl+드래그 = 복제. 서버 커맨드는 일반 추가(addToHeatmapFolder) — 다중 그룹 등록이
  // 허용된 뒤로 "그 그룹에 추가"가 곧 복제이고, 출발 그룹 등록은 손대지 않는다.
  it('Ctrl 을 누른 채 다른 그룹에 드롭 → addToHeatmapFolder (이동 아님)', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    const ev = entryDrag('000001', 'f1', 'f2');
    h.onDragStart!({ active: ev.active, activatorEvent: { ctrlKey: true } });
    h.onDragEnd!(ev);
    await waitFor(() => expect(api.addToHeatmapFolder).toHaveBeenCalledWith('000001', 'f2'));
    expect(api.moveHeatmapEntries).not.toHaveBeenCalled();
  });

  it('Ctrl 없이 드롭하면 그대로 이동 (복제 경로가 기본을 바꾸지 않는다)', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    const ev = entryDrag('000001', 'f1', 'f2');
    h.onDragStart!({ active: ev.active, activatorEvent: { ctrlKey: false } });
    h.onDragEnd!(ev);
    await waitFor(() => expect(api.moveHeatmapEntries).toHaveBeenCalledWith(['000001'], 'f1', 'f2'));
    expect(api.addToHeatmapFolder).not.toHaveBeenCalled();
  });

  it('같은 그룹에 드롭 → no-op (mutate 미호출)', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    h.onDragEnd!(entryDrag('000001', 'f1', 'f1'));
    // 마이크로태스크 후에도 호출 없음
    await Promise.resolve();
    expect(api.moveHeatmapEntries).not.toHaveBeenCalled();
  });

  it('같은 그룹 형제 행 위에 드롭 → reorderHeatmapEntries(folderId, 재배열된 codes)', async () => {
    // manual 정렬(beforeEach) + 한 그룹에 종목 2개 → 그룹 내 재정렬 활성.
    api.getHeatmap.mockResolvedValue({
      folders: [{ id: 'f1', name: '2차전지', order: 0 }],
      entries: [
        { code: '000001', name: '에코프로', folder_id: 'f1', order: 0 },
        { code: '000002', name: '엘앤에프', folder_id: 'f1', order: 1 },
      ],
    });
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    h.onDragEnd!(entryReorder('000001', 'f1', '000002'));
    await waitFor(() =>
      expect(api.reorderHeatmapEntries).toHaveBeenCalledWith('f1', ['000002', '000001']));
    expect(api.moveHeatmapEntries).not.toHaveBeenCalled();
  });

  it('desc(라이브) 정렬 모드에선 그룹 내 재정렬 비활성 (형제 위 드롭도 no-op)', async () => {
    useHeatmapPrefsStore.setState({ sortMode: 'desc', groupSort: 'manual' });
    api.getHeatmap.mockResolvedValue({
      folders: [{ id: 'f1', name: '2차전지', order: 0 }],
      entries: [
        { code: '000001', name: '에코프로', folder_id: 'f1', order: 0 },
        { code: '000002', name: '엘앤에프', folder_id: 'f1', order: 1 },
      ],
    });
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    h.onDragEnd!(entryReorder('000001', 'f1', '000002'));
    await Promise.resolve();
    expect(api.reorderHeatmapEntries).not.toHaveBeenCalled();
  });

  it('그룹 헤더(folder) 드래그는 기존대로 reorderHeatmapFolders (행 이동과 분리)', async () => {
    wrap(<HeatmapDrawer />);
    await screen.findByTestId('heatmap-drawer-row-000001');
    h.onDragEnd!({
      active: { id: 'f2', data: { current: { type: 'folder' } } },
      over: { id: 'f1', data: { current: { type: 'folder' } } },
    });
    await waitFor(() => expect(api.reorderHeatmapFolders).toHaveBeenCalled());
    expect(api.moveHeatmapEntries).not.toHaveBeenCalled();
  });
});
