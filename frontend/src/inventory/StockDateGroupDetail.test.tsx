import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { StockDateGroupDetail } from './StockDateGroupDetail';
import { useTabsStore } from '../state/tabs';
import type { StockDate } from '../api/types';

const navigateMock = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

const row = (code: string, name: string, date: string): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: 1000,
  total_volume: 52_100_000, pages_collected: 1240, file_size_bytes: 13_200_000,
  today_open: 70_000, today_high: 73_000, today_low: 69_000, today_close: 72_400,
  disk_state: 'complete',
});

const rows: StockDate[] = [
  row('005930', '삼성전자', '20260522'),
  row('005930', '삼성전자', '20260521'),
  row('000660', 'SK하이닉스', '20260521'),
];

function renderWithRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('StockDateGroupDetail', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useTabsStore.setState({ tabs: [] });
  });

  it('renders the selected group header (code + name + summary)', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="005930" />);
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText(/2 dates/)).toBeTruthy();
  });

  it('renders one row per date, sorted desc', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="005930" />);
    const dateCells = screen.getAllByText(/2026-05-\d{2}/);
    expect(dateCells.map(el => el.textContent)).toEqual(['2026-05-22', '2026-05-21']);
  });

  it('shows placeholder when selectedCode is null', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode={null} />);
    expect(screen.getByText('종목을 선택하세요')).toBeTruthy();
  });

  it('falls back to first group when selectedCode is not in rows', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="999999" />);
    // All captured_at=1000, so insertion order preserved by stable sort.
    // 005930 inserted first → first in groups[] → fallback target.
    expect(screen.getByText('005930')).toBeTruthy();
  });

  it('row click opens a new tab and navigates to /replay', () => {
    renderWithRouter(<StockDateGroupDetail rows={rows} selectedCode="005930" />);
    fireEvent.click(screen.getByText('2026-05-22'));
    expect(navigateMock).toHaveBeenCalledWith('/replay');
    const { tabs, activeTabId } = useTabsStore.getState();
    expect(tabs).toHaveLength(1);
    const created = tabs.find(t => t.id === activeTabId)!;
    expect(created.selection).toMatchObject({
      code: '005930',
      fromDate: '20260522',
      toDate: '20260522',
      timeframe: '1m',
    });
  });
});

// 컬럼별로 값이 분명히 다른 행 셋
const sortableRows: StockDate[] = [
  { ...row('005930', '삼성전자', '20260522'), total_volume: 30, today_close: 72_000, captured_at: 3_000 },
  { ...row('005930', '삼성전자', '20260521'), total_volume: 10, today_close: 70_000, captured_at: 1_000 },
  { ...row('005930', '삼성전자', '20260520'), total_volume: 20, today_close: 71_000, captured_at: 2_000 },
];

describe('StockDateGroupDetail column sorting', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useTabsStore.setState({ tabs: [] });
  });

  function getDateOrder(): string[] {
    return screen.getAllByText(/2026-05-\d{2}/).map(el => el.textContent ?? '');
  }

  it('default order is date desc (unchanged from current behavior)', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-21', '2026-05-20']);
  });

  it('clicking Volume header sorts by volume desc, then asc, then back to default', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    const volumeHeader = screen.getByRole('button', { name: /volume/i });

    fireEvent.click(volumeHeader); // desc → volume 30/20/10 → dates 22/20/21
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-20', '2026-05-21']);

    fireEvent.click(volumeHeader); // asc → volume 10/20/30 → dates 21/20/22
    expect(getDateOrder()).toEqual(['2026-05-21', '2026-05-20', '2026-05-22']);

    fireEvent.click(volumeHeader); // unsorted → default date desc
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-21', '2026-05-20']);
  });

  it('clicking a different header jumps to that column desc', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    fireEvent.click(screen.getByRole('button', { name: /volume/i })); // volume desc
    fireEvent.click(screen.getByRole('button', { name: /ohlc/i }));   // ohlc desc
    // today_close desc: 72_000(22), 71_000(20), 70_000(21)
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-20', '2026-05-21']);
  });

  it('aria-sort attribute reflects current sort state', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    const volumeHeader = screen.getByRole('button', { name: /volume/i });
    const th = volumeHeader.closest('th')!;

    expect(th.getAttribute('aria-sort')).toBe('none');
    fireEvent.click(volumeHeader);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(volumeHeader);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(volumeHeader);
    expect(th.getAttribute('aria-sort')).toBe('none');
  });

  it('preserves sort state across selectedCode changes (session-lifetime)', () => {
    const twoCodeRows: StockDate[] = [
      ...sortableRows,
      { ...row('000660', 'SK하이닉스', '20260522'), total_volume: 5, today_close: 100_000, captured_at: 4_000 },
      { ...row('000660', 'SK하이닉스', '20260521'), total_volume: 50, today_close: 99_000, captured_at: 5_000 },
    ];
    const { rerender } = renderWithRouter(
      <StockDateGroupDetail rows={twoCodeRows} selectedCode="005930" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /volume/i })); // volume desc on 005930
    expect(getDateOrder()).toEqual(['2026-05-22', '2026-05-20', '2026-05-21']);

    // Swap selected code — same component instance, prop change only
    rerender(
      <MemoryRouter>
        <StockDateGroupDetail rows={twoCodeRows} selectedCode="000660" />
      </MemoryRouter>,
    );
    // 000660 has 2 rows with vol 5(22) and 50(21); volume desc -> 50 first -> date 21 first
    expect(getDateOrder()).toEqual(['2026-05-21', '2026-05-22']);
  });

  it('header click does not trigger row click (no navigation)', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    fireEvent.click(screen.getByRole('button', { name: /volume/i }));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('OHLC header has tooltip explaining it sorts by close', () => {
    renderWithRouter(<StockDateGroupDetail rows={sortableRows} selectedCode="005930" />);
    const ohlcHeader = screen.getByRole('button', { name: /ohlc/i });
    expect(ohlcHeader.getAttribute('title')).toMatch(/종가/);
  });
});
