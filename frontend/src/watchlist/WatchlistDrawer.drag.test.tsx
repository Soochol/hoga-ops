import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';
import { useLivePageStore } from '../state/livePage';
import { useEntryDragStore } from '../state/entryDrag';
import { WATCHLIST_KEY } from './watchlistKeys';

// ADR-0057: 패널 드래그의 wiring contract만 검증 — 실제 dnd-kit 포인터/충돌은 e2e가 담당.
// DndContext를 passthrough로 모킹해 주입된 onDragEnd를 캡처하고, useSortable은 no-op으로 둔다.
const h = vi.hoisted(() => ({
  onDragStart: null as null | ((e: unknown) => void),
  onDragEnd: null as null | ((e: unknown) => void),
  /** 마지막 렌더에서 DragOverlay 가 받은 dropAnimation. null = 낙하 애니메이션 끔. */
  dropAnimation: undefined as unknown,
  onPointerDown: vi.fn(),
  setActivatorNodeRef: vi.fn(),
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragStart, onDragEnd }: {
      children: React.ReactNode;
      onDragStart: (e: unknown) => void;
      onDragEnd: (e: unknown) => void;
    }) => {
      h.onDragStart = onDragStart;
      h.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
    // 실제 DragOverlay 는 DndContext 의 `active` 를 읽어 없으면 null 을 반환한다 — 위
    // passthrough 모킹에는 그 컨텍스트가 없으므로 고스트가 영원히 안 뜬다. 여기서
    // 검증하는 것은 렌더 위치가 아니라 **고스트에 무엇이 실리는가**(wiring)이므로
    // children 을 그대로 통과시킨다. 실제 오버레이 배치는 e2e 담당(ADR-0057).
    DragOverlay: ({ children, dropAnimation }: {
      children: React.ReactNode; dropAnimation: unknown;
    }) => {
      h.dropAnimation = dropAnimation;
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
      setNodeRef: () => {},
      setActivatorNodeRef: h.setActivatorNodeRef,
      listeners: { onPointerDown: h.onPointerDown },
      attributes: { role: 'button' },
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
const DATA = { folders: FOLDERS, entries: ENTRIES, memos: [], next_run_at_ms: 0 };

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
    window.localStorage.clear();
    h.onDragStart = null;
    h.onDragEnd = null;
    h.dropAnimation = undefined;
    h.onPointerDown.mockClear();
    h.setActivatorNodeRef.mockClear();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  });

  it('wires entry drag to the whole stock row without rendering a row handle', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    const row = screen.getByTestId('watchlist-row-005930');
    expect(screen.queryByTestId('drag-handle-watchlist-row-005930')).not.toBeInTheDocument();
    expect(h.setActivatorNodeRef).toHaveBeenCalledWith(row);

    fireEvent.pointerDown(row);
    expect(h.onPointerDown).toHaveBeenCalledOnce();
  });

  it('makes every folder group header draggable (핸들 아이콘 없이 헤더 전체), not only the first', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('장기')).toBeInTheDocument());

    // 그룹 헤더 자체가 드래그 활성 영역(data-draggable). 실폴더 2개.
    const headers = screen.getAllByTestId('watchlist-group-header').filter((el) => el.hasAttribute('data-draggable'));
    expect(headers).toHaveLength(2);

    fireEvent.pointerDown(headers[0]);
    fireEvent.pointerDown(headers[1]);
    expect(h.onPointerDown).toHaveBeenCalledTimes(2);
    expect(h.setActivatorNodeRef).toHaveBeenCalledWith(headers[0]);
    expect(h.setActivatorNodeRef).toHaveBeenCalledWith(headers[1]);
  });

  it('entry-drag onDragEnd → reorderItems(folderId, orderedItems)', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    // v3 composite sortable id: `${folderId}:${code}` (다중 소속 충돌 방지, ADR-0070).
    h.onDragEnd!({
      active: { id: 'f_0000000a:005930', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
      over: { id: 'f_0000000a:000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('f_0000000a', [{ kind: 'code', code: '000660' }, { kind: 'code', code: '005930' }]));
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
      const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      render(<WatchlistDrawer />, { wrapper: wrap(qc) });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
      // 드롭 지점 = activator(900,300) + delta(-500,0) = (400,300) → 술어 true.
      // id는 v3 복합(folderId:code); 차트-드롭 분기는 data.current.code를 쓴다.
      h.onDragEnd!({
        active: { id: 'f_0000000a:005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
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
      const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      render(<WatchlistDrawer />, { wrapper: wrap(qc) });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
      // 드롭 지점 = activator(900,300) + delta(0,0) = (900,300) → 술어 false → 재정렬 경로.
      // v3 복합 id로 over/active를 지정해야 parseEntrySortableId가 folderId/code를 푼다.
      h.onDragEnd!({
        active: { id: 'f_0000000a:005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
        over: { id: 'f_0000000a:000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: 0, y: 0 },
      });
      await waitFor(() => expect(reorderSpy).toHaveBeenCalledWith('f_0000000a', [{ kind: 'code', code: '000660' }, { kind: 'code', code: '005930' }]));
      expect(useLivePageStore.getState().activeCode).toBeNull();
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('entry-drag in change-rate sort mode does not reorder', async () => {
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    h.onDragEnd!({
      active: { id: 'f_0000000a:005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
      over: { id: 'f_0000000a:000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    await Promise.resolve();
    expect(reorderSpy).not.toHaveBeenCalled();
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('entry-drag still does not reorder when change-rate sort mode is restored from localStorage', async () => {
    window.localStorage.setItem('watchlist.sortMode.v1', JSON.stringify({ sortMode: 'change_pct_asc' }));
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    h.onDragEnd!({
      active: { id: 'f_0000000a:005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
      over: { id: 'f_0000000a:000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    await Promise.resolve();
    expect(reorderSpy).not.toHaveBeenCalled();
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  // --- 드래그 중 입력 동결(P2) ---
  // 막는 방향: 드래그가 진행되는 동안 들어온 갱신(WS 틱 150ms · 60초 refetch)이 화면
  // 행 목록을 흔드는 것. 못 보는 것: 리렌더 **횟수** 자체는 여기서 안 잰다(동결은
  // 리렌더를 없애는 게 아니라 참조를 고정해 싸게 만드는 장치다 — 파일 상단 주석 참조).
  const DRAG_START = {
    active: {
      id: 'f_0000000a:005930',
      data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } },
    },
  };
  // **패널 스크롤 영역 안의** `[data-quote-row]` 만 센다. 두 가지를 동시에 배제한다:
  // testId 접두사로 모으면 우클릭 메뉴(`watchlist-row-menu`)가 딸려 오고, 문서 전체를
  // 훑으면 드래그 고스트(`document.body` 포털 · 같은 QuoteRow 라 같은 마커)가 섞인다.
  const rowNames = () =>
    Array.from(
      screen.getByTestId('watchlist-scroll').querySelectorAll('[data-quote-row]'),
    ).map((el) => el.getAttribute('data-testid'));

  it('freezes the rendered row list while a drag is in flight, and catches up after it ends', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(rowNames()).toEqual(['watchlist-row-005930', 'watchlist-row-000660']);

    act(() => { h.onDragStart!(DRAG_START); });
    // 드래그 도중 서버 갱신이 착지한다(순서 뒤집힘).
    await act(async () => {
      qc.setQueryData(WATCHLIST_KEY, {
        ...DATA,
        entries: [
          { ...ENTRIES[1], order: 0 },
          { ...ENTRIES[0], order: 1 },
        ],
      });
    });
    // 캐시 갱신만으로는 이 시점에 리렌더가 보장되지 않는다(react-query 알림이 배치된다).
    // 그래서 **행 목록에 영향이 없는 상호작용**으로 리렌더를 확정적으로 일으킨 뒤 잰다 —
    // 우클릭은 setMenu 만 건드린다. 이 강제 리렌더가 없으면 동결을 제거해도 테스트가
    // 통과하는 가짜 가드가 된다(red-check 로 실제로 확인했다).
    fireEvent.contextMenu(screen.getByTestId('watchlist-row-005930'));
    expect(rowNames()).toEqual(['watchlist-row-005930', 'watchlist-row-000660']);

    act(() => {
      h.onDragEnd!({ ...DRAG_START, over: null, activatorEvent: null, delta: { x: 0, y: 0 } });
    });
    await waitFor(() =>
      expect(rowNames()).toEqual(['watchlist-row-000660', 'watchlist-row-005930']));
  });

  // --- 드래그 고스트(P1) ---
  it('puts the dragged stock on the drag ghost, and clears it when the drag ends', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.queryByTestId('watchlist-drag-ghost')).not.toBeInTheDocument();

    act(() => { h.onDragStart!(DRAG_START); });
    expect(screen.getByTestId('watchlist-drag-ghost')).toHaveTextContent('삼성전자');

    act(() => {
      h.onDragEnd!({ ...DRAG_START, over: null, activatorEvent: null, delta: { x: 0, y: 0 } });
    });
    expect(screen.queryByTestId('watchlist-drag-ghost')).not.toBeInTheDocument();
  });

  // 차트에 성공적으로 떨군 드롭은 고스트가 패널 원위치로 **되날아가면 안 된다** — 그
  // 그림은 성공을 실패로 읽히게 한다. store 의 overChart 를 렌더에서 읽던 첫 구현은 이
  // 조항이 무효였다: endDrag() 가 같은 커밋에서 그 값을 먼저 지운다. 타이밍이 아니라
  // **결정 자체**를 재려고 DragOverlay 가 받은 prop 을 캡처한다.
  it('turns the fly-back animation off for a chart drop, and keeps it for a panel reorder', async () => {
    const hitTest = (clientX: number) => clientX < 800; // x<800 = 차트 위
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      render(<WatchlistDrawer />, { wrapper: wrap(qc) });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

      // (1) 차트 위 드롭 — activator(900,300) + delta(-500,0) = (400,300) → 술어 true.
      act(() => { h.onDragStart!(DRAG_START); });
      act(() => {
        h.onDragEnd!({
          ...DRAG_START, over: null,
          activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
          delta: { x: -500, y: 0 },
        });
      });
      expect(h.dropAnimation).toBeNull();

      // (2) 패널 안 재정렬 — 같은 좌표계에서 차트 밖(900,300) → 기본 애니메이션 유지.
      act(() => { h.onDragStart!(DRAG_START); });
      act(() => {
        h.onDragEnd!({
          ...DRAG_START,
          over: { id: 'f_0000000a:000660', data: { current: { type: 'entry', folderId: 'f_0000000a' } } },
          activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
          delta: { x: 0, y: 0 },
        });
      });
      expect(h.dropAnimation).not.toBeNull();
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('makes no ghost for a folder drag — the group block transform already reads right', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    act(() => {
      h.onDragStart!({ active: { id: 'f_0000000a', data: { current: { type: 'folder' } } } });
    });
    expect(screen.queryByTestId('watchlist-drag-ghost')).not.toBeInTheDocument();
  });

  it('entry-drag in one folder does not affect another folder default-sort behavior', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValueOnce({
      folders: FOLDERS,
      entries: [
        ...ENTRIES,
        { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 0 },
        { code: '051910', name: 'LG화학', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 1 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
        { code: '035420', price: 211000, change_pct: 2.1, change_won: 2100 },
        { code: '051910', price: 560000, change_pct: -1.5, change_won: -2000 },
      ],
    });
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    fireEvent.click(screen.getByLabelText('스윙 정렬'));

    h.onDragEnd!({
      active: { id: 'f_0000000b:035420', data: { current: { type: 'entry', folderId: 'f_0000000b', code: '035420', name: 'NAVER' } } },
      over: { id: 'f_0000000b:051910', data: { current: { type: 'entry', folderId: 'f_0000000b' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    await waitFor(() => expect(reorderSpy).toHaveBeenCalledWith('f_0000000b', [{ kind: 'code', code: '051910' }, { kind: 'code', code: '035420' }]));
  });
});
