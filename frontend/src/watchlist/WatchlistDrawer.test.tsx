import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';
import type { DragEndEvent } from '@dnd-kit/core';

// vi.mock 팩토리는 호이스팅됨 → 캡처 슬롯도 vi.hoisted 로 만들어야 안전.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as undefined | ((e: DragEndEvent) => void) }));

// DndContext 를 패스스루로 모킹하고 주입된 onDragEnd 를 캡처. SortableContext 도
// 패스스루(실제 DndContext provider 가 없으니). useSortable 은 default context 로
// graceful 하게 동작(setNodeRef noop) → 행은 정상 렌더.
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: { onDragEnd?: (e: DragEndEvent) => void; children: React.ReactNode }) => {
      dnd.onDragEnd = props.onDragEnd;
      return props.children;
    },
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return { ...actual, SortableContext: (props: { children: React.ReactNode }) => props.children };
});

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

const ENTRIES = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null },
];

describe('WatchlistDrawer', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
  });

  it('renders entries from the API', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('clicking a row sets activeCode and navigates to /live when elsewhere', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('clicking a row on /live sets activeCode without changing route', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/live') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SK하이닉스'));
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(screen.getByTestId('pathname').textContent).toBe('/live');
  });

  it('shows empty message when no entries', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: [], next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText(/관심종목이 없습니다/)).toBeInTheDocument());
  });

  it('highlights the active code regardless of route', async () => {
    useLivePageStore.setState({ activeCode: '000660' });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/capture') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.getByTestId('watchlist-row-000660').getAttribute('aria-current')).toBe('true');
  });

  it('renders live price (원) and 전일대비 from useQuotes', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
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

  it('shows — for a code missing from quotes (장전/무데이터)', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking a row trash icon removes it from the watchlist', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const trash = within(screen.getByTestId('watchlist-row-005930')).getByRole('button', { name: '삼성전자 관심종목 해제' });
    fireEvent.click(trash);
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });
});

describe('WatchlistDrawer drag reorder', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    dnd.onDragEnd = undefined;
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
  });

  it('calls reorderWatchlist with the new code order on drag end', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderWatchlist')
      .mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    await waitFor(() => expect(dnd.onDragEnd).toBeTypeOf('function'));
    // drag 005930(삼성전자) onto 000660(SK하이닉스) → 새 순서 [000660, 005930]
    dnd.onDragEnd!({ active: { id: '005930' }, over: { id: '000660' } } as DragEndEvent);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(['000660', '005930']));
  });

  it('does not call reorderWatchlist when dropped in place', async () => {
    const spy = vi.spyOn(watchlistApi, 'reorderWatchlist')
      .mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(dnd.onDragEnd).toBeTypeOf('function'));
    dnd.onDragEnd!({ active: { id: '005930' }, over: { id: '005930' } } as DragEndEvent);
    expect(spy).not.toHaveBeenCalled();
  });
});
