import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as client from '../api/client';
import * as liveNavigate from '../live/liveNavigate';
import * as watchlistApi from '../api/watchlist';
import { useEntryDragStore } from '../state/entryDrag';
import { RankingDrawer } from './RankingDrawer';

// DnD 는 렌더 골격만 필요 — 실제 센서/포인터는 이 테스트 범위 밖.
const dnd = vi.hoisted(() => ({
  onDragStart: null as null | ((e: unknown) => void),
  onDragEnd: null as null | ((e: unknown) => void),
  /** 마지막 렌더에서 DragOverlay 가 받은 dropAnimation. null = 낙하 애니메이션 끔. */
  dropAnimation: undefined as unknown,
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragStart, onDragEnd }: {
      children: React.ReactNode;
      onDragStart?: (e: unknown) => void;
      onDragEnd?: (e: unknown) => void;
    }) => {
      dnd.onDragStart = onDragStart ?? null;
      dnd.onDragEnd = onDragEnd ?? null;
      return <>{children}</>;
    },
    // 실제 DragOverlay 는 DndContext 의 `active` 를 읽어 없으면 null 을 반환한다 — 위
    // passthrough 모킹에는 그 컨텍스트가 없으므로 고스트가 영원히 안 뜬다. 여기서 재는
    // 것은 렌더 위치가 아니라 **고스트에 무엇이 실리는가**이므로 children 을 통과시킨다.
    DragOverlay: ({ children, dropAnimation }: {
      children: React.ReactNode; dropAnimation: unknown;
    }) => {
      dnd.dropAnimation = dropAnimation;
      return <>{children}</>;
    },
    useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, attributes: {}, transform: null, isDragging: false }),
    useSensor: () => ({}),
    useSensors: () => [],
  };
});

const OPEN_RESPONSE = {
  kind: 'change',
  market: 'all',
  direction: 'up',
  rows: [
    { rank: 1, code: '294870', name: 'HDC현대산업개발', price: 24350, change_pct: 29.97 },
    { rank: 2, code: '005930', name: '삼성전자', price: 71200, change_pct: 5.79 },
  ],
  market_open: true,
  fetched_at_ms: 1_700_000_000_000,
};

/** QueryClient 도 함께 돌려준다 — 드래그 중 폴링 착지를 흉내 내려면 캐시에 직접
 *  써야 한다(쿼리 키를 바꾸는 UI 조작은 목록을 로딩 상태로 날려 버린다). */
