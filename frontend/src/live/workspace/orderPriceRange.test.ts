import { describe, expect, it } from 'vitest';
import { orderPriceRange } from './orderPriceRange';

describe('전체 호가 가격 범위', () => {
  it.each([
    [1998, 2010, [2010, 2005, 2000, 1999, 1998]],
    [4995, 5020, [5020, 5010, 5000, 4995]],
    [19990, 20100, [20100, 20050, 20000, 19990]],
    [49950, 50200, [50200, 50100, 50000, 49950]],
    [199900, 201000, [201000, 200500, 200000, 199900]],
    [499500, 502000, [502000, 501000, 500000, 499500]],
  ])('가격대 경계 %i~%i에서 틱을 건너뛰지 않는다', (lower, upper, expected) => {
    const range = orderPriceRange(lower, upper)!;
    expect(Array.from({ length: range.count }, (_, i) => range.priceAt(i))).toEqual(expected);
    expected.forEach((price, i) => expect(range.indexOf(price)).toBe(i));
  });

  it.each(['etf', 'etn'] as const)('%s는 2천원 아래 1원, 위에서는 5원 가격을 모두 포함한다', type => {
    const range = orderPriceRange(1998, 2010, type)!;
    expect(Array.from({ length: range.count }, (_, i) => range.priceAt(i))).toEqual([2010, 2005, 2000, 1999, 1998]);
    const high = orderPriceRange(49995, 50010, type)!;
    expect(Array.from({ length: high.count }, (_, i) => high.priceAt(i))).toEqual([50010, 50005, 50000, 49995]);
  });

  it('많은 ETP 가격도 배열을 만들지 않고 양끝과 중간을 탐색한다', () => {
    const range = orderPriceRange(500_000_000, 1_000_000_000, 'etf')!;
    expect(range.count).toBe(100_000_001);
    expect(range.priceAt(0)).toBe(1_000_000_000);
    expect(range.priceAt(range.count - 1)).toBe(500_000_000);
    expect(range.priceAt(range.indexOf(750_000_000))).toBe(750_000_000);
  });

  it('확인되지 않은 상하한가를 추정하지 않는다', () => {
    for (const [lower, upper] of [[null, 100], [1, undefined], [0, 100], [100, 50], [1, Infinity], [1.5, 100]]) {
      expect(orderPriceRange(lower, upper)).toBeNull();
    }
  });

  it('범위 밖 탐색과 틱 사이 현재가는 유효 가격으로 제한한다', () => {
    const range = orderPriceRange(49950, 50200)!;
    expect(range.priceAt(-10)).toBe(50200);
    expect(range.priceAt(99)).toBe(49950);
    expect(range.priceAt(range.indexOf(50050))).toBe(50000);
    expect(range.priceAt(range.indexOf(1))).toBe(49950);
    expect(range.indexOf(100000)).toBe(0);
  });
});
