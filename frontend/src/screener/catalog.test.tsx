import { describe, it, expect } from 'vitest';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';

describe('catalog', () => {
  it('covers all 6 types', () => {
    expect(CONDITION_ORDER).toHaveLength(6);
    expect(Object.keys(CONDITION_CATALOG).sort()).toEqual(
      ['change_pct', 'ma', 'new_high', 'new_high_vol', 'price_range', 'trade_value']);
  });
  it('makeLeaf assigns id + default params', () => {
    const a = makeLeaf('new_high'); const b = makeLeaf('new_high');
    expect(a.type).toBe('new_high'); expect(a.params).toEqual({ lookback: 200, period: 500 });
    expect(a.id).not.toBe(b.id);                       // distinct ids → repeatable
  });
  it('summarize renders sublabels', () => {
    expect(CONDITION_CATALOG.new_high.summarize({ lookback: 200, period: 500 })).toBe('200·500');
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'gte', pct: 5 })).toBe('≥ 5%');
    expect(CONDITION_CATALOG.ma.summarize({ period: 20, relation: 'above' })).toBe('MA20 위');
  });
});
