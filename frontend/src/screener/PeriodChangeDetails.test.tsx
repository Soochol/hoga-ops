import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ScreenerRow } from '../api/screener';
import type { OccurrenceExclusions } from './useOccurrenceExclusions';
import { PeriodChangeButton, usePeriodChangeDetails } from './PeriodChangeDetails';

it('opens only period change events, preserves bar identity and follows refreshed scan results', () => {
  const exclude = vi.fn();
  const activate = vi.fn();
  const controller: OccurrenceExclusions = { conditions: [
    { id: 'period', type: 'change_pct_period', params: { lookback: 20, op: 'gte', pct: 10 } },
    { id: 'latest', type: 'change_pct', params: { op: 'gte', pct: 10 } },
  ], exclusions: [], busy: false, ready: true, error: null, lastExcluded: null,
  exclude, restore: vi.fn(), affectedOtherRows: () => 0 };
  const row: ScreenerRow = { code: '005930', name: '삼성전자', market: 'KOSPI', price: 110,
    trade_value_won: 1e8, change_pct: 10, occurrences: [
      { condition_id: 'period', condition_key: 'key', date: '2026-07-28', bar_start_ms: 1785200700000,
        bar_change_match: { timeframe: '5m', change_reference: 'previous_bar', change_pct: 10, close: 110,
          reference_close: 100, reference_start_ms: 1, is_open: false, fetched_at_ms: 1 } },
      { condition_id: 'latest', condition_key: 'latest', date: '2026-07-27' },
    ] };
  function Host({ row }: { row: ScreenerRow }) {
    const details = usePeriodChangeDetails([row], controller);
    return <div onClick={activate}>
      <PeriodChangeButton row={row} periodConditionIds={details.conditionIds} onPeriodDetails={details.onOpen} />
      {details.modal}
    </div>;
  }
  const { rerender } = render(<Host row={row} />);
  fireEvent.click(screen.getByRole('button', { name: '삼성전자 기간내 등락률 발생 1건' }));
  expect(activate).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog', { name: '삼성전자 발생 건' });
  expect(dialog).toHaveTextContent('전일 종가 대비 ≥ 10%');
  expect(dialog).toHaveTextContent('직전 봉 종가 대비 10% · 종가 110원 · 기준 100원');
  expect(dialog).not.toHaveTextContent('2026-07-27');
  fireEvent.click(screen.getByRole('button', { name: /발생 건 제외/ }));
  expect(exclude).toHaveBeenCalledWith(row.code, row.name, row.occurrences![0]);
  rerender(<Host row={{ ...row, occurrences: row.occurrences!.slice(1) }} />);
  expect(screen.getByRole('dialog')).toHaveTextContent('현재 검색 결과에 남은 발생 건이 없습니다.');
});
