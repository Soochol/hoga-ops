import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// dnd-kit passthrough — DndContext가 주입한 onDragStart/onDragEnd 캡처(WatchlistDrawer.drag.test 패턴).
// DndContext는 보드에 하나뿐이다(그룹 간 드래그를 위해 폴더별 컨텍스트를 걷어냈다).
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
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));
// 단일 뷰 모델(ADR-0113): liveNavigate를 모킹해 jump 경로를 차단한다.
vi.mock('../live/liveNavigate', () => ({
  activateLiveCode: vi.fn(),
  activateLiveInstrument: vi.fn(),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useEntryDragStore } from '../state/entryDrag';
import { getHeatmap } from '../api/heatmap';
import { useLiveQuoteOverlay } from '../api/liveQuotes';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}
// 보드에 렌더된 폴더 div(id=heatmap-folder-*)의 DOM 순서 = orderedGroups 순서.
const folderOrder = () => Array.from(document.querySelectorAll('[id^="heatmap-folder-"]')).map((el) => el.id);

beforeEach(() => {
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  Element.prototype.scrollIntoView = vi.fn();
  h.onDragStart = null;
  h.onDragEnd = null;
});

it('G1: 행 드래그 active 동안 groupSort 변경에도 그룹 순서 동결, drag-end 후 재정렬', async () => {
  renderPage();
  await screen.findByText('반도체'); // 그룹 헤더 렌더 대기
  expect(folderOrder()).toEqual(['heatmap-folder-f1', 'heatmap-folder-f2']); // manual=folder.order

  expect(h.onDragStart).toBeTruthy();
  // 실제 DragStartEvent 는 activatorEvent(Ctrl 여부 판정용)를 항상 싣는다 — 그 모양대로 준다.
  act(() => { h.onDragStart!({ active: { id: 'f1:005930' }, activatorEvent: { ctrlKey: false } }); });

  // 드래그 중 desc로 변경 — 평소면 [f2(+5), f1(+1)]가 되어야 하나 동결돼야 함
  act(() => { useHeatmapPrefsStore.getState().setGroupSort('desc'); });
  expect(folderOrder()).toEqual(['heatmap-folder-f1', 'heatmap-folder-f2']); // 동결(불변)

  // drag-end(over=null → 내부 reorder는 early-return, onRowDragState(false)만) → 최신 desc 적용
  act(() => { h.onDragEnd!({ active: { id: '005930' }, over: null }); });
  expect(folderOrder()).toEqual(['heatmap-folder-f2', 'heatmap-folder-f1']); // desc 재정렬
});

it('패널 드래그 동안 시세가 바뀌어도 그룹·행 순서를 유지하고 종료 후 최신 순서를 적용한다', async () => {
  vi.mocked(getHeatmap).mockResolvedValueOnce({
    folders: [{ id: 'f1', name: '반도체', order: 0 }, { id: 'f2', name: '이차전지', order: 1 }],
    entries: [
      { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 },
      { code: '373220', name: 'LG에너지', folder_id: 'f1', order: 1 },
      { code: '373220', name: 'LG에너지', folder_id: 'f2', order: 0 },
    ], capture_markers: {}, next_run_at_ms: 0,
  });
  useHeatmapPrefsStore.setState({ sortMode: 'desc', groupSort: 'desc' });
  renderPage();
  await screen.findByText('반도체');
  const rowOrder = () => Array.from(document.querySelectorAll('#heatmap-folder-f1 [data-testid^="heatmap-row-"]'))
    .map((el) => el.getAttribute('data-testid'));
  expect(folderOrder()).toEqual(['heatmap-folder-f2', 'heatmap-folder-f1']);
  expect(rowOrder()).toEqual(['heatmap-row-373220', 'heatmap-row-005930']);
  act(() => useEntryDragStore.getState().startDrag('005930'));
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 77000, change_pct: 10, change_won: 7000 }],
      ['373220', { code: '373220', price: 400000, change_pct: 5, change_won: 20000 }],
    ]), phase: 'open', dataUpdatedAt: 1,
  });
  // 정렬 설정 변경으로 스로틀을 flush해 새 시세가 정렬 키에 도달하게 한다.
  act(() => useHeatmapPrefsStore.getState().setGroupSort('asc'));
  act(() => useHeatmapPrefsStore.getState().setGroupSort('desc'));
  expect(folderOrder()).toEqual(['heatmap-folder-f2', 'heatmap-folder-f1']);
  expect(rowOrder()).toEqual(['heatmap-row-373220', 'heatmap-row-005930']);
  expect(screen.getByTestId('heatmap-row-005930')).toHaveTextContent('77,000');
  act(() => useEntryDragStore.getState().endDrag());
  expect(folderOrder()).toEqual(['heatmap-folder-f1', 'heatmap-folder-f2']);
  expect(rowOrder()).toEqual(['heatmap-row-005930', 'heatmap-row-373220']);
});
