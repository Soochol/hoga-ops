import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ResultTable } from './ResultTable';
import type { ScreenerResultSortMode } from './sortResults';
import type { ScreenerRowLive } from './useScreenerRowsLive';

vi.mock('../watchlist/WatchlistHeartButton', () => ({
  WatchlistHeartButton: () => <button type="button" aria-label="관심 그룹 편집" />,
}));

const rows: ScreenerRowLive[] = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8, change_won: null },
];

/** ResultTable 이 useWatchlistMembership 을 (행마다가 아니라) 한 번 부르므로
 *  QueryClientProvider 가 필요하다. */
function withClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], { folders: [], entries: [], next_run_at_ms: 0 });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function renderTable(sortMode: ScreenerResultSortMode = 'default', onSortChange = vi.fn()) {
  render(withClient(
    <ResultTable rows={rows} onActivate={vi.fn()} sortMode={sortMode} onSortChange={onSortChange} />,
  ));
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

  it('동시호가 예상체결 행: 예 마커 + 예상가(예상등락률)로 대체 표시한다', () => {
    const expected: ScreenerRowLive[] = [
      {
        code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200,
        trade_value_won: 842_000_000_000, change_pct: 5.8, change_won: null,
        expected_price: 71500, expected_change_pct: 2.14,
      },
    ];
    render(withClient(<ResultTable rows={expected} onActivate={vi.fn()} sortMode="default" onSortChange={vi.fn()} />));
    const row = screen.getByRole('button', { name: '삼성전자 005930 호가창 열기' });
    // 마커('예')와 값이 같은 셀 안 — 마커의 부모 span textContent 로 대조한다.
    const cell = within(row).getByText('예').parentElement;
    expect(cell).toHaveTextContent('71,500 (+2.14%)');
    expect(within(row).queryByText(/74,200/)).not.toBeInTheDocument(); // 확정가는 표시 안 함
    // 대신 직전 체결가를 title 로 보존한다(표에도 두 숫자를 둘 폭이 없다).
    expect(cell).toHaveAttribute('title', '예상 71,500 · 직전 체결 74,200');
  });

  it('renders — for a row with no live quote (price null) without crashing', () => {
    // 라이브 미도착 행: 순수 라이브라 price/change_pct 가 null → 셀은 '—' 하나.
    const noQuote: ScreenerRowLive[] = [
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: null, trade_value_won: 6e11, change_pct: null, change_won: null },
    ];
    render(withClient(<ResultTable rows={noQuote} onActivate={vi.fn()} sortMode="default" onSortChange={vi.fn()} />));
    const row = screen.getByRole('button', { name: 'SK하이닉스 000660 호가창 열기' });
    expect(within(row).getByText('—')).toBeInTheDocument();
  });
});
