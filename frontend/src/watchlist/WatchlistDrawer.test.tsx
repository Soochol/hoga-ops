import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
import { useLiveTabsStore } from '../state/liveTabs';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';

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

// 005930 in folder 스윙, 000660 in 미분류 — exercises folder grouping.
const FOLDERS = [{ id: 'f_0000000a', name: '스윙', order: 0 }];
const ENTRIES = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
];
const DATA = { folders: FOLDERS, entries: ENTRIES, next_run_at_ms: 0 };

describe('WatchlistDrawer', () => {
  beforeEach(() => {
    cleanup();
    // 접기 토글이 watchlist.collapsed를 영속하므로 매 테스트 격리 필수 —
    // 없으면 접기를 수행한 테스트가 이후 테스트의 행 가시성을 오염시킨다.
    window.localStorage.clear();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
    vi.restoreAllMocks();
    // useQuoteByCode → useQuotes → getQuotes → apiCall('/api/live/quotes')
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
  });

  it('renders folder groups (스윙 / 미분류) with their entries', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByTestId('watchlist-row-005930')).toBeInTheDocument());
    expect(screen.getByText(/스윙/)).toBeInTheDocument();
    expect(screen.getByText(/미분류/)).toBeInTheDocument();
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('clicking a row sets activeCode and navigates to /live when elsewhere', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByTestId('watchlist-row-005930')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('Ctrl-clicking a row opens the symbol in a new focused live tab', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByText('삼성전자'), { ctrlKey: true });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '005930']);
    expect(tabs[1]).toMatchObject({ code: '005930', label: '삼성전자' });
    expect(activeTabId).toBe(tabs[1].id);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('Meta-clicking a row opens the symbol in a new focused live tab', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    useLiveTabsStore.setState({
      tabs: [{
        id: 'tab-a',
        code: '000660',
        label: 'SK하이닉스',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: null,
      }],
      activeTabId: 'tab-a',
    });
    useLivePageStore.setState({ activeCode: '000660', candleTimeframe: '1m', historicalFromDate: null });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    fireEvent.click(screen.getByText('삼성전자'), { metaKey: true });

    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '005930']);
    expect(tabs[1]).toMatchObject({ code: '005930', label: '삼성전자' });
    expect(activeTabId).toBe(tabs[1].id);
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('shows empty message when no entries and no folders', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ folders: [], entries: [], next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText(/관심종목이 없습니다/)).toBeInTheDocument());
  });

  it('highlights the active code', async () => {
    useLivePageStore.setState({ activeCode: '000660' });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/capture') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.getByTestId('watchlist-row-000660').getAttribute('aria-current')).toBe('true');
  });

  it('renders live price (원) and 전일대비 from useQuotes', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('72,400원')).toBeInTheDocument());
    expect(screen.getByText('+850원 (1.20%)')).toBeInTheDocument();
    expect(screen.getByText('-1,500원 (0.80%)')).toBeInTheDocument();
  });

  it('cycles a folder sort mode by clicking the group sort icon', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      ...DATA,
      entries: [
        { ...ENTRIES[0], folder_id: 'f_0000000a', order: 0 },
        { ...ENTRIES[1], folder_id: 'f_0000000a', order: 1 },
      ],
    });
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

    await waitFor(() => expect(screen.getByLabelText('스윙 정렬')).toBeInTheDocument());
    const rowCodes = () => screen.getAllByTestId(/^watchlist-row-/).map((el) =>
      el.getAttribute('data-testid')?.replace('watchlist-row-', ''));

    await waitFor(() => expect(rowCodes()).toEqual(['005930', '000660']));

    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    await waitFor(() => expect(rowCodes()).toEqual(['005930', '000660']));

    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    await waitFor(() => expect(rowCodes()).toEqual(['000660', '005930']));
  });

  it('shows a distinct sort icon for default, ascending, and descending modes', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

    await waitFor(() => expect(screen.getByLabelText('스윙 정렬')).toBeInTheDocument());
    const sortButton = screen.getByLabelText('스윙 정렬');
    const sortDescription = () =>
      document.getElementById(sortButton.getAttribute('aria-describedby') ?? '')?.textContent;

    expect(within(sortButton).getByTestId('sort-icon-default')).toBeInTheDocument();
    expect(sortDescription()).toBe('현재 기본 정렬, 클릭하면 등락률 내림차순');
    fireEvent.click(sortButton);
    expect(within(sortButton).getByTestId('sort-icon-desc')).toBeInTheDocument();
    expect(sortDescription()).toBe('현재 등락률 내림차순, 클릭하면 등락률 오름차순');
    fireEvent.click(sortButton);
    expect(within(sortButton).getByTestId('sort-icon-asc')).toBeInTheDocument();
    expect(sortDescription()).toBe('현재 등락률 오름차순, 클릭하면 기본 정렬');
    fireEvent.click(sortButton);
    expect(within(sortButton).getByTestId('sort-icon-default')).toBeInTheDocument();
    expect(sortDescription()).toBe('현재 기본 정렬, 클릭하면 등락률 내림차순');
  });

  it('sorts entries in a folder by live change rate and resets to default order', async () => {
    const folder = { id: 'f_0000000a', name: '기본', order: 0 };
    const threeEntries = {
      folders: [folder],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 1 },
        { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 2 },
      ],
      next_run_at_ms: 0,
    };
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(threeEntries);
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
        { code: '035420', price: 211000, change_pct: 3.4, change_won: 6900 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

    await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());

    const rowCodes = () => screen.getAllByTestId(/^watchlist-row-/).map((el) =>
      el.getAttribute('data-testid')?.replace('watchlist-row-', ''));

    expect(rowCodes()).toEqual(['005930', '000660', '035420']);

    fireEvent.click(screen.getByLabelText('기본 정렬'));
    expect(rowCodes()).toEqual(['035420', '005930', '000660']);

    fireEvent.click(screen.getByLabelText('기본 정렬'));
    expect(rowCodes()).toEqual(['000660', '005930', '035420']);

    fireEvent.click(screen.getByLabelText('기본 정렬'));
    expect(rowCodes()).toEqual(['005930', '000660', '035420']);
  });

  it('sorts each folder independently by change rate', async () => {
    const folders = [
      { id: 'f_0000000a', name: '스윙', order: 0 },
      { id: 'f_0000000b', name: '장기', order: 1 },
    ];
    const multiFolderEntries = {
      folders,
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
        { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 0 },
        { code: '051910', name: 'LG화학', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 1 },
      ],
      next_run_at_ms: 0,
    };
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(multiFolderEntries);
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
        { code: '035420', price: 211000, change_pct: 2.1, change_won: 2100 },
        { code: '051910', price: 560000, change_pct: -1.5, change_won: -2000 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    const swingSection = screen.getByTestId('watchlist-group-f_0000000a');
    const longSection = screen.getByTestId('watchlist-group-f_0000000b');

    const swingSort = within(swingSection).getByLabelText('스윙 정렬');
    const longSort = within(longSection).getByLabelText('장기 정렬');
    fireEvent.click(swingSort);
    fireEvent.click(swingSort);

    // 장기 그룹은 별도 순환만 한 번 수행.
    fireEvent.click(longSort);

    const swing = screen.getByTestId('watchlist-group-f_0000000a');
    const long = screen.getByTestId('watchlist-group-f_0000000b');
    const toCodes = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('[data-testid^="watchlist-row-"]'))
        .map((el) => (el.getAttribute('data-testid') ?? '').replace('watchlist-row-', ''))
        .filter((code) => code !== '');

    const swingCodes = toCodes(swing);
    const longCodes = toCodes(long);

    expect(swingCodes).toEqual(['000660', '005930']);
    expect(longCodes).toEqual(['035420', '051910']);
  });

  it('initializes each folder sort mode from legacy storage when not individually saved', async () => {
    window.localStorage.setItem('watchlist.sortMode.v1', JSON.stringify({ sortMode: 'change_pct_desc' }));
    const folders = [
      { id: 'f_0000000a', name: '스윙', order: 0 },
      { id: 'f_0000000b', name: '장기', order: 1 },
    ];
    const multiFolderEntries = {
      folders,
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
        { code: '051910', name: 'LG화학', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 0 },
        { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000b', order: 1 },
      ],
      next_run_at_ms: 0,
    };
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(multiFolderEntries);
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
        { code: '051910', price: 560000, change_pct: -1.5, change_won: -2000 },
        { code: '035420', price: 211000, change_pct: 2.1, change_won: 2100 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByLabelText('스윙 정렬')).toBeInTheDocument());

    const swing = screen.getByTestId('watchlist-group-f_0000000a');
    const long = screen.getByTestId('watchlist-group-f_0000000b');
    const toCodes = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('[data-testid^="watchlist-row-"]'))
        .map((el) => (el.getAttribute('data-testid') ?? '').replace('watchlist-row-', ''))
        .filter((code) => code !== '');
    expect(toCodes(swing)).toEqual(['005930', '000660']);
    expect(toCodes(long)).toEqual(['035420', '051910']);

    fireEvent.click(within(swing).getByLabelText('스윙 정렬'));
    fireEvent.click(within(swing).getByLabelText('스윙 정렬'));
    expect(toCodes(swing)).toEqual(['005930', '000660']);
    expect(toCodes(long)).toEqual(['035420', '051910']);
  });

  it('falls back to default sort mode when persisted mode is invalid', async () => {
    window.localStorage.setItem('watchlist.sortMode.v1', JSON.stringify({ sortMode: 'nonsense' }));
    const folder = { id: 'f_0000000a', name: '기본', order: 0 };
    const threeEntries = {
      folders: [folder],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 1 },
        { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 2 },
      ],
      next_run_at_ms: 0,
    };
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(threeEntries);
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
        { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
        { code: '035420', price: 211000, change_pct: 3.4, change_won: 6900 },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

    const rowCodes = () => screen.getAllByTestId(/^watchlist-row-/).map((el) =>
      el.getAttribute('data-testid')?.replace('watchlist-row-', ''));

    // invalid persisted mode should not affect ordering (default)
    await waitFor(() => expect(rowCodes()).toEqual(['005930', '000660', '035420']));
    fireEvent.click(screen.getByLabelText('기본 정렬'));
    expect(screen.getAllByTestId(/^watchlist-row-/).map((el) =>
      el.getAttribute('data-testid')?.replace('watchlist-row-', ''))
      .at(0)).toBe('035420');
  });

  it('right-click opens the context menu; 관심 해제 removes the entry and closes', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const notCancelled = fireEvent.contextMenu(screen.getByTestId('watchlist-row-005930'));
    expect(notCancelled).toBe(false);  // preventDefault suppresses native menu
    fireEvent.click(screen.getByTestId('watchlist-menu-remove'));
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
    expect(screen.queryByTestId('watchlist-row-menu')).toBeNull();
  });

  it('Delete key on a focused row removes the entry', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.keyDown(screen.getByTestId('watchlist-row-000660'), { key: 'Delete' });
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('000660'));
  });

  it('opens the edit modal via 편집 → 관심 편집', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByLabelText('관심종목 편집 메뉴')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('관심종목 편집 메뉴'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '관심 편집' }));
    expect(await screen.findByRole('dialog', { name: '관심종목 편집' })).toBeInTheDocument();
    // 메뉴는 항목 선택과 동시에 닫힌다
    expect(screen.queryByRole('menuitem', { name: '관심 편집' })).toBeNull();
  });

  it('새 그룹 만들기 creates a folder through the 그룹 추가하기 dialog', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const createSpy = vi.spyOn(watchlistApi, 'createFolder')
      .mockResolvedValue({ id: 'f_new', name: '단타', order: 1 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByLabelText('관심종목 편집 메뉴')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('관심종목 편집 메뉴'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '새 그룹 만들기' }));
    expect(await screen.findByRole('dialog', { name: '그룹 추가하기' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('그룹 이름 입력'), { target: { value: '단타' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith('단타'));
    // 생성 후 다이얼로그는 닫힌다
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '그룹 추가하기' })).toBeNull());
  });

  it('그룹 헤더 ⋯ → 그룹 이름 변경 renames via the dialog', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const renameSpy = vi.spyOn(watchlistApi, 'renameFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('스윙 그룹 메뉴'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /그룹 이름 변경/ }));
    const input = await screen.findByPlaceholderText('그룹 이름 입력');
    expect((input as HTMLInputElement).value).toBe('스윙');   // 현재 이름이 미리 채워진다
    fireEvent.change(input, { target: { value: '단타' } });
    fireEvent.click(screen.getByRole('button', { name: '변경' }));
    await waitFor(() => expect(renameSpy).toHaveBeenCalledWith('f_0000000a', '단타'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '그룹 이름 변경' })).toBeNull());
  });

  it('그룹 헤더 ⋯ → 그룹 삭제 deletes the folder (고아 확인 후, v3)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const deleteSpy = vi.spyOn(watchlistApi, 'deleteFolder').mockResolvedValue();
    // v3 파괴적 삭제(ADR-0070 P6): 고아가 생기면 확인 — 테스트는 확인 수락.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('스윙 그룹 메뉴'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /그룹 삭제/ }));
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('f_0000000a'));
    confirmSpy.mockRestore();
  });

  it('우클릭 → 그룹 편집 opens the group picker (v3)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByTestId('watchlist-row-000660'));
    fireEvent.click(screen.getByTestId('watchlist-menu-edit-groups'));
    expect(screen.getByRole('menu', { name: '내 관심 그룹' })).toBeInTheDocument();
    expect(screen.queryByTestId('watchlist-row-menu')).toBeNull();   // 행 메뉴 닫힘
  });

  it('접기 상태가 localStorage에 영속되어 리마운트에도 유지된다', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('미분류 접기'));
    expect(screen.queryByText('SK하이닉스')).toBeNull();
    unmount();
    // 리마운트(패널 재오픈에 해당) — 접기 상태가 localStorage에서 복원된다
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.queryByText('SK하이닉스')).toBeNull();
  });

  it('그룹 헤더 ⋯ → 아래로 이동 reorders folders (full ordered_ids)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_0000000a', name: '스윙', order: 0 },
        { id: 'f_0000000b', name: '장기', order: 1 },
      ],
      entries: ENTRIES,
      next_run_at_ms: 0,
    });
    const reorderSpy = vi.spyOn(watchlistApi, 'reorderFolders').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('스윙 그룹 메뉴'));
    // 첫 그룹: 위로 이동은 disabled, 아래로 이동은 동작
    expect(await screen.findByRole('menuitem', { name: /위로 이동/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: /아래로 이동/ }));
    await waitFor(() =>
      expect(reorderSpy).toHaveBeenCalledWith(['f_0000000b', 'f_0000000a']));
  });

  it('미분류 헤더에는 ⋯ 메뉴가 없고 접기 토글만 있다', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.queryByLabelText('미분류 그룹 메뉴')).toBeNull();
    // chevron(접기)으로 접으면 행이 사라진다
    fireEvent.click(screen.getByLabelText('미분류 접기'));
    expect(screen.queryByText('SK하이닉스')).toBeNull();
  });

  it('개수가 라벨 버튼 안에 인라인 — 접근성 이름이 "스윙 1"이고 클릭하면 접힌다', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    // 개수(1)가 라벨 버튼 내부 자식이면 접근성 이름은 "스윙 1"로 합성된다.
    // 우측 정렬 mono 개수(가격 컬럼과 충돌)가 사라졌음을 보장하는 구조 단언.
    fireEvent.click(screen.getByRole('button', { name: '스윙 1' }));
    expect(screen.queryByText('삼성전자')).toBeNull();
    // 미분류 그룹(SK하이닉스)은 영향 없음
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('실폴더의 chevron 버튼으로도 접힌다 (라벨 버튼과 별개 토글 경로)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('스윙 접기'));
    expect(screen.queryByText('삼성전자')).toBeNull();
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('엔트리가 없는 실폴더도 개수 0으로 렌더된다 (빈 미분류만 숨김)', async () => {
    // 스윙 폴더는 존재하나 소속 엔트리 없음 — groupByFolder가 실폴더를 항상 노출.
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: FOLDERS,
      entries: [{ code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '스윙 0' })).toBeInTheDocument();
  });

  it('그룹 추가하기 disables 추가 while the name is empty', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByLabelText('관심종목 편집 메뉴')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('관심종목 편집 메뉴'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '새 그룹 만들기' }));
    await screen.findByRole('dialog', { name: '그룹 추가하기' });
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
  });

  // ADR-0067: 관심종목 행 수집상태 배지
  it('행 종목이 live_set에 있으면 그 행에 "실시간" 배지를 표시한다', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['live', 'status'], {
      running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy',
      watchlist_count: 2, kis_calls_today: 0, kis_rate_limit_remaining: null,
      live_set: ['005930', '000660'],
    });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const row005930 = screen.getByTestId('watchlist-row-005930');
    expect(row005930.querySelector('[data-testid="collection-dot-realtime"]')).toBeInTheDocument();
  });

  it('live_set 밖 + watchlist에 있고 안 보는 중이면 waiting_eod 점만 표시한다', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['live', 'status'], {
      running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy',
      watchlist_count: 2, kis_calls_today: 0, kis_rate_limit_remaining: null,
      live_set: [],  // 둘 다 live_set 밖
    });
    // activeCode = null → viewedCodes = [] → 둘 다 waiting_eod
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const row005930 = screen.getByTestId('watchlist-row-005930');
    expect(row005930.querySelector('[data-testid="collection-dot-waiting_eod"]')).toBeInTheDocument();
    expect(row005930.textContent).not.toContain('저녁대기');
    expect(row005930.getAttribute('aria-label')).toContain('관심종목 대기 중');
    const row000660 = screen.getByTestId('watchlist-row-000660');
    expect(row000660.querySelector('[data-testid="collection-dot-waiting_eod"]')).toBeInTheDocument();
    expect(row000660.textContent).not.toContain('저녁대기');
    expect(row000660.getAttribute('aria-label')).toContain('관심종목 대기 중');
  });

  it('renders WS/API/excluded/waiting storage labels per row', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_enabled', name: '저장', order: 0, capture_enabled: true },
        { id: 'f_excluded', name: '제외', order: 1, capture_enabled: false },
      ],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: '20260621', folder_id: 'f_enabled', order: 0, capture_candidate: true },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_enabled', order: 1, capture_candidate: true },
        { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_enabled', order: 2, capture_candidate: true },
        { code: '051910', name: 'LG화학', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_excluded', order: 0, capture_candidate: false },
      ],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['live', 'status'], {
      running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy',
      watchlist_count: 4, kis_calls_today: 0, kis_rate_limit_remaining: null,
      live_set: ['005930'],
      storage_policy: 'ws_plus_rest',
      kis_api_running: true,
      kis_api_targets: ['000660'],
      kis_api_target_count: 1,
      kis_api_last_cycle_ms: null,
      kis_api_last_error: null,
      kis_api_last_error_count: 0,
      kis_api_degraded: false,
    });

    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    expect(screen.getByTestId('watchlist-row-005930')).toHaveTextContent('KIS WS 저장 중');
    expect(screen.getByTestId('watchlist-row-000660')).toHaveTextContent('KIS API 30초 저장 중');
    expect(screen.getByTestId('watchlist-row-035420')).toHaveTextContent('대기');
    expect(screen.getByTestId('watchlist-row-051910')).toHaveTextContent('저장 제외');
  });

  it('uses backend-projected capture candidate for storage label', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_enabled', name: '저장', order: 0, capture_enabled: true },
        { id: 'f_excluded', name: '제외', order: 1, capture_enabled: false },
        { id: 'f_legacy', name: '기존', order: 2 },
      ],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_excluded', order: 0, capture_candidate: true },
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_enabled', order: 0, capture_candidate: true },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_legacy', order: 0, capture_candidate: true },
      ],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['live', 'status'], {
      running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
      capture_healthy: true, capture_reason: 'healthy',
      watchlist_count: 2, kis_calls_today: 0, kis_rate_limit_remaining: null,
      live_set: [],
      storage_policy: 'ws_plus_rest',
      kis_api_running: true,
      kis_api_targets: [],
      kis_api_target_count: 0,
      kis_api_last_cycle_ms: null,
      kis_api_last_error: null,
      kis_api_last_error_count: 0,
      kis_api_degraded: false,
    });

    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getAllByTestId('watchlist-row-005930')).toHaveLength(2));

    for (const row of screen.getAllByTestId('watchlist-row-005930')) {
      expect(row).toHaveTextContent('대기');
      expect(row).not.toHaveTextContent('저장 제외');
    }
    expect(screen.getByTestId('watchlist-row-000660')).toHaveTextContent('대기');
  });
});
