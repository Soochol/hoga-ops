import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScreenerResults } from './ScreenerResults';
import * as csv from './exportResults';
import type { PanelScan } from '../state/screenerPanel';
import type { ScreenerRowLive } from './useScreenerRowsLive';

const scan: PanelScan = {
  savedId: null, savedName: null, savedUpdatedAtMs: null, scanKey: null,
  requestJson: '{"conditions":[{"id":"a","type":"trade_value","params":{"min_eok":10}}],"universe":{},"basis":"eod"}',
  rows: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 100, change_pct: 1, trade_value_won: 1e9, price_date: '2026-09-07' },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 200, change_pct: 2, trade_value_won: 2e9, price_date: '2026-09-07' },
  ],
  scanStatus: 'ok', warnings: [], depthValues: null, scannedAtMs: Date.now(), basis: 'eod', dataStale: false,
};
const live: ScreenerRowLive[] = scan.rows.map((r, i) => ({ ...r, price: 500 - i * 100, change_pct: 10, change_won: 10 }));

vi.mock('../watchlist/WatchlistHeartButton', () => ({ WatchlistHeartButton: () => null }));
afterEach(() => vi.restoreAllMocks());

function mount(value = scan) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], { folders: [], entries: [], next_run_at_ms: 0 });
  const activate = vi.fn();
  render(<QueryClientProvider client={qc}>
    <ScreenerResults scan={value} liveRows={live} sortMode={{ field: 'price', direction: 'asc' }}
      onSortChange={vi.fn()} onActivate={activate} />
  </QueryClientProvider>);
  return activate;
}

describe('조회 결과 활용', () => {
  it('보기별 가격을 정렬하고 조회 당시 가격의 기준일을 표시한다', () => {
    mount();
    expect(screen.getAllByRole('button', { name: /호가창 열기/ })[0]).toHaveAccessibleName('SK하이닉스 000660 호가창 열기');
    fireEvent.click(screen.getByRole('button', { name: '조회 당시' }));
    const rows = screen.getAllByRole('button', { name: /호가창 열기/ });
    expect(rows[0]).toHaveAccessibleName('삼성전자 005930 호가창 열기');
    expect(rows[0]).toHaveTextContent('100 (+1.00%)');
    expect(within(rows[0]).getByText('2026-09-07')).toBeInTheDocument();
    expect(screen.getByText(/거래대금: 조회 당시 추정치/)).toBeInTheDocument();
  });

  it('검색어로 숨겨진 선택도 보존하고 선택 CSV와 검색 결과 CSV의 범위를 구별한다', () => {
    const download = vi.spyOn(csv, 'downloadResultsCsv').mockImplementation(() => {});
    const activate = mount();
    const samsung = screen.getByRole('checkbox', { name: '삼성전자 005930 선택' });
    fireEvent.click(samsung);
    fireEvent.keyDown(samsung, { key: ' ' });
    expect(activate).not.toHaveBeenCalled();
    const search = screen.getByRole('searchbox', { name: '결과 내 종목 검색' });
    fireEvent.change(search, { target: { value: 'sk 하이닉스' } });
    expect(screen.getByText(/선택 1건 \(숨김 1건 포함\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '검색 결과 전체 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '선택 CSV' }));
    expect(download).toHaveBeenLastCalledWith(scan, ['000660', '005930'], live);
    fireEvent.click(screen.getByRole('button', { name: '검색 결과 CSV' }));
    expect(download).toHaveBeenLastCalledWith(scan, ['000660'], live);
    fireEvent.click(screen.getByRole('checkbox', { name: '검색 결과 전체 선택' }));
    expect(screen.getByText(/선택 1건 \(숨김 1건 포함\)/)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '005930' } });
    expect(screen.getByRole('checkbox', { name: '삼성전자 005930 선택' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(screen.getByRole('button', { name: '선택 CSV' })).toBeDisabled();
  });

  it('결과 내 검색 0건은 스캔 0건과 구별하고 검색어만 지워 복구한다', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '없는종목' } });
    expect(screen.getByText('검색어에 맞는 결과가 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '검색 결과 CSV' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '검색어 지우기' }));
    expect(screen.getAllByRole('button', { name: /호가창 열기/ })).toHaveLength(2);
  });

  it('기간 총잔량 배지는 실행 당시 조건을 기준으로 표시한다', () => {
    mount({ ...scan, requestJson: '{"conditions":[{"type":"ask_depth_new_high_period"}]}',
      depthValues: { '005930': {
        ask_today: 20, ask_past_peak: 10, ask_have_days: 5, ask_need_days: 5,
        bid_today: 999, bid_past_peak: 888, bid_have_days: 5, bid_need_days: 5,
      } },
    });
    expect(screen.getByText('20/10')).toBeInTheDocument();
    expect(screen.queryByText('999/888')).not.toBeInTheDocument();
  });
});
