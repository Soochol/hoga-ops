import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// dnd-kit passthrough — DndContext가 주입한 onDragStart/onDragEnd 캡처(WatchlistDrawer.drag.test 패턴).
// 폴더마다 DndContext가 있으나 핸들러는 모두 동일 onRowDragState(true/false)를 호출하므로 마지막 캡처로 충분.
const h = vi.hoisted(() => ({
  onDragStart: null as null | ((e?: unknown) => void),
  onDragEnd: null as null | ((e: unknown) => void),
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragStart, onDragEnd }: {
      children: React.ReactNode;
      onDragStart?: (e?: unknown) => void;
      onDragEnd?: (e: unknown) => void;
    }) => {
      h.onDragStart = onDragStart ?? null;
      h.onDragEnd = onDragEnd ?? null;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      setNodeRef: () => {}, listeners: {}, attributes: {},
      transform: null, transition: undefined, isDragging: false,
    }),
  };
});

// 비어있지 않은 실폴더 2개(f1 avg 낮음, f2 avg 높음) — 그룹 재정렬 관측 가능.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }, { id: 'f2', name: '이차전지', order: 1 }],
    entries: [
      { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 },
      { code: '373220', name: 'LG에너지', folder_id: 'f2', order: 0 },
    ],
  })),
}));
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: 1, change_won: 700 }],   // f1 avg +1
      ['373220', { code: '373220', price: 400000, change_pct: 5, change_won: 20000 }], // f2 avg +5
    ]),
    phase: 'open', dataUpdatedAt: 0,
  })),
}));
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: vi.fn(() => ({ data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } })),
}));
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}
// 보드에 렌더된 폴더 div(id=heatmap-folder-*)의 DOM 순서 = orderedGroups 순서. (스트립 칩엔 id 없음)
const folderOrder = () => Array.from(document.querySelectorAll('[id^="heatmap-folder-"]')).map((el) => el.id);

beforeEach(() => {
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  Element.prototype.scrollIntoView = vi.fn();
  h.onDragStart = null;
  h.onDragEnd = null;
});

it('G1: 행 드래그 active 동안 groupSort 변경에도 그룹 순서 동결, drag-end 후 재정렬', async () => {
  renderPage();
  await screen.findAllByText('반도체'); // 스트립 칩+헤더로 다수 → 렌더 대기
  expect(folderOrder()).toEqual(['heatmap-folder-f1', 'heatmap-folder-f2']); // manual=folder.order

  expect(h.onDragStart).toBeTruthy();
  act(() => { h.onDragStart!(); }); // 드래그 시작 → isRowDragging=true

  // 드래그 중 desc로 변경 — 평소면 [f2(+5), f1(+1)]가 되어야 하나 동결돼야 함
  act(() => { useHeatmapPrefsStore.getState().setGroupSort('desc'); });
  expect(folderOrder()).toEqual(['heatmap-folder-f1', 'heatmap-folder-f2']); // 동결(불변)

  // drag-end(over=null → 내부 reorder는 early-return, onRowDragState(false)만) → 최신 desc 적용
  act(() => { h.onDragEnd!({ active: { id: '005930' }, over: null }); });
  expect(folderOrder()).toEqual(['heatmap-folder-f2', 'heatmap-folder-f1']); // desc 재정렬
});
