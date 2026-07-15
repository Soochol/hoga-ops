import { describe, expect, it } from 'vitest';
import { CANONICAL_PANE_ORDER, movePaneBeside, normalizePaneOrder } from './paneOrder';

describe('CANONICAL_PANE_ORDER', () => {
  it('starts with candle and includes the two investor panes', () => {
    expect(CANONICAL_PANE_ORDER[0]).toBe('candle');
    expect(CANONICAL_PANE_ORDER).toContain('investor-foreign');
    expect(CANONICAL_PANE_ORDER).toContain('investor-institution');
    expect(CANONICAL_PANE_ORDER).toHaveLength(8);
  });
});

describe('normalizePaneOrder', () => {
  it('returns the canonical order for non-array input', () => {
    expect(normalizePaneOrder(undefined)).toEqual([...CANONICAL_PANE_ORDER]);
    expect(normalizePaneOrder(null)).toEqual([...CANONICAL_PANE_ORDER]);
  });

  it('forces candle to index 0 even if persisted elsewhere', () => {
    const out = normalizePaneOrder(['volume', 'ratio', 'candle', 'program-trade']);
    expect(out[0]).toBe('candle');
    // candle 앞에 있던 volume/ratio 는 candle 뒤로 밀리고, 나머지 누락은 append.
    expect(out).toEqual([
      'candle', 'volume', 'ratio', 'program-trade',
      'quote-totals', 'fill-strength', 'investor-foreign', 'investor-institution',
    ]);
  });

  it('drops unknown ids and appends missing canonical ids', () => {
    const out = normalizePaneOrder(['ratio', 'bogus', 'volume']);
    expect(out).toEqual([
      'candle', 'ratio', 'volume',
      'quote-totals', 'fill-strength', 'program-trade',
      'investor-foreign', 'investor-institution',
    ]);
  });
});

describe('movePaneBeside', () => {
  it('moves a pane to just before its neighbor', () => {
    const order = normalizePaneOrder(undefined);
    const out = movePaneBeside(order, 'ratio', 'volume', 'before');
    expect(out.indexOf('ratio')).toBe(out.indexOf('volume') - 1);
  });

  it('moves a pane to just after its neighbor', () => {
    const order = normalizePaneOrder(undefined);
    const out = movePaneBeside(order, 'volume', 'ratio', 'after');
    expect(out.indexOf('volume')).toBe(out.indexOf('ratio') + 1);
  });

  it('refuses to move candle', () => {
    const order = normalizePaneOrder(undefined);
    expect(movePaneBeside(order, 'candle', 'volume', 'before')).toEqual(order);
  });

  it('returns a copy when the neighbor is missing or pane==neighbor', () => {
    const order = normalizePaneOrder(undefined);
    expect(movePaneBeside(order, 'volume', 'volume', 'before')).toEqual(order);
  });

  it('preserves absent panes\' relative slots (no cross-timeframe leapfrog)', () => {
    // D 전역 순서에서 investor-foreign 을 volume 위로 올려도, 분봉에서만 마운트되는
    // 호가 pane(quote-totals..program-trade)의 상대 순서는 그대로 — volume 이 그들
    // 뒤로 튀지 않는다. 이동한 pane 만 volume 바로 앞으로 최소 이동한다.
    const order = normalizePaneOrder(undefined); // candle, volume, quote-totals, ratio, fill-strength, program-trade, IF, II
    const out = movePaneBeside(order, 'investor-foreign', 'volume', 'before');
    expect(out).toEqual([
      'candle', 'investor-foreign', 'volume', 'quote-totals', 'ratio',
      'fill-strength', 'program-trade', 'investor-institution',
    ]);
    // 분봉 투영(IF/II 제외): volume 이 여전히 candle 바로 뒤 → leapfrog 없음.
    const minuteView = out.filter((id) => id !== 'investor-foreign' && id !== 'investor-institution');
    expect(minuteView).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength', 'program-trade']);
  });
});
