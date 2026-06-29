import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ResultTable } from './ResultTable';
import type { ScreenerResultSortMode } from './sortResults';
import type { ScreenerRowLive } from './useScreenerRowsLive';

vi.mock('../watchlist/WatchlistHeartButton', () => ({
  WatchlistHeartButton: () => <button type="button" aria-label="관심 그룹 편집" />,
}));

const rows: ScreenerRowLive[] = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8, change_won: null, change_pct_sort: 5.8 },
];

function renderTable(sortMode: ScreenerResultSortMode = 'default', onSortChange = vi.fn()) {
  render(<ResultTable rows={rows} onActivate={vi.fn()} sortMode={sortMode} onSortChange={onSortChange} />);
  return onSortChange;
}

describe('ResultTable', () => {
  it('requests ascending sort when clicking an unsorted data header', () => {
    const onSortChange = renderTable();

    fireEvent.click(screen.getByRole('button', { name: '현재가 정렬' }));

    expect(onSortChange).toHaveBeenCalledWith({ field: 'price', direction: 'asc' });
  });

  it('cycles the active header from ascending to descending to default', () => {
    const onSortChange = renderTable({ field: 'code', direction: 'asc' });

    const codeHeader = screen.getByRole('button', { name: '코드 정렬' });
    expect(within(codeHeader).getByText('▲')).toBeInTheDocument();
    fireEvent.click(codeHeader);

    expect(onSortChange).toHaveBeenCalledWith({ field: 'code', direction: 'desc' });
  });

  it('does not make the action column sortable', () => {
    renderTable();

    expect(screen.queryByRole('button', { name: '액션 정렬' })).not.toBeInTheDocument();
    expect(screen.getByText('액션')).toBeInTheDocument();
  });

  it('renders price and change percent together in one quote cell', () => {
    renderTable();

    const row = screen.getByRole('button', { name: '삼성전자 005930 호가창 열기' });
    expect(within(row).getByText('74,200 (+5.80%)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '등락률 정렬' })).not.toBeInTheDocument();
  });
});
