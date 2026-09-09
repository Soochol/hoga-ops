import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { HistoryTradeValueParams, TradeValuePeriodParams } from '../../api/screener';
import { trade_value_period } from './trade_value_period';

type Params = TradeValuePeriodParams | HistoryTradeValueParams;

function Editor() {
  const [params, setParams] = useState<Params>({ lookback: 60, min_eok: 2500 });
  const Form = trade_value_period.ParamForm;
  return <><Form params={params} onChange={setParams} /><output>{trade_value_period.summarize(params)}</output></>;
}

it('adds inclusive dates while preserving the amount when switching period modes', () => {
  render(<Editor />);
  expect(screen.getByLabelText('최근 기간(일)')).toHaveValue(60);
  fireEvent.change(screen.getByRole('combobox', { name: '거래대금 검색 기간' }), { target: { value: 'date_range' } });
  expect(screen.getByLabelText('최소 거래대금(억)')).toHaveValue(2500);
  expect(screen.getByLabelText('거래대금 발생 시작일')).toHaveValue('2019-01-01');
  fireEvent.change(screen.getByLabelText('거래대금 발생 종료일'), { target: { value: '2021-12-31' } });
  expect(screen.getByRole('status')).toHaveTextContent('2019-01-01~2021-12-31 내 ≥2500억');
  fireEvent.change(screen.getByRole('combobox', { name: '거래대금 검색 기간' }), { target: { value: 'recent' } });
  expect(screen.getByLabelText('최근 기간(일)')).toHaveValue(60);
  expect(screen.getByLabelText('최소 거래대금(억)')).toHaveValue(2500);
});
