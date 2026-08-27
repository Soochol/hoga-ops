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
const h = vi.hoisted(() => {
  /** 그룹 드래그로 전 그룹이 접힐 때 드롭 타깃을 다시 재라는 요청(RemeasureOnCollapse).
   *  **모의에 이 키가 없으면** 훅이 `undefined()` 를 불러 터진다 — 배선을 재는 김에
   *  존재도 같이 고정한다. */
  const measureDroppableContainers = vi.fn();
  return {
    onDragStart: null as null | ((e: unknown) => void),
    onDragEnd: null as null | ((e: unknown) => void),
    /** 마지막 렌더에서 DragOverlay 가 받은 dropAnimation. null = 낙하 애니메이션 끔. */
    dropAnimation: undefined as unknown,
    /** 마지막 렌더에서 DragOverlay 가 받은 style — `fitContent` 배선을 여기서 잰다.
     *  dnd-kit 이 래퍼에 박는 width/height 를 덮는 것이 그 prop 의 전부이므로, 실제
     *  픽셀이 아니라 **넘어간 선언**을 재는 것이 이 층에서 가능한 최대다(ADR-0057). */
    overlayStyle: undefined as undefined | Record<string, unknown>,
    onPointerDown: vi.fn(),
    setActivatorNodeRef: vi.fn(),
    measureDroppableContainers,
    /** `useDndContext()` 의 반환값 — **참조가 고정돼야 한다.** 실물 컨텍스트는 memo 라
     *  안정적이고, 매 렌더 새 객체를 주면 이 값을 deps 에 넣은 effect 가 무한히 재실행된다. */
    dndContext: { active: null, over: null, measureDroppableContainers },
  };
});
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
    DragOverlay: ({ children, dropAnimation, style }: {
      children: React.ReactNode; dropAnimation: unknown; style?: Record<string, unknown>;
    }) => {
      h.dropAnimation = dropAnimation;
      h.overlayStyle = style;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
    // 그룹 드롭존(v5)은 실물 훅이 아니라 스텁으로 — 여기서 재는 것은 onDragEnd 배선이고,
    // 실제 히트 영역·하이라이트는 e2e 담당(ADR-0057). 히트맵 드로어 테스트와 같은 선례.
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
    useDndContext: () => h.dndContext,
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
    h.overlayStyle = undefined;
    h.onPointerDown.mockClear();
    h.setActivatorNodeRef.mockClear();
    h.measureDroppableContainers.mockClear();
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

  // --- 그룹(폴더) 드래그의 손·눈 피드백 ---
  //
  // 이 절이 뒤집은 것: 여기 있던 테스트는 "폴더는 고스트를 만들지 않는다 — 그룹 블록
  // transform 이 이미 적절하다" 였다. 그 전제가 브라우저 실측으로 틀렸다(2026-08-27).
  // 오버레이 껍데기는 드래그 종류와 무관하게 **항상 마운트**돼 있어서, children 이
  // null 이면 그룹 크기의 **빈 카드**(280×129, innerHTML 길이 0)가 커서를 따라왔고,
  // 동시에 dnd-kit 이 `useDragOverlay = Boolean(dragOverlay.rect !== null)` 로 오버레이
  // 유무를 판단하는 탓에 원본 블록은 포인터가 아니라 **착지 예정지**로 순간이동했다
  // (포인터 330px vs 블록 733px).
  //
  // 막는 방향: 폴더 드래그에서 고스트 내용이 **비는 것**. 못 보는 것: 실제 픽셀 크기와
  // 배치(오버레이는 body 포털 + fixed라 jsdom 에서 의미 없다) — 그건 e2e 담당(ADR-0057).
  const startFolderDrag = (id = 'f_0000000a') => act(() => {
    h.onDragStart!({ active: { id, data: { current: { type: 'folder' } } } });
  });
  const endDrag = (active: unknown) => act(() => {
    h.onDragEnd!({ active, over: null, activatorEvent: null, delta: { x: 0, y: 0 } });
  });

  it('puts the grabbed group name + count on the drag ghost, and clears it when the drag ends', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.queryByTestId('watchlist-drag-ghost')).not.toBeInTheDocument();

    startFolderDrag();
    const ghost = screen.getByTestId('watchlist-drag-ghost');
    // 스윙 폴더 = ENTRIES 2건. 이름만이 아니라 **개수까지** — 접힌 채로 옮기므로
    // 손에 든 것이 "몇 종목짜리 그룹인지"가 화면 어디에도 남지 않는다.
    expect(ghost).toHaveTextContent('스윙');
    expect(ghost).toHaveTextContent('2');

    endDrag({ id: 'f_0000000a', data: { current: { type: 'folder' } } });
    expect(screen.queryByTestId('watchlist-drag-ghost')).not.toBeInTheDocument();
  });

  it('caps the folder ghost height to its content, and leaves the width alone', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    startFolderDrag();
    // 높이는 덮는다 — dnd-kit 이 래퍼에 박는 height(=액티브 노드 = 그룹 블록 전체)를
    // 그대로 두면 한 줄짜리 칩 주위로 빈 카드가 남는다.
    expect(h.overlayStyle).toMatchObject({ height: 'auto' });
    // 폭은 **덮지 않는다** — 블록 폭이 곧 레일 컬럼 폭이라 원래 맞고, 좁히면 칩이 아래
    // 원본 행보다 작아져 원본의 개수 숫자가 삐져나온 이중상이 된다(실측).
    expect(h.overlayStyle).not.toHaveProperty('width');

    endDrag({ id: 'f_0000000a', data: { current: { type: 'folder' } } });
    act(() => { h.onDragStart!(DRAG_START); });   // 종목 행 드래그는 원본 크기 그대로
    expect(h.overlayStyle).not.toHaveProperty('height');
  });

  // --- 그룹 드래그 중 전 그룹 접기(B) ---
  //
  // 막는 방향: 높이가 제각각인 블록(실측 129~579px, 뷰포트 622px)을 그대로 둔 채
  // closestCenter 로 재는 것. 못 보는 것: 접힘이 **실제로** 충돌 기하를 고치는지는
  // 레이아웃이 없는 jsdom 에서 잴 수 없다 — 여기서는 "행이 사라졌다가 돌아온다" 와
  // "재측정을 요청한다" 라는 두 관측 가능한 결과만 고정한다.
  it('renders every group header-only while a group drag is in flight, and restores rows after', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(rowNames()).toEqual(['watchlist-row-005930', 'watchlist-row-000660']);

    startFolderDrag();
    // 잡은 그룹만이 아니라 **전부** — 중간에 긴 블록이 하나라도 남으면 균일 높이라는
    // 전제가 그대로 깨진다. 헤더는 남아야 겨냥할 곳이 있다.
    expect(rowNames()).toEqual([]);
    expect(screen.getAllByTestId('watchlist-group-header').length).toBeGreaterThan(0);

    endDrag({ id: 'f_0000000a', data: { current: { type: 'folder' } } });
    await waitFor(() =>
      expect(rowNames()).toEqual(['watchlist-row-005930', 'watchlist-row-000660']));
  });

  it('leaves the persisted collapse state untouched — the drag-time collapse is render-only', async () => {
    // 사용자가 '장기'만 접어 둔 상태에서 출발한다.
    window.localStorage.setItem('watchlist.collapsed', JSON.stringify({ keys: ['f_0000000b'] }));
    const savedKeys = () =>
      JSON.parse(window.localStorage.getItem('watchlist.collapsed') ?? '{"keys":null}').keys;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    startFolderDrag();
    expect(rowNames()).toEqual([]);                 // 화면은 전부 접혔는데
    expect(savedKeys()).toEqual(['f_0000000b']);    // 저장된 값은 그대로다

    endDrag({ id: 'f_0000000a', data: { current: { type: 'folder' } } });
    // 드래그가 끝나면 사용자가 펼쳐 두었던 '스윙'이 그대로 돌아온다.
    await waitFor(() =>
      expect(rowNames()).toEqual(['watchlist-row-005930', 'watchlist-row-000660']));
    expect(savedKeys()).toEqual(['f_0000000b']);
  });

  it('asks dnd-kit to re-measure drop targets when the groups collapse', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    h.measureDroppableContainers.mockClear();

    startFolderDrag();
    // 접힘 **전** rect 로 충돌을 재면 겨냥과 착지가 갈린다. 빈 배열 = 전부 다시 재기.
    expect(h.measureDroppableContainers).toHaveBeenCalledWith([]);
  });

  it('makes no folder ghost for an entry drag — rows keep their own row-shaped ghost', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    act(() => { h.onDragStart!(DRAG_START); });
    // 종목 드래그는 접지 않는다 — 그룹 간 이동의 드롭 타깃이 바로 그 행들이다.
    expect(rowNames()).toEqual(['watchlist-row-005930', 'watchlist-row-000660']);
    expect(screen.getByTestId('watchlist-drag-ghost')).toHaveTextContent('삼성전자');
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
  // --- 폴더 간 이동(v5) ---
  // 막는 방향: 패널에서 종목을 **다른 그룹으로 옮길 수 없던 것**. 그전엔 onDragEnd 가
  // 출발 폴더의 행 목록에서만 목적지를 찾아, 다른 폴더 위에 놓으면 조용한 no-op 이었다.
  // 못 보는 것: 실제 히트 영역(빈/접힌 폴더를 겨눌 수 있는가)은 여기서 안 잰다 —
  // 그건 panelDragCollision.test 의 드롭존 레인 + e2e 담당(ADR-0057).
  const MOVE_EVENT = (over: Record<string, unknown>) => ({
    active: { id: 'f_0000000a:005930', data: { current: { type: 'entry', folderId: 'f_0000000a', code: '005930', name: '삼성전자' } } },
    over,
    activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
    delta: { x: 0, y: 0 },
  });

  it('entry-drag onto another group drop zone → addMember(to) + removeMember(from)', async () => {
    const addSpy = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: 'f_0000000b', order: 0,
    });
    const removeSpy = vi.spyOn(watchlistApi, 'removeMember').mockResolvedValue();
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    h.onDragEnd!(MOVE_EVENT({
      id: 'folder:f_0000000b',
      data: { current: { type: 'entry-target', folderId: 'f_0000000b' } },
    }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('f_0000000b', '005930', undefined));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('f_0000000a', '005930'));
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  // 회귀: 다중 소속(ADR-0070)이라 대상 폴더의 행 위에 놓았을 때 **그 종목이 출발 폴더에도
  // 등록돼 있으면** 옛 코드는 출발 폴더 rows 에서 그 code 를 찾아내 **출발 폴더를 조용히
  // 재정렬**했다 — 사용자가 요청한 이동은 일어나지 않은 채로. move 분기가 선행하면 사라진다.
  it('entry-drag over a row in another folder moves it — never silently reorders the source', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      ...DATA,
      entries: [
        ...ENTRIES,
        // 000660 이 **양쪽 폴더에** 등록돼 있다 — 옛 코드가 헛짚던 바로 그 조건.
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 0 },
      ],
    });
    const addSpy = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: 'f_0000000b', order: 1,
    });
    const removeSpy = vi.spyOn(watchlistApi, 'removeMember').mockResolvedValue();
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    h.onDragEnd!(MOVE_EVENT({
      id: 'f_0000000b:000660',
      data: { current: { type: 'entry', folderId: 'f_0000000b' } },
    }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('f_0000000b', '005930', undefined));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('f_0000000a', '005930'));
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  it('미분류 행을 그룹으로 끌면 addMember 하나로 끝난다 (뺄 출처가 없다)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      ...DATA,
      entries: [{ code: '035720', name: '카카오', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }],
    });
    const addSpy = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({
      code: '035720', name: '카카오', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: 'f_0000000a', order: 0,
    });
    const removeSpy = vi.spyOn(watchlistApi, 'removeMember').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('카카오')).toBeInTheDocument());

    h.onDragEnd!({
      active: { id: '__uncat__:035720', data: { current: { type: 'entry', folderId: null, code: '035720', name: '카카오' } } },
      over: { id: 'folder:f_0000000a', data: { current: { type: 'entry-target', folderId: 'f_0000000a' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('f_0000000a', '035720', undefined));
    expect(removeSpy).not.toHaveBeenCalled();
  });

  // 정렬 모드 게이트는 **재정렬 전용**이다 — 순서와 무관한 이동까지 죽이면, 정렬을 켠
  // 폴더는 종목을 넣지도 빼지도 못하는 섬이 된다(히트맵도 non-manual 에서 이동만 허용).
  it('정렬 모드가 켜진 폴더에서도 폴더 간 이동은 살아 있다', async () => {
    const addSpy = vi.spyOn(watchlistApi, 'addMember').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260101',
      last_success_date: null, folder_id: 'f_0000000b', order: 0,
    });
    const removeSpy = vi.spyOn(watchlistApi, 'removeMember').mockResolvedValue();
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderItems').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    fireEvent.click(screen.getByLabelText('스윙 정렬'));

    h.onDragEnd!(MOVE_EVENT({
      id: 'folder:f_0000000b',
      data: { current: { type: 'entry-target', folderId: 'f_0000000b' } },
    }));

    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('f_0000000b', '005930', undefined));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('f_0000000a', '005930'));
    expect(reorderSpy).not.toHaveBeenCalled();
  });
});
