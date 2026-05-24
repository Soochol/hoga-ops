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
