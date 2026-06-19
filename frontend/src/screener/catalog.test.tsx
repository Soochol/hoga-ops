import { describe, it, expect } from 'vitest';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';

describe('catalog', () => {
  it('covers all 9 types incl. 당일/기간내 변형', () => {
    expect(CONDITION_ORDER).toHaveLength(9);
    expect(Object.keys(CONDITION_CATALOG).sort()).toEqual(
      ['change_pct', 'ma', 'new_high', 'new_high_today', 'new_high_vol',
       'new_high_vol_today', 'price_range', 'trade_value', 'trade_value_period']);
  });
  it('renames breakout labels to 기간내, bare label = 당일', () => {
    expect(CONDITION_CATALOG.new_high.label).toBe('기간내 신고가');
    expect(CONDITION_CATALOG.new_high_vol.label).toBe('기간내 신고거래량');
    expect(CONDITION_CATALOG.new_high_today.label).toBe('신고가');
    expect(CONDITION_CATALOG.new_high_vol_today.label).toBe('신고거래량');
    expect(CONDITION_CATALOG.trade_value_period.label).toBe('기간내 거래대금');
  });
  it('makeLeaf assigns id + default params (single & dual)', () => {
    expect(makeLeaf('new_high_today').params).toEqual({ period: 200 });
    expect(makeLeaf('new_high_vol_today').params).toEqual({ period: 60 });
    expect(makeLeaf('trade_value_period').params).toEqual({ lookback: 60, min_eok: 1000 });
    const a = makeLeaf('new_high'); const b = makeLeaf('new_high');
    expect(a.params).toEqual({ lookback: 200, period: 500 });
    expect(a.id).not.toBe(b.id);
  });
  it('summarize renders sublabels', () => {
    expect(CONDITION_CATALOG.new_high.summarize({ lookback: 200, period: 500 })).toBe('200·500');
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'gte', pct: 5 })).toBe('≥ 5%');
    expect(CONDITION_CATALOG.ma.summarize({ period: 20, relation: 'above' })).toBe('종가 ≥ MA20');
    expect(CONDITION_CATALOG.ma.summarize({ period: 20, relation: 'below' })).toBe('종가 ≤ MA20');
    expect(CONDITION_CATALOG.ma.summarize({ period: 20, relation: 'above', source: 'open' })).toBe('시가 ≥ MA20');
    expect(CONDITION_CATALOG.new_high_today.summarize({ period: 200 })).toBe('200일');
    expect(CONDITION_CATALOG.trade_value_period.summarize({ lookback: 60, min_eok: 1000 })).toBe('60일내 ≥1000억');
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
