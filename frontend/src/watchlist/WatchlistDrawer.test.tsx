import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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
    // folder headers render as "▾ 스윙" / "▾ 미분류" (collapse glyph), so match loosely
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
});
