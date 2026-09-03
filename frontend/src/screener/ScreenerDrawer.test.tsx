import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore, type PanelScan } from '../state/screenerPanel';
import { useScreenerUpdateFeedback } from './useScreenerUpdateSync';
import { useEntryDragStore } from '../state/entryDrag';
import { useLiveVenueStore } from '../state/liveVenue';
import * as savesApi from '../api/savedScreeners';
import * as screenerApi from '../api/screener';
import * as client from '../api/client';
import * as watchlistApi from '../api/watchlist';

type DndHandlers = {
  onDragStart: null | ((e: unknown) => void);
  onDragMove: null | ((e: unknown) => void);
  onDragEnd: null | ((e: unknown) => void);
  onDragCancel: null | (() => void);
  /** 마지막 렌더에서 DragOverlay 가 받은 dropAnimation. null = 낙하 애니메이션 끔. */
  dropAnimation: unknown;
};

const dnd = vi.hoisted<DndHandlers>(() => ({
  onDragStart: null,
  onDragMove: null,
  onDragEnd: null,
  onDragCancel: null,
  dropAnimation: undefined,
}));

vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragStart,
      onDragMove,
      onDragEnd,
      onDragCancel,
    }: {
      children: React.ReactNode;
      onDragStart?: (e: unknown) => void;
      onDragMove?: (e: unknown) => void;
      onDragEnd?: (e: unknown) => void;
      onDragCancel?: () => void;
    }) => {
      dnd.onDragStart = onDragStart ?? null;
      dnd.onDragMove = onDragMove ?? null;
      dnd.onDragEnd = onDragEnd ?? null;
      dnd.onDragCancel = onDragCancel ?? null;
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
    useDraggable: () => ({
      setNodeRef: () => {},
      listeners: {} as DraggableSyntheticListeners,
      attributes: {} as DraggableAttributes,
      transform: null,
      isDragging: false,
    }),
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});

import { ScreenerDrawer } from './ScreenerDrawer';

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function wrap(qc: QueryClient, initial: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <LocationProbe />
        <Routes><Route path="*" element={null} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const SAVE = {
  id: 's1', name: '돌파+거래대금',
  conditions: [{ id: 'c1', type: 'trade_value' as const, params: { min_eok: 100 } }],
  universe: { exclude_etf: true },
  created_at_ms: 0, updated_at_ms: 0,
};
const ROWS = [
  { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 2.1 },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: -1.2 },
];
function makeScan(overrides: Partial<PanelScan> = {}): PanelScan {
  return {
    savedId: 's1',
    savedName: '돌파+거래대금',
    savedUpdatedAtMs: 0,
    scanKey: null,
    rows: ROWS,
    scanStatus: 'ok',
    warnings: [],
    depthValues: null,
    scannedAtMs: Date.now(),
    basis: 'intraday',
    dataStale: false,
    ...overrides,
  };
}

function qc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function sortButton() {
  return screen.getByRole('button', { name: '스크리너 결과 정렬' });
}

function liveQuoteCodesFromPath(path: string): string[] {
  const url = new URL(path, 'http://localhost');
  return (url.searchParams.get('codes') ?? '').split(',').filter(Boolean);
}

