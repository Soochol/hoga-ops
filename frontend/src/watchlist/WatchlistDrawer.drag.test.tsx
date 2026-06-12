import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';
import { useLivePageStore } from '../state/livePage';
import { useEntryDragStore } from '../state/entryDrag';

// ADR-0057: 패널 드래그의 wiring contract만 검증 — 실제 dnd-kit 포인터/충돌은 e2e가 담당.
// DndContext를 passthrough로 모킹해 주입된 onDragEnd를 캡처하고, useSortable은 no-op으로 둔다.
const h = vi.hoisted(() => ({ onDragEnd: null as null | ((e: unknown) => void) }));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (e: unknown) => void }) => {
      h.onDragEnd = onDragEnd;
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

import { WatchlistDrawer } from './WatchlistDrawer';

const FOLDERS = [
  { id: 'f_0000000a', name: '스윙', order: 0 },
  { id: 'f_0000000b', name: '장기', order: 1 },
];
const ENTRIES = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
];
const DATA = { folders: FOLDERS, entries: ENTRIES, next_run_at_ms: 0 };

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('WatchlistDrawer drag wiring', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    h.onDragEnd = null;
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  });

  it('entry-drag onDragEnd → reorderEntries(folderId, orderedCodes)', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    h.onDragEnd!({
      active: { id: '005930', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
      over: { id: '000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('f_0000000a', ['000660', '005930']));
  });

  it('folder-drag onDragEnd → reorderFolders(orderedIds)', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderFolders').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    h.onDragEnd!({
      active: { id: 'f_0000000a', data: { current: { type: 'folder' } } },
      over: { id: 'f_0000000b', data: { current: { type: 'folder' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(['f_0000000b', 'f_0000000a']));
  });

  it("folder-drag over an entry row resolves to that row's folder", async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderFolders').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    // f_0000000a 폴더를 f_0000000b 소속 행 위로 드롭 → over.folderId=f_0000000b로 정규화.
    // (DATA의 ENTRIES는 둘 다 f_0000000a이므로, over 이벤트의 folderId를 직접 지정한다.)
    h.onDragEnd!({
      active: { id: 'f_0000000a', data: { current: { type: 'folder' } } },
      over: { id: '999999', data: { current: { type: 'entry', folderId: 'f_0000000b' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(['f_0000000b', 'f_0000000a']));
  });

  // 차트 드롭-타깃 seam: LiveWorkarea가 등록하는 히트테스트 술어를 가짜로 등록해 테스트한다 —
  // DOM 노드 append·getBoundingClientRect stub·테스트ID 없이 seam만 직접 검증(딥닝의 증거).
  it('entry-drag dropped over the chart drop-target changes the active tab (no reorder)', async () => {
    const hitTest = (clientX: number) => clientX < 800; // 드롭 지점 x=400 < 800 → 차트 위
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      const reorderSpy = vi.spyOn(watchlistApi, 'reorderEntries').mockResolvedValue();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      render(<WatchlistDrawer />, { wrapper: wrap(qc) });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
      // 드롭 지점 = activator(900,300) + delta(-500,0) = (400,300) → 술어 true.
      h.onDragEnd!({
        active: { id: '005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
        over: null,
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: -500, y: 0 },
      });
      // 클릭과 같은 onPick 경로 → 현재 탭 종목 교체(useLivePageStore.activeCode), 재정렬은 미발생.
      expect(useLivePageStore.getState().activeCode).toBe('005930');
      expect(reorderSpy).not.toHaveBeenCalled();
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('entry-drag dropped OUTSIDE the chart drop-target still reorders (no jump)', async () => {
    const hitTest = (clientX: number) => clientX < 800; // 드롭 지점 x=900 → 차트 밖
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      const reorderSpy = vi.spyOn(watchlistApi, 'reorderEntries').mockResolvedValue();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      render(<WatchlistDrawer />, { wrapper: wrap(qc) });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
      // 드롭 지점 = activator(900,300) + delta(0,0) = (900,300) → 술어 false → 재정렬 경로.
      h.onDragEnd!({
        active: { id: '005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
        over: { id: '000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: 0, y: 0 },
      });
      await waitFor(() => expect(reorderSpy).toHaveBeenCalledWith('f_0000000a', ['000660', '005930']));
      expect(useLivePageStore.getState().activeCode).toBeNull();
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });
});
