import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ConditionLeaf, PriceComparePeriodOptions } from '../../api/screener';
import { screenerRequestKey, isHistoricalCondition } from '../../api/screenerRequest';
import { ConditionRow } from '../ConditionRow';
import { makeLeaf } from '../catalog';
import { price_compare, price_compare_period } from './price_compare';

function Editor({ period = false }: { period?: boolean }) {
  const [condition, setCondition] = useState<ConditionLeaf>(() => makeLeaf(period ? 'price_compare_period' : 'price_compare'));
  return <><ConditionRow leaf={condition} onChange={setCondition} onRemove={() => {}} />
    <output>{JSON.stringify(condition.params)}</output></>;
}

it('defaults to current close above previous high and clones independent operand objects', () => {
  const first = makeLeaf('price_compare');
  const next = makeLeaf('price_compare');
  expect(first.params).toEqual({ left: { offset: 0, source: 'close' }, right: { offset: 1, source: 'high' }, relation: 'gt' });
  expect(first.params).not.toBe(next.params);
  if (first.type !== 'price_compare' || next.type !== 'price_compare') throw new Error('Unexpected leaf type');
  expect(first.params.left).not.toBe(next.params.left);
  expect(price_compare.summarize(price_compare.defaultParams)).toBe('일봉 · 최신 · 0봉 전 종가 > 1봉 전 고가');
  expect(price_compare_period.summarize({ ...price_compare.defaultParams, lookback: 20 })).toBe('일봉 · 최근 20봉 이내 · 0봉 전 종가 > 1봉 전 고가');
});

it('keeps both independent operands when changing source, offset, relation and timeframe', () => {
  render(<Editor />);
  fireEvent.change(screen.getByLabelText('가격 A 봉 위치'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('가격 A 종류'), { target: { value: 'open' } });
  fireEvent.change(screen.getByLabelText('가격 B 봉 위치'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('가격 B 종류'), { target: { value: 'low' } });
  fireEvent.change(screen.getByLabelText('주가 비교 관계'), { target: { value: 'lte' } });
  fireEvent.change(screen.getByLabelText('봉 주기'), { target: { value: 'W' } });
  expect(JSON.parse(screen.getByRole('status').textContent!)).toEqual({
    left: { offset: 2, source: 'open' }, right: { offset: 5, source: 'low' }, relation: 'lte', timeframe: 'W',
  });
  expect(screen.getByLabelText('주가 비교 관계').querySelectorAll('option')).toHaveLength(5);
});

it('retains operands across recent/date mode switches and rejects invalid offsets', () => {
  render(<Editor period />);
  fireEvent.change(screen.getByLabelText('가격 A 종류'), { target: { value: 'low' } });
  fireEvent.change(screen.getByLabelText('가격 B 봉 위치'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('주가 비교 검색 기간'), { target: { value: 'date_range' } });
  fireEvent.change(screen.getByLabelText('주가 비교 발생 시작일'), { target: { value: '2026-07-01' } });
  fireEvent.change(screen.getByLabelText('봉 주기'), { target: { value: 'M' } });
  fireEvent.change(screen.getByLabelText('주가 비교 관계'), { target: { value: 'eq' } });
  expect(screen.getByLabelText('주가 비교 발생 시작일')).toHaveValue('2026-07-01');
  fireEvent.change(screen.getByLabelText('주가 비교 검색 기간'), { target: { value: 'recent' } });
  const params = JSON.parse(screen.getByRole('status').textContent!);
  expect(params).toEqual({ left: { offset: 0, source: 'low' }, right: { offset: 3, source: 'high' },
    relation: 'eq', timeframe: 'M', include_open_bar: true, lookback: 20 });
  for (const value of ['-1', '0.5', '1001']) {
    fireEvent.change(screen.getByLabelText('가격 B 봉 위치'), { target: { value } });
    fireEvent.blur(screen.getByLabelText('가격 B 봉 위치'));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(JSON.parse(screen.getByRole('status').textContent!).right.offset).toBe(3);
  }
});

it('normalizes candle defaults while preserving operand and date differences', () => {
  const req = (params: PriceComparePeriodOptions) => ({ conditions: [{ id: 'p', type: 'price_compare_period' as const, params }], universe: {} });
  const params = { ...price_compare.defaultParams, mode: 'date_range' as const, start_date: '2026-07-01', end_date: '2026-07-31' };
  expect(screenerRequestKey(req(params))).toBe(screenerRequestKey(req({ ...params, timeframe: 'D', include_open_bar: true })));
  expect(screenerRequestKey(req(params))).not.toBe(screenerRequestKey(req({ ...params, right: { offset: 2, source: 'high' } })));
  expect(isHistoricalCondition(req(params).conditions[0])).toBe(false);
});
