import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { ScreenerDrawer } from './ScreenerDrawer';
import { useLivePageStore } from '../state/livePage';
import { useScreenerPanelStore } from '../state/screenerPanel';
import * as savesApi from '../api/savedScreeners';
import * as screenerApi from '../api/screener';

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
    useLivePageStore.setState({ activeCode: null } as any);
    useScreenerPanelStore.setState({ selectedSavedId: null, lastScan: null });
    vi.restoreAllMocks();
    vi.spyOn(screenerApi, 'getScreenerStatus').mockResolvedValue({ status: 'ok', last_raw_date: '20260530', days_behind: 0 });
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
});
