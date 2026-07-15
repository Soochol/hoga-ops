import { describe, expect, it } from 'vitest';
import { CANONICAL_PANE_ORDER, normalizePaneOrder, swapInPaneOrder } from './paneOrder';

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

describe('swapInPaneOrder', () => {
  it('swaps two non-candle ids by position', () => {
    const order = normalizePaneOrder(undefined);
    const out = swapInPaneOrder(order, 'volume', 'ratio');
    expect(out.indexOf('volume')).toBe(order.indexOf('ratio'));
    expect(out.indexOf('ratio')).toBe(order.indexOf('volume'));
  });

  it('refuses to move candle', () => {
    const order = normalizePaneOrder(undefined);
    expect(swapInPaneOrder(order, 'candle', 'volume')).toEqual(order);
  });

  it('swaps across a gap (absent pane between neighbors)', () => {
    // 분봉에서 investor 가 부재중이어도 전체 순서에서 이름 위치를 바꾼다.
    const order: readonly ('candle' | 'volume' | 'investor-foreign' | 'program-trade')[] = [
      'candle', 'volume', 'investor-foreign', 'program-trade',
    ];
    const out = swapInPaneOrder(order as never, 'volume', 'program-trade');
    expect(out).toEqual(['candle', 'program-trade', 'investor-foreign', 'volume']);
  });

  it('returns a copy when an id is missing', () => {
    const order = normalizePaneOrder(undefined);
    expect(swapInPaneOrder(order, 'volume', 'volume')).toEqual(order);
  });
});
