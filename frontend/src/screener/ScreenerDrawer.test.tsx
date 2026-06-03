import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { ScreenerDrawer } from './ScreenerDrawer';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore } from '../state/screenerPanel';
import * as savesApi from '../api/savedScreeners';
import * as screenerApi from '../api/screener';
import * as client from '../api/client';
import * as watchlistApi from '../api/watchlist';

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

function qc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('ScreenerDrawer', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useLivePageStore.setState({ activeCode: null });
    useScreenerPanelStore.setState({ selectedSavedId: null, lastScan: null });
    vi.restoreAllMocks();
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'ok', last_raw_date: '20260530', days_behind: 0 });
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ folders: [], entries: [], next_run_at_ms: 0 });
  });

  it('lists saved screeners in the dropdown', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByRole('option', { name: '돌파+거래대금' })).toBeInTheDocument());
  });

  it('defaults selection to the first save and 조회 scans with its conditions', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(scan).toHaveBeenCalledWith({ conditions: SAVE.conditions, universe: SAVE.universe }));
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
  });

  it('clicking a result row sets activeCode and navigates to /live from elsewhere', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('disables 조회 when status is not_seeded', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'not_seeded' });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/시드 필요/)).toBeInTheDocument());
    expect((screen.getByRole('button', { name: '조회' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an empty message and disables 조회 when there are no saves', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/저장된 조건이 없습니다/)).toBeInTheDocument());
    expect((screen.getByRole('button', { name: '조회' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders results from the store without re-scanning (persist across reopen)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(scan).not.toHaveBeenCalled();
  });

  it('preserves a persisted non-first selection when saves load', async () => {
    const SAVE2 = { ...SAVE, id: 's2', name: '두번째조건' };
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE, SAVE2] });
    useScreenerPanelStore.setState({ selectedSavedId: 's2', lastScan: null });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByRole('option', { name: '두번째조건' })).toBeInTheDocument());
    expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s2');
  });

  it('갱신 triggers a screener data update', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const upd = vi.spyOn(screenerApi, 'triggerScreenerUpdate').mockResolvedValue(undefined as never);
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '데이터 갱신' }));
    await waitFor(() => expect(upd).toHaveBeenCalled());
  });

  it('shows 조회 실패 when the scan errors', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockRejectedValue(new Error('boom'));
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(screen.getByText('조회 실패')).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows the empty-result message when a scan returns no rows', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: [], warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(screen.getByText('조건에 맞는 종목이 없습니다.')).toBeInTheDocument());
  });

  it('clicking a result on /live sets activeCode without navigating away', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows: ROWS, warnings: [] });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SK하이닉스'));
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(screen.getByTestId('pathname').textContent).toBe('/live');
  });

  it('flags when the dropdown selection differs from the last scan', async () => {
    const SAVE2 = { ...SAVE, id: 's2', name: '두번째조건' };
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE, SAVE2] });
    useScreenerPanelStore.setState({
      selectedSavedId: 's2',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText(/선택한 조건과 다름/)).toBeInTheDocument());
  });

  it('overlays live price + 전일대비 on result rows, overriding corpus pct', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{ code: '005930', price: 72400, change_pct: 3.4, change_won: 2380 }],
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('72,400원')).toBeInTheDocument()); // live price
    expect(screen.getByText('+2,380원 (3.40%)')).toBeInTheDocument();             // live 전일대비+pct (not corpus)
    expect(screen.getByTestId('screener-row-005930')).toBeInTheDocument();        // testid preserved (regression)
  });

  it('clicking a non-member row heart adds it to the watchlist', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const addSpy = vi.spyOn(watchlistApi, 'addToWatchlist').mockResolvedValue({
      code: '005930', name: '삼성전자', registered_at_kst_date: '20260602', last_success_date: null,
      folder_id: null, order: 0,
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    const heart = within(screen.getByTestId('screener-row-005930')).getByRole('button', { name: '관심종목 추가' });
    fireEvent.click(heart);
    await waitFor(() => expect(addSpy).toHaveBeenCalledWith('005930'));
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('falls back to the corpus price when a row has no live quote (no —)', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    // live quote only for 005930 → 000660 has no quote and must show its corpus price.
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{ code: '005930', price: 72400, change_pct: 3.4, change_won: 2380 }],
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('72,400원')).toBeInTheDocument()); // live price (005930)
    expect(screen.getByText('180,000원')).toBeInTheDocument();                     // corpus price (000660), not —
  });

  it('surfaces 갱신 실패 when the update mutation errors', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'triggerScreenerUpdate').mockRejectedValue(new Error('boom'));
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '데이터 갱신' }));
    await waitFor(() => expect(screen.getByText(/갱신 실패/)).toBeInTheDocument());
  });

  it('clicking a member row heart removes it from the watchlist', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      folders: [],
      entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 }],
      next_run_at_ms: 0,
    });
    const removeSpy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined);
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    const heart = await waitFor(() =>
      within(screen.getByTestId('screener-row-005930')).getByRole('button', { name: '관심종목 해제' }),
    );
    fireEvent.click(heart);
    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith('005930'));
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
      const codes = (path.split('codes=')[1] ?? '').split(',').filter(Boolean);
      return Promise.resolve({
        phase: 'open',
        quotes: codes.map((c) => ({ code: c, price: 99999, change_pct: 7.7, change_won: 5000 })),
      });
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows, scanStatus: 'ok', warnings: [] },
    });
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    // 행은 EOD(1,000원)로 먼저 렌더되고 라이브 quote 가 비동기로 덮는다. cap 이
    // 살아있다면 100030 은 요청조차 안 돼 영영 1,000원 — 99,999원 도달이 cap 제거 증명.
    await waitFor(() =>
      expect(within(screen.getByTestId('screener-row-100030')).getByText('99,999원')).toBeInTheDocument(),
    );
  });
});