describe('ScreenerDrawer', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    dnd.onDragStart = null;
    dnd.onDragMove = null;
    dnd.onDragEnd = null;
    dnd.onDragCancel = null;
    dnd.dropAnimation = undefined;
    useEntryDragStore.setState({ draggingCode: null, overChart: false, hitTestChart: null });
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
    useLiveVenueStore.setState({ venue: 'KRX' });
    useScreenerPanelStore.setState({
      selectedSavedId: null,
      lastScan: null,
      updateState: { status: 'idle' },
      sortMode: 'default',
      monitoringActive: false,
      monitorPeriodMs: null,
    });
    useScreenerUpdateFeedback.setState({ feedback: null });
    vi.restoreAllMocks();
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'ok', last_raw_date: '20260530', days_behind: 0 });
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ folders: [], entries: [], memos: [], next_run_at_ms: 0 });
  });

  it('lists saved screeners in the dropdown', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    expect(screen.getByTestId('screener-panel')).toHaveClass('bg-bg');
    // 경계선 없는 표면(2026-07-22 C안) + 페이지 필드와 동일 톤(2026-07-29 배경 통일 완결).
    expect(screen.getByTestId('screener-panel')).not.toHaveClass('border-l');
    // 커스텀 드롭다운: 트리거가 선택된 조건명을 보여주고, 열면 option 목록이 뜬다.
    const trigger = await screen.findByRole('button', { name: '저장한 조건검색 선택' });
    expect(trigger).toHaveTextContent('돌파+거래대금');
    fireEvent.click(trigger);
    expect(screen.getByRole('option', { name: '돌파+거래대금' })).toBeInTheDocument();
  });

  it('defaults selection to the first save and 시작 scans with its conditions', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(scan).toHaveBeenCalledWith({
      conditions: SAVE.conditions,
      universe: SAVE.universe,
      basis: 'intraday',
    }));
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
  });

  it('시작 버튼: 모니터링을 켜고 즉시 1회 조회한다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));

    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));

    await waitFor(() => expect(useScreenerPanelStore.getState().monitoringActive).toBe(true));
    await waitFor(() => expect(scan).toHaveBeenCalled());          // 시작 즉시 1회 조회
    expect(screen.getByTestId('screener-monitor-status')).toHaveTextContent('실시간 · 30초');
  });

  it('시작: 이전 결과를 즉시 비우고 조회 중을 보여준 뒤 새 결과로 채운다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    // 응답을 손으로 풀어 "조회 왕복 중" 구간을 관측 가능하게 만든다.
    let release: (() => void) | null = null;
    const NEW_ROWS = [
      { code: '035420', name: 'NAVER', market: 'KOSPI' as const, price: 210000, trade_value_won: 3e11, change_pct: 0.3 },
    ];
    vi.spyOn(screenerApi, 'runScan').mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ status: 'ok', rows: NEW_ROWS, warnings: [] });
      }),
    );
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    // saves 가 로드돼야 시작 버튼이 enable 된다 — 안 기다리면 disabled 버튼을 눌러
    // 아무 일도 안 일어난 채 단언만 통과하는 위양성이 된다.
    await waitFor(() => expect(screen.getByTestId('screener-monitor-toggle')).toBeEnabled());

    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 새 검색

    // 옛 리스트가 조회 왕복 동안 남지 않는다. 빈 화면이 '결과 0건'으로 오독되지 않게
    // 조회 중임을 명시한다.
    await waitFor(() => expect(screen.queryByText('삼성전자')).not.toBeInTheDocument());
    expect(screen.getByText('조회 중…')).toBeInTheDocument();
    expect(screen.queryByText('조건에 맞는 종목이 없습니다')).not.toBeInTheDocument();
    expect(useScreenerPanelStore.getState().lastScan).toBeNull();

    await act(async () => { release?.(); });
    await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());
    expect(screen.queryByText('조회 중…')).not.toBeInTheDocument();
  });

  it('초기화 후 첫 결과는 신규 편입 플래시를 걸지 않는다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('screener-monitor-toggle')).toBeEnabled());
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 초기화 + 재조회
    // 재조회가 실제로 돌아 결과가 다시 채워진 뒤를 본다(초기화만 된 상태를 보면 위양성).
    await waitFor(() => expect(scan).toHaveBeenCalled());
    await waitFor(() => expect(useScreenerPanelStore.getState().lastScan).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('screener-row-005930')).toBeInTheDocument());

    // 멤버십은 그대로다(같은 조건 재조회) — 리스트를 지웠다는 이유로 전 종목이
    // 신규 편입처럼 반짝이면 안 된다.
    expect(screen.getByTestId('screener-row-005930').className).not.toContain('flash');
    expect(screen.getByTestId('screener-row-000660').className).not.toContain('flash');
  });

  it('드롭다운으로 조건을 바꾸면 이전 조건의 결과를 즉시 버린다', async () => {
    const SAVE2 = { ...SAVE, id: 's2', name: '두번째조건' };
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE, SAVE2] });
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '저장한 조건검색 선택' })).toHaveTextContent('돌파+거래대금'));

    fireEvent.click(screen.getByRole('button', { name: '저장한 조건검색 선택' }));
    fireEvent.click(screen.getByRole('option', { name: '두번째조건' }));

    await waitFor(() => expect(useScreenerPanelStore.getState().lastScan).toBeNull());
    expect(screen.queryByText('삼성전자')).not.toBeInTheDocument();
    expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s2');
  });

  it('주기 선택: 30초 클릭 시 상태 텍스트와 스토어가 갱신된다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));

    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작(SAVE 는 스코프 없음 → 자동 30초)
    await waitFor(() => expect(useScreenerPanelStore.getState().monitoringActive).toBe(true));
    const status = screen.getByTestId('screener-monitor-status');
    expect(status).toHaveTextContent('실시간 · 30초');

    fireEvent.click(within(status).getByRole('button', { name: '10초' }));
    await waitFor(() => expect(useScreenerPanelStore.getState().monitorPeriodMs).toBe(10_000));
    expect(screen.getByTestId('screener-monitor-status')).toHaveTextContent('실시간 · 10초');
  });

  it('종료 버튼: 모니터링을 끄고 상태 표시를 감춘다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));

    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작
    await waitFor(() => expect(useScreenerPanelStore.getState().monitoringActive).toBe(true));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 종료

    await waitFor(() => expect(useScreenerPanelStore.getState().monitoringActive).toBe(false));
    expect(screen.queryByTestId('screener-monitor-status')).not.toBeInTheDocument();
  });

  it('shows that drawer scans use the intraday quote basis and surfaces EOD fallback', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({
      status: 'ok',
      rows: [],
      warnings: ['intraday_fallback_eod'],
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.queryByText('오늘 장중: 키움 시세 반영')).not.toBeInTheDocument());
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회

    await waitFor(() => expect(screen.getByText('장중 조회 불가 · 전일 확정 데이터로 표시 중')).toBeInTheDocument());
  });

  it('keeps the result summary and sort control outside the scroll body', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText('결과 2 · 돌파+거래대금')).toBeInTheDocument());
    const scrollBody = screen.getByTestId('screener-scroll');
    expect(within(scrollBody).queryByText('결과 2 · 돌파+거래대금')).not.toBeInTheDocument();
    expect(within(scrollBody).queryByRole('button', { name: '스크리너 결과 정렬' })).not.toBeInTheDocument();
    expect(sortButton()).toBeInTheDocument();
  });

  it('hides stale result controls when a later scan fails', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockRejectedValue(new Error('boom'));
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText('결과 2 · 돌파+거래대금')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '저장한 조건검색 선택' })).toHaveTextContent('돌파+거래대금'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByText('조회 실패')).toBeInTheDocument());
    expect(screen.queryByText('결과 2 · 돌파+거래대금')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '스크리너 결과 정렬' })).not.toBeInTheDocument();
  });

  it('clicking a result row sets activeCode and navigates to /live from elsewhere', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  // 결과 행의 좌측 여백. 우측 레일 네 리스트(관심·히트맵·순위·스크리너)는 종목명이
  // 같은 x 에서 시작해야 한다 — 패널을 토글할 때 이름 열이 튀지 않게. 스크리너만
  // 오래 미들여쓰기라 홀로 1.75rem 왼쪽에서 시작했다(2026-08-18 통일). 관심·히트맵과
  // 같은 QuoteRow 의 `indented` 계약을 쓰므로 여기서 재는 것은 "그 prop 이 호출부에서
  // 떨어지지 않았는가" 하나다 — 값 자체(2.5rem)의 계약은 QuoteRow.test.tsx 가 잰다.
  it('결과 행은 관심·히트맵과 같은 좌측 여백(indented)으로 종목명 시작 x 를 맞춘다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByTestId('screener-row-005930')).toBeInTheDocument());
    expect(screen.getByTestId('screener-row-005930')).toHaveClass('pl-10');
  });

  it('disables 시작 when status is not_seeded', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'not_seeded' });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/시드 필요/)).toBeInTheDocument());
    expect((screen.getByTestId('screener-monitor-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an empty message and disables 시작 when there are no saves', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/저장된 조건이 없습니다/)).toBeInTheDocument());
    expect((screen.getByTestId('screener-monitor-toggle') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders results from the store without re-scanning (persist across reopen)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(scan).not.toHaveBeenCalled();
  });

  it('sorts drawer results by displayed change_pct and restores sort after remount', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const rows = [
      { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 0.1 },
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: 0.2 },
      { code: '035420', name: 'NAVER', market: 'KOSPI' as const, price: 210000, trade_value_won: 3e11, change_pct: 0.3 },
    ];
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows, warnings: [] });
    vi.spyOn(client, 'apiCall').mockImplementation(async (path: string) => {
      const codes = liveQuoteCodesFromPath(path);
      const quoteByCode: Record<string, { price: number; change_pct: number; change_won: number }> = {
        '005930': { price: 70100, change_pct: 2.1, change_won: 100 },
        '000660': { price: 179000, change_pct: -1.2, change_won: -1000 },
        '035420': { price: 212000, change_pct: 4.4, change_won: 2000 },
      };
      return {
        phase: 'open' as const,
        quotes: codes.map((code) => ({ code, ...quoteByCode[code] })),
      };
    });

    const clientForRender = qc();
    const rendered = render(<ScreenerDrawer />, { wrapper: wrap(clientForRender, '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());

    const rowOrder = () => screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid);

    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-005930',
      'screener-row-000660',
      'screener-row-035420',
    ]));
    fireEvent.click(sortButton());
    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-035420',
      'screener-row-005930',
      'screener-row-000660',
    ]));
    fireEvent.click(sortButton());
    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-000660',
      'screener-row-005930',
      'screener-row-035420',
    ]));
    rendered.unmount();
    render(<ScreenerDrawer />, { wrapper: wrap(clientForRender, '/inventory') });

    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-000660',
      'screener-row-005930',
      'screener-row-035420',
    ]));
  });

  it('시작(및 재조회)이 사용자 정렬을 리셋하지 않는다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const rows = [
      { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 0.1 },
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: 0.2 },
      { code: '035420', name: 'NAVER', market: 'KOSPI' as const, price: 210000, trade_value_won: 3e11, change_pct: 0.3 },
    ];
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows, warnings: [] });
    vi.spyOn(client, 'apiCall').mockImplementation(async (path: string) => {
      const codes = liveQuoteCodesFromPath(path);
      const quoteByCode: Record<string, { price: number; change_pct: number; change_won: number }> = {
        '005930': { price: 70100, change_pct: 2.1, change_won: 100 },
        '000660': { price: 179000, change_pct: -1.2, change_won: -1000 },
        '035420': { price: 212000, change_pct: 4.4, change_won: 2000 },
      };
      return { phase: 'open' as const, quotes: codes.map((code) => ({ code, ...quoteByCode[code] })) };
    });
    // 사용자가 미리 등락률 내림차순 정렬을 걸어둔 상태로 시작.
    useScreenerPanelStore.setState({ sortMode: { field: 'change_pct', direction: 'desc' } });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회(scanOnce)
    await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());

    const rowOrder = () => screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid);
    // scanOnce 가 정렬을 default 로 밀지 않으므로 등락률 내림차순이 유지된다.
    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-035420',
      'screener-row-005930',
      'screener-row-000660',
    ]));
    expect(useScreenerPanelStore.getState().sortMode).toEqual({ field: 'change_pct', direction: 'desc' });
  });

  it('preserves a persisted non-first selection when saves load', async () => {
    const SAVE2 = { ...SAVE, id: 's2', name: '두번째조건' };
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE, SAVE2] });
    useScreenerPanelStore.setState({ selectedSavedId: 's2', lastScan: null });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByRole('button', { name: '저장한 조건검색 선택' })).toHaveTextContent('두번째조건'));
    expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s2');
  });

  it('status.updating(서버 job)만으로 진행 칩 표시 — 트리거 버튼 없이도 표시 유지', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({
      status: 'ok',
      last_raw_date: '20260626',
      days_behind: 1,
      updating: { done: 1200, total: 3561, started_ms: 1 },
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    const progress = await screen.findByTestId('screener-update-progress');
    expect(progress.textContent).toContain('1,200/3,561');
    // 수동 갱신 버튼은 제거됨(2026-07-12) — 갱신 트리거는 풀페이지/스케줄러 몫.
    expect(screen.queryByRole('button', { name: /갱신/ })).toBeNull();
  });

  it('shows 조회 실패 when the scan errors', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockRejectedValue(new Error('boom'));
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByText('조회 실패')).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows the empty-result message when a scan returns no rows', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: [], warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByText('조건에 맞는 종목이 없습니다')).toBeInTheDocument());
    expect(sortButton()).toBeDisabled();
  });

  it('clicking a result on /live sets activeCode without navigating away', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByTestId('screener-monitor-toggle'));   // 시작 = 즉시 조회
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SK하이닉스'));
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(screen.getByTestId('pathname').textContent).toBe('/live');
  });

  it('Ctrl-click 은 새 브라우저 탭으로 열고 현재 뷰의 종목은 그대로 둔다', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useLivePageStore.setState({
      activeInstrument: { kind: 'stock', code: '000660', label: 'SK하이닉스' },
      activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null,
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByText('삼성전자'), { ctrlKey: true });

    expect(open).toHaveBeenCalledWith('/live?code=005930', '_blank', 'noopener');
    // 현재 뷰는 건드리지 않는다 — 종목도 경로도 그대로.
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(screen.getByTestId('pathname').textContent).toBe('/inventory');
    vi.unstubAllGlobals();
  });

  it('flags when the dropdown selection differs from the last scan', async () => {
    const SAVE2 = { ...SAVE, id: 's2', name: '두번째조건' };
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE, SAVE2] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's2',
      lastScan: makeScan({ savedId: 's1' }),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/선택한 조건과 다름/)).toBeInTheDocument());
  });

  it('flags the last result when the saved screener definition changed after the scan', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({
      schema_version: 1,
      saves: [{ ...SAVE, updated_at_ms: 20 }],
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      sortMode: 'default',
      updateState: { status: 'idle' },
      lastScan: makeScan({ savedUpdatedAtMs: 10 }),
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText(/조건 저장본 변경됨/)).toBeInTheDocument());
  });

  it('flags the last result when a finished update marks data stale', async () => {
    // dataStale 마킹은 이벤트 주도(useScreenerUpdateSync, updated>0 조건)로 이동 —
    // 여기서는 드로어 몫인 '데이터 갱신됨' 힌트 렌더링만 핀한다.
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/결과 /)).toBeInTheDocument());

    act(() => useScreenerPanelStore.getState().markLastScanDataStale());

    await waitFor(() => expect(screen.getByText(/데이터 갱신됨/)).toBeInTheDocument());
  });

  it('overlays live price + 전일대비 on result rows, overriding corpus pct', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{ code: '005930', price: 72400, change_pct: 3.4, change_won: 2380 }],
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('72,400')).toBeInTheDocument()); // live quote (원 제거, 분리 컬럼)
    expect(screen.getByText('+3.40%')).toBeInTheDocument();
    expect(screen.queryByText('+2,380원 (3.40%)')).not.toBeInTheDocument();                 // no change-won line
    expect(screen.getByTestId('screener-row-005930')).toBeInTheDocument();        // testid preserved (regression)
  });

  it('right-clicking a row opens the group menu (하트 버튼 대체)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByTestId('screener-row-005930'));
    expect(screen.getByRole('menu', { name: '삼성전자 관심 그룹' })).toBeInTheDocument();
    expect(useLivePageStore.getState().activeCode).toBeNull();   // 우클릭은 행 활성화와 무관
  });

  it('shows — for a row with no live quote (순수 라이브, EOD 코퍼스 폴백 없음)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    // live quote only for 005930 → 000660 has no quote and must show '—', not its corpus price.
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{ code: '005930', price: 72400, change_pct: 3.4, change_won: 2380 }],
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('72,400')).toBeInTheDocument()); // live quote (005930), 분리 컬럼
    expect(screen.queryByText('180,000')).not.toBeInTheDocument();               // corpus price 노출 안 함 → '—'
    const row000660 = screen.getByTestId('screener-row-000660');
    expect(within(row000660).getByText('—')).toBeInTheDocument();
  });

  it('job 실패가 두 채널(feedback + updateState)에 세팅돼도 갱신 실패 라벨은 한 번만', async () => {
    // useScreenerUpdateSync 가 job-finished-error 에서 setFeedback + setUpdateError 를
    // 둘 다 호출한다. 드로어는 error 를 단일 채널로만 렌더해야 한다(중복 라벨 버그).
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerUpdateFeedback.getState().setFeedback({
      message: '갱신 실패', tone: 'error', atMs: Date.now(), source: 'update',
    });
    useScreenerPanelStore.getState().setUpdateError('갱신 실패', Date.now());
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    expect(screen.getAllByText(/갱신 실패/)).toHaveLength(1);
  });

  // ── 갱신 중에는 「지난 실행의 결과」를 보여 주지 않는다 ──────────────────────
  //
  // 실측 신고(2026-09-03): 진행 표시가 "갱신 중 874/4,335" 인데 그 옆에 직전 실행의
  // "갱신 실패" 가 그대로 붙어 있었다. 피드백 스토어는 `onMutate` 에서만 비워지는데
  // 그건 **이 탭에서 버튼을 누른 경우만** 탄다 — 스케줄러가 서버에서 시작했거나 다른
  // 창이 시작한 실행은 그 경로를 지나지 않는다.

  function statusUpdating(done: number, total: number) {
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({
      status: 'ok', last_raw_date: '20260901', days_behind: 1,
      updating: { done, total, started_ms: Date.now() },
    });
  }

  it('갱신이 도는 동안에는 지난 실행의 결과 라벨을 감춘다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    statusUpdating(874, 4335);
    useScreenerUpdateFeedback.getState().setFeedback({
      message: '갱신 실패', tone: 'error', atMs: Date.now(), source: 'update',
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText(/갱신 중/)).toBeInTheDocument());
    expect(screen.queryByText(/갱신 실패/)).not.toBeInTheDocument();
  });

  it('모니터링 알림은 갱신 중에도 남는다 — 갱신 결과가 아니다', async () => {
    // 게이트를 출처로 좁히지 않으면 이 알림까지 삼킨다. 조회 반복 실패를 사용자에게
    // 알리는 **유일한 표면**이라(`useScreenerMonitor` 의 onAutoStop) 삼키면 안 된다.
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    statusUpdating(874, 4335);
    useScreenerUpdateFeedback.getState().setFeedback({
      message: '조회가 반복 실패해 실시간 모니터링을 종료했습니다.',
      tone: 'error', atMs: Date.now(), source: 'monitor',
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText(/갱신 중/)).toBeInTheDocument());
    expect(screen.getByText(/모니터링을 종료했습니다/)).toBeInTheDocument();
  });

  it('갱신이 끝나면 결과 라벨이 다시 보인다 — 감추는 것이지 지우는 것이 아니다', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({
      status: 'ok', last_raw_date: '20260902', days_behind: 0,
    });
    useScreenerUpdateFeedback.getState().setFeedback({
      message: '1거래일 추가됨', tone: 'info', atMs: Date.now(), source: 'update',
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText(/1거래일 추가됨/)).toBeInTheDocument());
  });

  it('a member row is pre-checked in the right-click group menu (v3)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 }],
      memos: [],
      next_run_at_ms: 0,
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByTestId('screener-row-005930'));
    // 멤버십은 watchlist 쿼리(비동기) 로드 후 반영 → aria-checked를 waitFor.
    await waitFor(() => {
      expect(screen.getByRole('menuitemcheckbox', { name: '스윙' }).getAttribute('aria-checked')).toBe('true');   // member → checked
    });
    // 멤버 행이므로 '관심 해제' 항목도 노출된다.
    expect(screen.getByTestId('quote-menu-remove-all')).toBeInTheDocument();
  });

  it('overlays live quotes on ALL result rows, not just the top 30 (cap removed)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    // 31 rows. The codes-aware mock returns a live quote only for codes that
    // actually reach the backend — so the 31st row going live proves the old
    // `.slice(0, 30)` cap is gone (capped, its code would never be requested).
    const rows = Array.from({ length: 31 }, (_, i) => ({
      code: String(100000 + i), name: `종목${i}`, market: 'KOSPI' as const,
      price: 1000, trade_value_won: 1e10, change_pct: 0.5,
    }));
    vi.spyOn(client, 'apiCall').mockImplementation((path: string) => {
      const codes = liveQuoteCodesFromPath(path);
      return Promise.resolve({
        phase: 'open',
        quotes: codes.map((c) => ({ code: c, price: 99999, change_pct: 7.7, change_won: 5000 })),
      });
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan({ rows, savedUpdatedAtMs: 0 }),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    // 순수 라이브라 행은 '—'로 먼저 렌더되고 라이브 quote 가 비동기로 채운다. cap 이
    // 살아있다면 100030 은 요청조차 안 돼 영영 '—' — 99,999원 도달이 cap 제거 증명.
    await waitFor(() =>
      expect(within(screen.getByTestId('screener-row-100030')).getByText('99,999')).toBeInTheDocument(),
    );
  });

  it('dragging a screener row over the chart changes the active code', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    const hitTest = (clientX: number) => clientX < 800;
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

      dnd.onDragStart!({
        active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
      });
      expect(useEntryDragStore.getState().draggingCode).toBe('005930');

      dnd.onDragMove!({
        active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: -500, y: 0 },
      });
      // 좌표 발행은 rAF 로 스로틀된다(useDragPointPublisher) — onDragMove 는 ref 에만
      // 적고 프레임 경계에서 한 번 내보내므로, 동기 단언은 항상 실패한다.
      await waitFor(() => expect(useEntryDragStore.getState().overChart).toBe(true));

      dnd.onDragEnd!({
        active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: -500, y: 0 },
      });

      expect(useLivePageStore.getState().activeCode).toBe('005930');
      expect(useEntryDragStore.getState().draggingCode).toBeNull();
      await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  // --- 차트로 끌어 떨구기: 고스트·낙하 애니메이션·동결 ---
  // 이 패널의 드래그는 재정렬이 아니라 **복사 제스처**다(droppable 없음, 드롭 후에도 행이
  // 남는다). 재는 것은 (1) 손에 든 것이 보이는가, (2) 성공한 드롭이 되날아가지 않는가,
  // (3) 드래그 중 발밑이 흔들리지 않는가 셋이다.
  const SCREENER_DRAG_START = {
    active: {
      id: 'screener-entry:005930',
      data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } },
    },
  };

  it('puts the dragged row on the drag ghost, and clears it when the drag ends', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.queryByTestId('screener-drag-ghost')).not.toBeInTheDocument();

    act(() => { dnd.onDragStart!(SCREENER_DRAG_START); });
    expect(screen.getByTestId('screener-drag-ghost')).toHaveTextContent('삼성전자');

    act(() => {
      dnd.onDragEnd!({ ...SCREENER_DRAG_START, activatorEvent: null, delta: { x: 0, y: 0 } });
    });
    expect(screen.queryByTestId('screener-drag-ghost')).not.toBeInTheDocument();
  });

  it('turns the fly-back animation off for a chart drop, and keeps it otherwise', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });
    const hitTest = (clientX: number) => clientX < 800;
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

      // (1) 차트 위 드롭 — activator(900,300) + delta(-500,0) = (400,300) → 술어 true.
      act(() => { dnd.onDragStart!(SCREENER_DRAG_START); });
      act(() => {
        dnd.onDragEnd!({
          ...SCREENER_DRAG_START,
          activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
          delta: { x: -500, y: 0 },
        });
      });
      expect(dnd.dropAnimation).toBeNull();

      // (2) 차트 밖 드롭 → 기본 애니메이션(원위치 복귀) 유지.
      act(() => { dnd.onDragStart!(SCREENER_DRAG_START); });
      act(() => {
        dnd.onDragEnd!({
          ...SCREENER_DRAG_START,
          activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
          delta: { x: 0, y: 0 },
        });
      });
      expect(dnd.dropAnimation).not.toBeNull();
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('freezes the result list while a drag is in flight, and catches up after it ends', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({ selectedSavedId: 's1', lastScan: makeScan() });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const rowCodes = () =>
      Array.from(document.querySelectorAll('[data-testid^="screener-row-"]'))
        .map((el) => el.getAttribute('data-testid'));
    expect(rowCodes()).toEqual(['screener-row-005930', 'screener-row-000660']);

    act(() => { dnd.onDragStart!(SCREENER_DRAG_START); });
    // 드래그 도중 모니터링 재조회가 착지해 결과가 통째로 갈린다. 스캔 결과는 zustand
    // store 라 setState 가 동기 리렌더를 부른다 — react-query 의 배치 함정이 없다.
    act(() => {
      useScreenerPanelStore.setState({
        lastScan: makeScan({
          rows: [{ code: '035420', name: 'NAVER', market: 'KOSPI', price: 211000, trade_value_won: 3e11, change_pct: 4.2 }],
        }),
      });
    });
    expect(rowCodes()).toEqual(['screener-row-005930', 'screener-row-000660']);   // 얼어 있다

    act(() => {
      dnd.onDragEnd!({ ...SCREENER_DRAG_START, activatorEvent: null, delta: { x: 0, y: 0 } });
    });
    await waitFor(() => expect(rowCodes()).toEqual(['screener-row-035420']));
  });

  it('dragging a sorted screener row over the chart keeps the row payload', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const rows = [
      { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 2.1 },
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: -1.2 },
      { code: '035420', name: 'NAVER', market: 'KOSPI' as const, price: 210000, trade_value_won: 3e11, change_pct: 4.4 },
    ];
    // 순수 라이브 정렬이므로 정렬 기준(change_pct)을 라이브 quote 로 공급한다.
    const livePct: Record<string, number> = { '005930': 2.1, '000660': -1.2, '035420': 4.4 };
    vi.spyOn(client, 'apiCall').mockImplementation(async (path: string) => ({
      phase: 'open',
      quotes: liveQuoteCodesFromPath(path).map((c) => ({ code: c, price: 1, change_pct: livePct[c] ?? 0, change_won: null })),
    }));
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan({ rows, savedUpdatedAtMs: 0 }),
    });
    const hitTest = (clientX: number) => clientX < 800;
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
      await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());

      await waitFor(() =>
        expect(within(screen.getByTestId('screener-row-035420')).getByText('+4.40%')).toBeInTheDocument(),
      );
      fireEvent.click(sortButton());
      await waitFor(() =>
        expect(screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid)).toEqual([
          'screener-row-035420',
          'screener-row-005930',
          'screener-row-000660',
        ]),
      );

      dnd.onDragStart!({
        active: { id: 'screener-entry:035420', data: { current: { type: 'screener-entry', code: '035420', name: 'NAVER' } } },
      });
      expect(useEntryDragStore.getState().draggingCode).toBe('035420');

      dnd.onDragEnd!({
        active: { id: 'screener-entry:035420', data: { current: { type: 'screener-entry', code: '035420', name: 'NAVER' } } },
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: -500, y: 0 },
      });

      expect(useLivePageStore.getState().activeCode).toBe('035420');
      await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('dropping a screener row outside the chart is a no-op', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    const hitTest = (clientX: number) => clientX < 800;
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

      dnd.onDragStart!({
        active: { id: 'screener-entry:000660', data: { current: { type: 'screener-entry', code: '000660', name: 'SK하이닉스' } } },
      });
      dnd.onDragEnd!({
        active: { id: 'screener-entry:000660', data: { current: { type: 'screener-entry', code: '000660', name: 'SK하이닉스' } } },
        activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
        delta: { x: 0, y: 0 },
      });

      expect(useLivePageStore.getState().activeCode).toBeNull();
      expect(useEntryDragStore.getState().draggingCode).toBeNull();
      expect(screen.getByTestId('pathname').textContent).toBe('/live');
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });

  it('cancelling a screener row drag clears the chart-drop state', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    dnd.onDragStart!({
      active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
    });
    useEntryDragStore.getState().setOverChart(true);
    dnd.onDragCancel!();

    expect(useEntryDragStore.getState().draggingCode).toBeNull();
    expect(useEntryDragStore.getState().overChart).toBe(false);
  });

  it('ignores non-screener drag payloads without changing chart-drop state', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    const foreign = { active: { id: 'watchlist-entry:005930', data: { current: { type: 'entry', code: '005930', name: '삼성전자' } } } };
    dnd.onDragStart!(foreign);
    dnd.onDragMove!({
      ...foreign,
      activatorEvent: { clientX: 400, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });
    dnd.onDragEnd!({
      ...foreign,
      activatorEvent: { clientX: 400, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    expect(useEntryDragStore.getState().draggingCode).toBeNull();
    expect(useEntryDragStore.getState().overChart).toBe(false);
    expect(useLivePageStore.getState().activeCode).toBeNull();
    expect(screen.getByTestId('pathname').textContent).toBe('/live');
  });

  it('ignores screener drops when the drag event has no pointer coordinates', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: makeScan(),
    });
    const hitTest = () => true;
    useEntryDragStore.getState().registerChartTarget(hitTest);
    try {
      render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
      await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

      dnd.onDragStart!({
        active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
      });
      useEntryDragStore.getState().setOverChart(true);
      dnd.onDragMove!({
        active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
        activatorEvent: null,
        delta: { x: 0, y: 0 },
      });
      dnd.onDragEnd!({
        active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
        activatorEvent: null,
        delta: { x: 0, y: 0 },
      });

      expect(useEntryDragStore.getState().draggingCode).toBeNull();
      expect(useEntryDragStore.getState().overChart).toBe(false);
      expect(useLivePageStore.getState().activeCode).toBeNull();
      expect(screen.getByTestId('pathname').textContent).toBe('/live');
    } finally {
      useEntryDragStore.getState().clearChartTarget(hitTest);
    }
  });
});
