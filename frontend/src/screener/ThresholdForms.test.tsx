import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ChangePctParams, ScanRequest, ScreenerOccurrence, TradeValuePeriodOptions } from '../api/screener';
import { isHistoricalCondition, screenerRequestKey } from '../api/screenerRequest';
import { ChangePctForm } from './conditions/change_pctForm';
import { TradeValuePeriodForm } from './conditions/trade_value_periodForm';
import { BarMatchEvidence } from './BarMatchEvidence';
import { occurrenceTimeLabel } from './occurrenceTime';

const choice = (label: string, name: string) => within(screen.getByRole('group', { name: label })).getByRole('button', { name });

function AmountEditor({ initial }: { initial: TradeValuePeriodOptions }) {
  const [params, setParams] = useState(initial);
  return <><TradeValuePeriodForm params={params} onChange={setParams} /><output>{JSON.stringify(params)}</output></>;
}

it('preserves amount/timeframe/open policy when switching recent/date modes', () => {
  render(<AmountEditor initial={{ timeframe: '5m', include_open_bar: true, min_eok: 123, lookback: 7 }} />);
  fireEvent.click(choice('거래대금 검색 기간', '날짜 범위'));
  expect(screen.getByLabelText('분봉 간격')).toHaveValue('5m');
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('"timeframe":"5m"');
  fireEvent.change(screen.getByLabelText('거래대금 발생 시작일'), { target: { value: '2026-07-01' } });
  fireEvent.click(choice('봉 주기', '월'));
  expect(screen.getByLabelText('거래대금 발생 시작일')).toHaveValue('2026-07-01');
  fireEvent.click(choice('거래대금 검색 기간', '최근 N봉'));
  expect(choice('봉 주기', '월')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('최소 거래대금(억)')).toHaveValue(123);
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('"include_open_bar":true');
});

it('keeps legacy daily collection distinct from explicitly selected candle dates', () => {
  const params = { mode: 'date_range' as const, start_date: '2019-01-01', end_date: '2022-12-31', min_eok: 100 };
  const condition = { id: 'amount', type: 'trade_value_period' as const, params };
  expect(isHistoricalCondition(condition)).toBe(true);
  const changed = { ...condition, params: { ...params, timeframe: 'D' as const, include_open_bar: true } };
  expect(isHistoricalCondition(changed)).toBe(false);
  expect(screenerRequestKey({ conditions: [condition], universe: {} })).not.toBe(
    screenerRequestKey({ conditions: [changed], universe: {} }));
  render(<AmountEditor initial={params} />);
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
  fireEvent.click(choice('봉 주기', '주'));
  fireEvent.click(choice('봉 주기', '일'));
  expect(screen.getByRole('status')).toHaveTextContent('"timeframe":"D"');
  expect(screen.getByRole('status')).toHaveTextContent('"include_open_bar":true');
  expect(screen.getByLabelText('거래대금 발생 종료일')).toHaveValue('2022-12-31');
});

function ChangeEditor() {
  const [params, setParams] = useState<ChangePctParams>({ op: 'gte', pct: 5, timeframe: 'W',
    include_open_bar: true, change_reference: 'previous_bar' });
  return <><ChangePctForm params={params} onChange={setParams} /><output>{JSON.stringify(params)}</output></>;
}

it('keeps reference and candle settings across operator changes and permits rates beyond daily price limits', () => {
  render(<ChangeEditor />);
  fireEvent.click(choice('등락률 연산', '범위'));
  fireEvent.change(screen.getByLabelText('등락률 하한(%)'), { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText('등락률 상한(%)'), { target: { value: '150' } });
  expect(screen.getByLabelText('등락률 상한(%)')).not.toHaveAttribute('max');
  expect(screen.getByRole('status')).toHaveTextContent('"hi":150');
  fireEvent.change(screen.getByLabelText('등락률 비교 기준'), { target: { value: 'bar_open' } });
  fireEvent.click(choice('등락률 연산', '이하 ≤'));
  expect(choice('봉 주기', '주')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('"include_open_bar":true');
  expect(screen.getByLabelText('등락률 비교 기준')).toHaveValue('bar_open');
});

it('normalizes legacy change defaults while preserving each reference choice', () => {
  const request = (params: ChangePctParams): ScanRequest => ({ universe: {},
    conditions: [{ id: 'change', type: 'change_pct', params }] });
  const legacy = screenerRequestKey(request({ op: 'gte', pct: 5 }));
  expect(screenerRequestKey(request({ op: 'gte', pct: 5, timeframe: 'D', include_open_bar: true,
    change_reference: 'previous_day' }))).toBe(legacy);
  for (const reference of ['previous_bar', 'bar_open'] as const) {
    expect(screenerRequestKey(request({ op: 'gte', pct: 5, change_reference: reference }))).not.toBe(legacy);
  }
});

it('shows estimated amount and reference-specific rate evidence with minute timestamps', () => {
  const event: ScreenerOccurrence = { condition_id: 'change', condition_key: 'change', date: '2026-07-30',
    bar_start_ms: Date.parse('2026-07-30T10:05:00+09:00'), bar_change_match: {
      timeframe: '5m', change_reference: 'bar_open', change_pct: 10, close: 1100, reference_close: 1000,
      reference_start_ms: 0, is_open: true, fetched_at_ms: 1 } };
  expect(occurrenceTimeLabel(event)).toBe('2026-07-30 10:05');
  const { rerender } = render(<BarMatchEvidence event={event} />);
  expect(screen.getByText(/해당 봉 시가 대비 10%/)).toHaveTextContent('기준 1,000원');
  rerender(<BarMatchEvidence event={{ ...event, bar_change_match: undefined, bar_trade_value_match: {
    timeframe: 'W', trade_value_won: 1.5e8, method: 'daily_estimate_sum', is_open: false, fetched_at_ms: 1 } }} />);
  expect(screen.getByText('1.5억 추정 · 일별 추정치 합계 · 완료')).toBeInTheDocument();
});
