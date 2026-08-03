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

describe('가상화 임계', () => {
  const mkRows = (n: number): ScreenerRowLive[] =>
    Array.from({ length: n }, (_, i) => ({
      code: String(100000 + i), name: `종목${i}`, market: 'KOSPI',
      price: 1000 + i, change_pct: 0, trade_value_won: 1e10,
    } as ScreenerRowLive));

  it('임계 이하면 평면 렌더 — 모든 행이 DOM 에 있다', () => {
    const { container } = render(withClient(
      <ResultTable rows={mkRows(5)} onActivate={vi.fn()} />,
    ));
    expect(container.querySelector('[data-testid="screener-result-rows"]')!
      .getAttribute('data-virtualized')).toBe('false');
    expect(container.querySelectorAll('[aria-label*="호가창 열기"]').length).toBe(5);
  });

  it('임계를 넘으면 가상 렌더로 전환한다', () => {
    // jsdom 에는 레이아웃이 없어 **행 수**는 검증할 수 없다(가상화기가 0행을 그린다).
    // 여기서는 전환 여부만 보고, 실제 렌더·스크롤·잘림은 e2e 가 본다
    // (`screener-results-virtualized.spec.ts`). CaptureQueue 의 가상화 테스트도 같은
    // 이유로 `data-virtualized` 속성만 확인한다.
    const { container } = render(withClient(
      <ResultTable rows={mkRows(201)} onActivate={vi.fn()} />,
    ));
    expect(container.querySelector('[data-testid="screener-result-rows"]')!
      .getAttribute('data-virtualized')).toBe('true');
  });

  describe('기준시각 돌파 배지', () => {
    const v = {
      ask_today: null, ask_past_peak: null, ask_have_days: 0, ask_need_days: 0,
      bid_today: null, bid_past_peak: null, bid_have_days: 0, bid_need_days: 0,
      ask_pre_max: 1012716, ask_post_max: 2489755, ask_renewal_start_hhmm: 1200,
    };
    const renderWith = (sides: { ask: boolean; bid: boolean; askRenewal?: boolean; bidRenewal?: boolean }) =>
      render(withClient(
        <ResultTable rows={rows} onActivate={vi.fn()} sortMode="default" onSortChange={vi.fn()}
          depthValues={{ '005930': v }} depthSides={sides} />,
      ));

    it('조건이 켜져 있으면 이전→이후 최댓값을 보여준다', () => {
      renderWith({ ask: false, bid: false, askRenewal: true });
      expect(screen.getByText('12:00')).toBeInTheDocument();
      expect(screen.getByText('1,012,716→2,489,755')).toBeInTheDocument();
    });

    it('조건이 없으면 배지를 그리지 않는다 — 값이 실려 와도', () => {
      renderWith({ ask: false, bid: false });
      expect(screen.queryByText('12:00')).not.toBeInTheDocument();
    });

    it('매수 조건이면 매수 값만 — 매도 값이 실려 와도 새지 않는다', () => {
      const both = { ...v, bid_pre_max: 500, bid_post_max: 900, bid_renewal_start_hhmm: 1300 };
      render(withClient(
        <ResultTable rows={rows} onActivate={vi.fn()} sortMode="default" onSortChange={vi.fn()}
          depthValues={{ '005930': both }} depthSides={{ ask: false, bid: false, bidRenewal: true }} />,
      ));
      expect(screen.getByText('500→900')).toBeInTheDocument();
      expect(screen.queryByText('1,012,716→2,489,755')).not.toBeInTheDocument();
    });

    it('양쪽 다 켜지면 side 라벨과 **각자의 기준시각**을 단다', () => {
      const both = { ...v, bid_pre_max: 500, bid_post_max: 900, bid_renewal_start_hhmm: 1300 };
      render(withClient(
        <ResultTable rows={rows} onActivate={vi.fn()} sortMode="default" onSortChange={vi.fn()}
          depthValues={{ '005930': both }}
          depthSides={{ ask: false, bid: false, askRenewal: true, bidRenewal: true }} />,
      ));
      expect(screen.getByText('매도')).toBeInTheDocument();
      expect(screen.getByText('매수')).toBeInTheDocument();
      // 시각이 섞이면 한쪽이 남의 시각을 달게 된다 — 둘 다 자기 것을 보여야 한다.
      expect(screen.getByText('12:00')).toBeInTheDocument();
      expect(screen.getByText('13:00')).toBeInTheDocument();
    });

    it('peak 조건만 켜져 있으면 peak 배지만 — 두 숫자가 섞이지 않는다', () => {
      const mixed = { ...v, ask_today: 2489755, ask_past_peak: 951284, ask_need_days: 20, ask_have_days: 20 };
      render(withClient(
        <ResultTable rows={rows} onActivate={vi.fn()} sortMode="default" onSortChange={vi.fn()}
          depthValues={{ '005930': mixed }} depthSides={{ ask: true, bid: false }} />,
      ));
      expect(screen.getByText('2,489,755/951,284')).toBeInTheDocument();   // peak 배지
      expect(screen.queryByText('1,012,716→2,489,755')).not.toBeInTheDocument();  // 돌파 배지 없음
    });
  });
});