function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/live']}>
          <RankingDrawer />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.spyOn(liveNavigate, 'activateLiveCode').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RankingDrawer', () => {
  it('renders ranked rows and requests /api/live/rankings with default params', async () => {
    const apiCall = vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();

    expect(await screen.findByText('HDC현대산업개발')).toBeInTheDocument();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    // 순위번호가 선행 슬롯에 렌더된다.
    expect(screen.getByText('1')).toBeInTheDocument();
    // 첫 요청 = change/all/up.
    const url = apiCall.mock.calls[0][0] as string;
    expect(url).toContain('kind=change');
    expect(url).toContain('market=all');
    expect(url).toContain('direction=up');
  });

  it('switching kind re-queries with the new kind', async () => {
    const apiCall = vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    fireEvent.click(screen.getByRole('button', { name: '대금' }));

    await waitFor(() => {
      expect(apiCall.mock.calls.some((c) => (c[0] as string).includes('kind=value'))).toBe(true);
    });
  });

  it('ETF 제외 토글이 exclude_etf=true 로 재조회한다', async () => {
    const apiCall = vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    // 기본 요청엔 exclude_etf 가 없다.
    expect((apiCall.mock.calls[0][0] as string)).not.toContain('exclude_etf');

    fireEvent.click(screen.getByRole('button', { name: 'ETF 제외' }));

    await waitFor(() => {
      expect(apiCall.mock.calls.some((c) => (c[0] as string).includes('exclude_etf=true'))).toBe(true);
    });
  });

  it('마스터 미로드 경고를 배지로 띄운다 (조용한 fail-open 방지)', async () => {
    // 대조군 먼저 — 경고 없는 응답에서 배지가 뜨면 아래 단언은 아무것도 증명하지 못한다.
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');
    expect(screen.queryByText(/ETF 를 거르지 못했습니다/)).not.toBeInTheDocument();

    cleanup();
    vi.spyOn(client, 'apiCall').mockResolvedValue(
      { ...OPEN_RESPONSE, warnings: ['etf_filter_unavailable'] } as never,
    );
    renderDrawer();

    expect(await screen.findByText(/ETF 를 거르지 못했습니다/)).toBeInTheDocument();
    // 필터가 듣지 않았을 뿐 목록 자체는 계속 보여준다.
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
  });

  it('direction toggle shows only on the change kind', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    expect(screen.getByRole('button', { name: '↓하락' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '↓하락' })).not.toBeInTheDocument();
    });
  });

  it('clicking a row activates that code (jump-to-chart)', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    fireEvent.click(await screen.findByText('삼성전자'));
    expect(liveNavigate.activateLiveCode).toHaveBeenCalledWith('005930', '삼성전자');
  });

  it('shows 장 외 when market is closed', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({ ...OPEN_RESPONSE, market_open: false } as never);
    renderDrawer();
    expect(await screen.findByText('장 외')).toBeInTheDocument();
  });

  it('renders an error state when the request fails', async () => {
    vi.spyOn(client, 'apiCall').mockRejectedValue(new Error('boom'));
    renderDrawer();
    expect(await screen.findByText('조회 실패')).toBeInTheDocument();
  });

  it('right-clicking a row opens the 관심 그룹 menu (스크리너와 동일)', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [],
      next_run_at_ms: 0,
    } as never);
    renderDrawer();

    fireEvent.contextMenu(await screen.findByTestId('ranking-row-005930'));
    expect(await screen.findByRole('menu', { name: '삼성전자 관심 그룹' })).toBeInTheDocument();
    // 비멤버 종목이므로 그룹 체크는 꺼져 있고, '관심 해제' 항목은 노출되지 않는다.
    const group = await screen.findByRole('menuitemcheckbox', { name: '스윙' });
    expect(group.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('quote-menu-remove-all')).not.toBeInTheDocument();
    // 우클릭은 행 활성화(차트 전환)와 무관하다.
    expect(liveNavigate.activateLiveCode).not.toHaveBeenCalled();
  });

  it('sort button re-orders the visible list by 등락률 (client-side)', async () => {
    // 서버 순서: HDC(29.97) → 삼성(5.79). 등락률 desc 는 이미 동순이라, asc 로
    // 두 번 눌러 삼성이 위로 오는지로 재정렬을 확인한다.
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    const rowNames = () =>
      screen.getAllByRole('button', { name: /차트 열기/ }).map((li) => li.getAttribute('aria-label'));
    expect(rowNames()[0]).toContain('HDC현대산업개발'); // 기본 = 서버 순서

    const sortBtn = screen.getByRole('button', { name: '등락률 정렬' });
    fireEvent.click(sortBtn); // → desc
    fireEvent.click(sortBtn); // → asc: 낮은 등락률(삼성 5.79)이 위로
    expect(rowNames()[0]).toContain('삼성전자');
  });

  // --- 차트로 끌어 떨구기(공용 seam) ---
  // 이 패널의 드래그는 재정렬이 아니라 **복사 제스처**다: droppable 이 없어 over 가 없고,
  // 드롭 후에도 행은 리스트에 남는다. 그래서 재는 것은 (1) 손에 든 것이 보이는가,
  // (2) 성공한 드롭이 되날아가지 않는가, (3) 드래그 중 발밑이 흔들리지 않는가 셋이다.
  const DRAG_START = {
    active: {
      id: 'ranking-entry:005930',
      data: { current: { type: 'ranking-entry', code: '005930', name: '삼성전자' } },
    },
  };

  it('puts the dragged row on the drag ghost, and clears it when the drag ends', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');
    expect(screen.queryByTestId('ranking-drag-ghost')).not.toBeInTheDocument();

    act(() => { dnd.onDragStart!(DRAG_START); });
    expect(screen.getByTestId('ranking-drag-ghost')).toHaveTextContent('삼성전자');

    act(() => {
      dnd.onDragEnd!({ ...DRAG_START, activatorEvent: null, delta: { x: 0, y: 0 } });
    });
    expect(screen.queryByTestId('ranking-drag-ghost')).not.toBeInTheDocument();
  });

  // 고스트의 좌측 슬롯. 이 패널의 행은 순위번호(leading)로 종목명 시작 x 를 맞추므로
  // 고스트가 그 슬롯을 빼면 손에 든 이름만 1.75rem 왼쪽으로 밀린다 — QuoteRow 의 좌측
  // 여백은 `leading` 이 있으면 pl-md, 없으면 pl-10(indented)이라 두 경로가 상호배타다.
  // 숫자를 텍스트로 재지 않고 슬롯을 지목하는 이유: 픽스처 005930 은 rank 2 인데
  // 가격 71,200 에도 '2' 가 있어 toHaveTextContent('2') 는 슬롯을 지워도 통과한다.
  it('고스트에 리스트 행과 같은 순위번호 슬롯을 실어 종목명 시작 x 를 맞춘다', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    act(() => { dnd.onDragStart!(DRAG_START); });
    const ghost = screen.getByTestId('ranking-drag-ghost');
    expect(within(ghost).getByTestId('ranking-rank')).toHaveTextContent('2');
    // leading 경로를 탄다는 증거 — indented(pl-10)로 폭만 맞춘 것이 아니다.
    expect(ghost).toHaveClass('pl-md');
    expect(ghost).not.toHaveClass('pl-10');
  });

  it('turns the fly-back animation off for a chart drop, and keeps it otherwise', async () => {
    const hitTest = (clientX: number) => clientX < 800; // x<800 = 차트 위
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
      renderDrawer();
      await screen.findByText('삼성전자');

      // (1) 차트 위 드롭 — activator(900,300) + delta(-500,0) = (400,300) → 술어 true.
      act(() => { dnd.onDragStart!(DRAG_START); });
      act(() => {
        dnd.onDragEnd!({
          ...DRAG_START,
          activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
          delta: { x: -500, y: 0 },
        });
      });
      expect(dnd.dropAnimation).toBeNull();

      // (2) 차트 밖 드롭 → 기본 애니메이션(원위치 복귀)이 남는다.
      act(() => { dnd.onDragStart!(DRAG_START); });
      act(() => {
        dnd.onDragEnd!({
          ...DRAG_START,
          activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
          delta: { x: 0, y: 0 },
        });
      });
      expect(dnd.dropAnimation).not.toBeNull();
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('freezes the row list while a drag is in flight, and catches up after it ends', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    const { qc } = renderDrawer();
    await screen.findByText('삼성전자');
    const rowNames = () =>
      screen.getAllByRole('button', { name: /차트 열기/ }).map((li) => li.getAttribute('aria-label'));
    expect(rowNames()[0]).toContain('HDC현대산업개발');
    const key = ['live-rankings', 'change', 'all', 'up', false, 'KRX'];

    act(() => { dnd.onDragStart!(DRAG_START); });
    // 드래그 도중 10초 폴링이 착지해 순위가 통째로 갈린다.
    await act(async () => {
      qc.setQueryData(key, {
        rows: [{ rank: 1, code: '000660', name: 'SK하이닉스', price: 180000, change_pct: 12.3 }],
        marketOpen: true,
        fetchedAtMs: 1_700_000_001_000,
      });
    });
    // 캐시 갱신만으로는 이 시점에 리렌더가 보장되지 않는다(react-query 알림이 배치된다).
    // 그래서 **행 목록에 영향이 없는 상호작용**으로 리렌더를 확정적으로 일으킨 뒤 잰다 —
    // 우클릭은 행 메뉴 state 만 건드린다. 이 강제 리렌더가 없으면 동결을 제거해도 통과
    // 하는 가짜 가드가 된다(관심종목에서 red-check 로 실제로 확인한 함정이다).
    fireEvent.contextMenu(screen.getByTestId('ranking-row-005930'));
    expect(rowNames()[0]).toContain('HDC현대산업개발');   // 얼어 있다

    act(() => {
      dnd.onDragEnd!({ ...DRAG_START, activatorEvent: null, delta: { x: 0, y: 0 } });
    });
    await waitFor(() => expect(rowNames()[0]).toContain('SK하이닉스'));
  });
});
