import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
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
    vi.restoreAllMocks();
    // useQuoteByCode → useQuotes → getQuotes → apiCall('/api/live/quotes')
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
  });

  it('renders folder groups (스윙 / 미분류) with their entries', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.getByText(/스윙/)).toBeInTheDocument();
    expect(screen.getByText(/미분류/)).toBeInTheDocument();
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('clicking a row sets activeCode and navigates to /live when elsewhere', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
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

  it('opens a group sort menu with default, ascending, and descending choices', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

    await waitFor(() => expect(screen.getByLabelText('스윙 정렬')).toBeInTheDocument());
    expect(screen.getByLabelText('스윙 정렬')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('관심종목 편집 메뉴')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('스윙 정렬'));
    expect(screen.getByLabelText('스윙 정렬')).toHaveAttribute('aria-expanded', 'true');

    expect(await screen.findByRole('menu', { name: '정렬' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: '기본' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: '등락률 오름차순' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: '등락률 내림차순' })).toHaveAttribute('aria-checked', 'false');
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
    fireEvent.click(await screen.findByRole('menuitemradio', { name: '등락률 오름차순' }));
    expect(rowCodes()).toEqual(['000660', '005930', '035420']);

    fireEvent.click(screen.getByLabelText('기본 정렬'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: '등락률 내림차순' }));
    expect(rowCodes()).toEqual(['035420', '005930', '000660']);

    fireEvent.click(screen.getByLabelText('기본 정렬'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: '기본' }));
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

    fireEvent.click(within(swingSection).getByLabelText('스윙 정렬'));
    fireEvent.click(await within(swingSection).findByRole('menuitemradio', { name: '등락률 내림차순' }));

    // 장기 그룹은 기본 정렬을 유지해 분리 동작을 확인한다.
    fireEvent.click(within(longSection).getByLabelText('장기 정렬'));
    fireEvent.click(await within(longSection).findByRole('menuitemradio', { name: '등락률 내림차순' }));
    fireEvent.click(within(longSection).getByLabelText('장기 정렬'));
    fireEvent.click(await within(longSection).findByRole('menuitemradio', { name: '등락률 오름차순' }));

    const swing = screen.getByTestId('watchlist-group-f_0000000a');
    const long = screen.getByTestId('watchlist-group-f_0000000b');
    const toCodes = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('[data-testid^="watchlist-row-"]'))
        .map((el) => (el.getAttribute('data-testid') ?? '').replace('watchlist-row-', ''))
        .filter((code) => code !== '');

    const swingCodes = toCodes(swing);
    const longCodes = toCodes(long);

    expect(swingCodes).toEqual(['005930', '000660']);
    expect(longCodes).toEqual(['051910', '035420']);
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
    expect(await within(swing).findByRole('menuitemradio', { name: '등락률 내림차순' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(long).getByLabelText('장기 정렬'));
    expect(await within(long).findByRole('menuitemradio', { name: '등락률 내림차순' })).toHaveAttribute('aria-checked', 'true');
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
    expect(await screen.findByRole('menuitemradio', { name: '기본' })).toHaveAttribute('aria-checked', 'true');
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

  it('live_set 밖 + watchlist에 있고 안 보는 중이면 "저녁대기" 배지를 표시한다 (waiting_eod)', async () => {
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
    expect(row005930.textContent).toContain('저녁대기');
    const row000660 = screen.getByTestId('watchlist-row-000660');
    expect(row000660.textContent).toContain('저녁대기');
  });
});
