import { describe, expect, it } from 'vitest';
import { holdingBookMarker } from './orderRules';

describe('holdingBookMarker price anchor', () => {
  it('never attaches a fixed decimal average to a neighbouring price when quotes disappear', () => {
    const average = '67240.5';
    for (const prices of [[67100, 67200, 67300], [67300, 67200, 67100], [67100, 67300], [67400, 67200, 67100]]) {
      expect(holdingBookMarker(100, average, prices).price).toBe(prices.includes(67200) ? 67200 : null);
    }
  });
});

describe('canonical decimal nearest price', () => {
  it.each([
    ['67200', 67200], ['67240.5', 67200], ['67250', 67200],
    ['67249.99999999999999999', 67200], ['67250.00000000000000001', 67300],
    ['1', 1], ['1.5', 1], ['1.50000000000000001', 2], ['1000000000', 1000000000],
  ])('%s selects %i without rounding the source', (average, anchor) => {
    const prices = [1, 2, 67100, 67200, 67300, 1_000_000_000];
    expect(holdingBookMarker(3, average, prices)).toEqual({ price: anchor, outside: false });
  });
  it.each([
    [2000, 1, 5], [5000, 5, 10], [20000, 10, 50],
    [50000, 50, 100], [200000, 100, 500], [500000, 500, 1000],
  ])('compares actual neighbours on each side of %i', (boundary, below, above) => {
    const prices = [boundary - below, boundary, boundary + above];
    for (const [average, anchor] of [
      [String(boundary), boundary],
      [String(boundary - below / 2), boundary - below],
      [String(boundary - below / 2 + 0.1), boundary],
      [String(boundary + above / 2), boundary],
      [String(boundary + above / 2 + 0.1), boundary + above],
    ] as const) {
      expect(holdingBookMarker(1, average, prices).price).toBe(anchor);
      expect(holdingBookMarker(1, average, [...prices].reverse()).price).toBe(anchor);
      expect(holdingBookMarker(1, average, prices.filter(price => price !== anchor)).price).toBeNull();
    }
  });
  it.each(['etf', 'etn'] as const)('%s uses the full ladder grid even in stock price bands', security => {
    expect(holdingBookMarker(1, '50007.5', [49950, 50005, 50010, 50100], security).price).toBe(50005);
    expect(holdingBookMarker(1, '50007.50000000000001', [49950, 50005, 50010, 50100], security).price).toBe(50010);
    expect(holdingBookMarker(1, '50007.5', [49950, 50010, 50100], security).price).toBeNull();
    expect(holdingBookMarker(1, '1999.5', [1999, 2000, 2005], security).price).toBe(1999);
    expect(holdingBookMarker(1, '2002.5', [1999, 2000, 2005], security).price).toBe(2000);
  });
  it('separates hidden missing anchors from out of range and invalid data', () => {
    expect(holdingBookMarker(1, '67240.5', [67100, 67300])).toEqual({ price: null, outside: false });
    expect(holdingBookMarker(1, '67240.5', [67200])).toEqual({ price: null, outside: true });
    expect(holdingBookMarker(1, '0.5', [1, 2])).toEqual({ price: null, outside: true });
    for (const prices of [[], [NaN, 0, -1, Infinity, 1.5]]) {
      expect(holdingBookMarker(1, '67240.5', prices)).toEqual({ price: null, outside: false });
    }
    for (const average of ['', null, undefined, '0', '-1', 'NaN', 'Infinity', '1e3', '1'.repeat(129)]) {
      expect(holdingBookMarker(1, average, [67100, 67300]).price).toBeNull();
    }
  });
  it('changes anchor only when the actual average changes and repeats without history', () => {
    for (let update = 0; update < 20; update++) {
      const prices = update % 2 ? [67400, 67300, 67200, 67100] : [67400, 67200, 67000];
      expect(holdingBookMarker(100, '67240.5', prices).price).toBe(67200);
      expect(holdingBookMarker(100, '67260.5', prices).price).toBe(prices.includes(67300) ? 67300 : null);
      expect(holdingBookMarker(0, '67240.5', prices).price).toBeNull();
    }
  });
});
