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
  it('price_range default is a valid single bound', () => {
    const leaf = makeLeaf('price_range');
    expect(leaf.params).toEqual({ min: 1000 });          // no undefined keys → not {} → no 422
  });
  it('price_range summarize handles min-only / max-only / both', () => {
    expect(CONDITION_CATALOG.price_range.summarize({ min: 1000 })).toBe('≥ 1000원');
    expect(CONDITION_CATALOG.price_range.summarize({ max: 50000 })).toBe('≤ 50000원');
    expect(CONDITION_CATALOG.price_range.summarize({ min: 1000, max: 50000 })).toBe('1000~50000원');
  });
  it('change_pct summarize never renders undefined', () => {
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'lte', pct: 3 })).toBe('≤ 3%');
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'between', lo: 2, hi: 5 })).toBe('2~5%');
    // between with bounds not yet set → neutral placeholder, no "undefined~undefined%"
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'between' })).toBe('사이');
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'gte' })).toBe('≥ %');
  });
});
