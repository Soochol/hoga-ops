import { describe, expect, it } from 'vitest';
import type { ConditionLeaf } from '../api/screener';
import { includeOpenBars } from './candlePolicy';
import { makeLeaf } from './catalog';

describe.each(['new_high', 'new_high_today', 'new_high_vol', 'new_high_vol_today',
  'high_off_peak', 'ma', 'trade_value', 'trade_value_period', 'change_pct'] as const)('%s open candles', type => {
  it('migrates a closed-only save without changing its identity, timeframe or predicate', () => {
    const leaf = makeLeaf(type);
    const old = { ...leaf, params: { ...leaf.params, timeframe: '5m', include_open_bar: false } } as ConditionLeaf;
    expect(includeOpenBars([old])).toEqual([{ ...old, params: { ...old.params, include_open_bar: true } }]);
    expect(old.params).toHaveProperty('include_open_bar', false);
    expect(includeOpenBars([leaf])[0]).toBe(leaf);
  });
});

it('keeps legacy daily history collection and unrelated conditions intact', () => {
  const conditions: ConditionLeaf[] = [
    { id: 'v', type: 'new_high_vol', params: { mode: 'date_range', start_date: '2019-01-01',
      end_date: '2022-12-31', record_period: { unit: 'years', value: 2 } } },
    { id: 't', type: 'trade_value_period', params: { mode: 'date_range', start_date: '2019-01-01',
      end_date: '2022-12-31', min_eok: 100 } },
    makeLeaf('price_range'),
  ];
  expect(includeOpenBars(conditions)).toEqual(conditions);
  conditions.forEach((leaf, index) => expect(includeOpenBars(conditions)[index]).toBe(leaf));
});
