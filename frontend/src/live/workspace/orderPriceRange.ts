import type { SymbolHit } from '../../api/types';

type SecurityType = NonNullable<SymbolHit['security_type']>;
type Band = { lower: number; upper: number; tick: number; count: number };

/** KRX price bands, shared by KOSPI/KOSDAQ. ETPs use 1 won below 2,000,
 * then 5 won: https://regulation.krx.co.kr/contents/RGL/03/03060101/RGL03060101.jsp
 * Keep bands instead of allocating every price (high-priced ETPs can have millions). */
export function orderPriceRange(lower: number | null | undefined, upper: number | null | undefined, security: SecurityType = 'stock') {
  if (lower == null || upper == null || !Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)
    || lower <= 0 || upper < lower || upper > 1_000_000_000) return null;
  const boundaries = security === 'stock'
    ? [[1, 1999, 1], [2000, 4999, 5], [5000, 19999, 10], [20000, 49999, 50],
      [50000, 199999, 100], [200000, 499999, 500], [500000, 1_000_000_000, 1000]]
    : [[1, 1999, 1], [2000, 1_000_000_000, 5]];
  const bands: Band[] = boundaries.flatMap(([min, max, tick]) => {
    const lo = Math.ceil(Math.max(lower, min) / tick) * tick;
    const hi = Math.floor(Math.min(upper, max) / tick) * tick;
    return hi < lo ? [] : [{ lower: lo, upper: hi, tick, count: (hi - lo) / tick + 1 }];
  }).reverse();
  const count = bands.reduce((n, band) => n + band.count, 0);
  if (!count) return null;
  return {
    count,
    priceAt(index: number): number {
      let remaining = Math.max(0, Math.min(count - 1, Math.trunc(index)));
      for (const band of bands) {
        if (remaining < band.count) return band.upper - remaining * band.tick;
        remaining -= band.count;
      }
      return bands[bands.length - 1].lower;
    },
    /** Nearest valid price at or below a target; clamp outside the limits. */
    indexOf(price: number): number {
      let offset = 0;
      for (const band of bands) {
        if (price >= band.lower) return offset + Math.max(0, Math.ceil((band.upper - price) / band.tick));
        offset += band.count;
      }
      return count - 1;
    },
  };
}

export type OrderPriceRange = NonNullable<ReturnType<typeof orderPriceRange>>;
