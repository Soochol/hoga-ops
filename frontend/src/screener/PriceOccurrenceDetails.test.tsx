import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ScreenerRow } from '../api/screener';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';
import { PriceOccurrenceButtons, usePriceOccurrenceDetails } from './PriceOccurrenceDetails';

it('opens only period change events, preserves bar identity and follows refreshed scan results', () => {
  const exclude = vi.fn();
  const activate = vi.fn();
  const controller: OccurrenceExclusions = { conditions: [
    { id: 'period', type: 'change_pct_period', params: { lookback: 20, op: 'gte', pct: 10 } },
    { id: 'latest', type: 'change_pct', params: { op: 'gte', pct: 10 } },
    { id: 'compare', type: 'price_compare', params: {
      left: { offset: 0, source: 'close' }, right: { offset: 1, source: 'high' }, relation: 'gt' } },
  ], exclusions: [], busy: false, ready: true, error: null, lastExcluded: null,
  exclude, restore: vi.fn(), affectedOtherRows: () => 0 };
  const row: ScreenerRow = { code: '005930', name: '삼성전자', market: 'KOSPI', price: 110,
    trade_value_won: 1e8, change_pct: 10, occurrences: [
      { condition_id: 'period', condition_key: 'key', date: '2026-07-28', bar_start_ms: 1785200700000,
        bar_change_match: { timeframe: '5m', change_reference: 'previous_bar', change_pct: 10, close: 110,
          reference_close: 100, reference_start_ms: 1, is_open: false, fetched_at_ms: 1 } },
      { condition_id: 'latest', condition_key: 'latest', date: '2026-07-27' },
      { condition_id: 'compare', condition_key: 'compare', date: '2026-07-29', bar_start_ms: 1785287100000,
        bar_price_compare_match: { timeframe: '5m', relation: 'gt', is_open: true, fetched_at_ms: 1,
          left: { offset: 0, source: 'close', value: 110, bar_start_ms: 1785287100000, is_open: true },
          right: { offset: 1, source: 'high', value: 100, bar_start_ms: 1785286800000, is_open: false } } },
    ] };
  function Host({ row }: { row: ScreenerRow }) {
    const details = usePriceOccurrenceDetails([row], controller);
    return <div onClick={activate}>
      <PriceOccurrenceButtons row={row} occurrenceKinds={details.conditionKinds} onOccurrenceDetails={details.onOpen} />
      {details.modal}
    </div>;
  }
  const { rerender } = render(<Host row={row} />);
  fireEvent.click(screen.getByRole('button', { name: '삼성전자 주가 비교 발생 1건' }));
  expect(activate).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent('0봉 전 종가 110원 > 1봉 전 고가 100원');
  expect(screen.getByRole('dialog')).toHaveTextContent('진행 중');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('직전 봉 종가 대비');
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  activate.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '삼성전자 기간내 등락률 발생 1건' }));
  expect(activate).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog', { name: '삼성전자 발생 건' });
  expect(dialog).toHaveTextContent('전일 종가 대비 ≥ 10%');
  expect(dialog).toHaveTextContent('직전 봉 종가 대비 10% · 종가 110원 · 기준 100원');
  expect(dialog).not.toHaveTextContent('2026-07-27');
  expect(dialog).not.toHaveTextContent('2026-07-29');
  fireEvent.click(screen.getByRole('button', { name: /발생 건 제외/ }));
  expect(exclude).toHaveBeenCalledWith(row.code, row.name, row.occurrences![0]);
  rerender(<Host row={{ ...row, occurrences: row.occurrences!.slice(1) }} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('현재 검색 결과에 남은 발생 건이 없습니다.');
});
