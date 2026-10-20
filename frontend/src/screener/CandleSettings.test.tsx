import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConditionLeaf, ConditionType, ScanRequest, ScreenerOccurrence } from '../api/screener';
import { screenerRequestKey } from '../api/screenerRequest';
import { CONDITION_CATALOG, makeLeaf } from './catalog';
import { BarMatchEvidence } from './BarMatchEvidence';
import { occurrenceTimeLabel } from './occurrenceTime';

const kinds = ['new_high_today', 'new_high', 'new_high_vol_today', 'high_off_peak', 'ma', 'trade_value', 'trade_value_period', 'change_pct'] as const;


function Editor({ kind }: { kind: ConditionType }) {
  const [leaf, setLeaf] = useState(() => makeLeaf(kind));
  // Catalog forms carry their own correlated params; this dynamic test covers every editor.
  const Form = CONDITION_CATALOG[leaf.type].ParamForm as React.ComponentType<{
    params: ConditionLeaf['params']; onChange: (params: ConditionLeaf['params']) => void;
  }>;
  return <><Form params={leaf.params} onChange={params => setLeaf({ ...leaf, params } as ConditionLeaf)} />
    <output>{JSON.stringify(leaf.params)}</output></>;
}

describe.each(kinds)('%s candle editor', kind => {
  it('retains predicate parameters and open policy across minute/day/week/month changes', () => {
    render(<Editor kind={kind} />);
    const original = JSON.parse(screen.getByRole('status').textContent!);
    expect(screen.getByRole('combobox', { name: '봉 주기' })).toHaveValue('D');
    expect(screen.queryByLabelText('진행 중 봉 포함')).not.toBeInTheDocument();
    for (const value of ['15m', 'W', 'M', 'D']) {
      fireEvent.change(screen.getByRole('combobox', { name: '봉 주기' }), { target: { value } });
      const current = JSON.parse(screen.getByRole('status').textContent!);
      expect(current).toMatchObject({ ...original,
        timeframe: value });
      expect(current.include_open_bar ?? true).toBe(true);
    }
    if (kind === 'ma') {
      fireEvent.change(screen.getByLabelText('MA 기준가격'), { target: { value: 'low' } });
      expect(JSON.parse(screen.getByRole('status').textContent!)).toMatchObject({
        source: 'low', timeframe: 'D' });
    }
    if (kind === 'high_off_peak') {
      fireEvent.change(screen.getByRole('combobox', { name: '이내/이외' }), { target: { value: 'outside' } });
      expect(JSON.parse(screen.getByRole('status').textContent!)).toMatchObject({
        side: 'outside', timeframe: 'D' });
    }
  });

  it('normalizes materialized defaults without losing distinct timeframe or completion policy', () => {
    const leaf = makeLeaf(kind);
    const request = (params: object) => ({ conditions: [{ ...leaf, params }], universe: {} }) as ScanRequest;
    const key = screenerRequestKey(request(leaf.params));
    expect(screenerRequestKey(request({ ...leaf.params, timeframe: 'D', include_open_bar: true }))).toBe(key);
    expect(screenerRequestKey(request({ ...leaf.params, timeframe: 'W' }))).not.toBe(key);
    expect(screenerRequestKey(request({ ...leaf.params, include_open_bar: false }))).not.toBe(key);
  });
});

it('shows price evidence in won with KST minute timestamps', () => {
  const event: ScreenerOccurrence = { condition_id: 'ma', condition_key: 'ma', date: '2026-07-30',
    bar_start_ms: Date.parse('2026-07-30T10:05:00+09:00'), bar_price_match: {
      timeframe: '5m', source: 'low', value: 1234.5, reference: 1200, is_open: true,
      window_start_ms: 0, fetched_at_ms: 1 } };
  expect(occurrenceTimeLabel(event)).toBe('2026-07-30 10:05');
  render(<BarMatchEvidence event={event} />);
  expect(screen.getByText('저가 1,234.5원 · 비교값 1,200원 · 진행 중')).toBeInTheDocument();
});
