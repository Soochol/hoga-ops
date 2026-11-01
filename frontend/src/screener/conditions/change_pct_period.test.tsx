import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ChangePctPeriodOptions, ScanRequest } from '../../api/screener';
import { isHistoricalCondition, screenerRequestKey } from '../../api/screenerRequest';
import { makeLeaf } from '../catalog';
import { change_pct_period } from './change_pct_period';

function Editor() {
  const [params, setParams] = useState<ChangePctPeriodOptions>({ lookback: 7, op: 'lte', pct: -10,
    timeframe: '5m', change_reference: 'previous_bar' });
  const Form = change_pct_period.ParamForm;
  return <><Form params={params} onChange={setParams} /><output>{JSON.stringify(params)}</output></>;
}

it('preserves period, candle and reference choices across operator and date mode changes', () => {
  render(<Editor />);
  fireEvent.change(screen.getByRole('combobox', { name: '등락률 연산' }), { target: { value: 'between' } });
  expect(screen.getByLabelText('등락률 최근 기간(봉)')).toHaveValue('7');
  fireEvent.change(screen.getByLabelText('등락률 하한(%)'), { target: { value: '-20' } });
  fireEvent.change(screen.getByLabelText('등락률 상한(%)'), { target: { value: '-10' } });
  fireEvent.change(screen.getByRole('combobox', { name: '등락률 검색 기간' }), { target: { value: 'date_range' } });
  fireEvent.change(screen.getByLabelText('등락률 발생 시작일'), { target: { value: '2026-07-01' } });
  fireEvent.change(screen.getByRole('combobox', { name: '등락률 연산' }), { target: { value: 'lte' } });
  expect(screen.getByLabelText('등락률 발생 시작일')).toHaveValue('2026-07-01');
  expect(screen.getByLabelText('등락률 비교 기준')).toHaveValue('previous_bar');
  expect(screen.getByRole('combobox', { name: '봉 주기' })).toHaveValue('5m');
  fireEvent.change(screen.getByRole('combobox', { name: '등락률 검색 기간' }), { target: { value: 'recent' } });
  expect(screen.queryByLabelText('등락률 발생 시작일')).not.toBeInTheDocument();
  expect(screen.getByLabelText('등락률 최근 기간(봉)')).toHaveValue('20');
  expect(screen.getByRole('status')).not.toHaveTextContent('start_date');
  expect(screen.getByRole('status')).not.toHaveTextContent('"lo"');
  fireEvent.change(screen.getByLabelText('등락률 최근 기간(봉)'), { target: { value: '1.5' } });
  fireEvent.blur(screen.getByLabelText('등락률 최근 기간(봉)'));
  expect(screen.getByRole('alert')).toHaveTextContent('정수로 입력하세요.');
  expect(screen.getByRole('status')).toHaveTextContent('"lookback":20');
});

it('defaults and summaries explain historical events rather than cumulative returns', () => {
  expect(makeLeaf('change_pct_period').params).toEqual({ lookback: 20, op: 'gte', pct: 10 });
  expect(change_pct_period.summarize({ lookback: 20, op: 'lte', pct: -10 }))
    .toBe('일봉 · 최근 20봉 이내 · 전일 종가 대비 ≤ -10%');
  expect(change_pct_period.summarize({ mode: 'date_range', start_date: '2026-07-01', end_date: '2026-07-31',
    timeframe: 'W', change_reference: 'previous_bar', op: 'between', lo: 50, hi: 100 }))
    .toBe('주봉 · 2026-07-01~2026-07-31 내 · 직전 봉 종가 대비 50~100%');
});

it('normalizes defaults on saved round trips and uses candle date evaluation', () => {
  const request = (params: ChangePctPeriodOptions): ScanRequest => ({ universe: {},
    conditions: [{ id: 'c', type: 'change_pct_period', params }] });
  const params = { mode: 'date_range' as const, start_date: '2026-07-01', end_date: '2026-07-31', op: 'gte' as const, pct: 10 };
  expect(screenerRequestKey(request(params))).toBe(screenerRequestKey(request({ ...params,
    timeframe: 'D', include_open_bar: true, change_reference: 'previous_day' })));
  expect(isHistoricalCondition(request(params).conditions[0])).toBe(false);
});
