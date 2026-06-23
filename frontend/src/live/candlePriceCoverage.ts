import type { Candle } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';

type PriceRange = { low: number; high: number };

function mergeRanges(ranges: PriceRange[]): PriceRange[] {
  if (ranges.length <= 1) return ranges;
  ranges.sort((a, b) => a.low - b.low || a.high - b.high);
  const merged: PriceRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.low <= last.high) {
      if (range.high > last.high) last.high = range.high;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function buildCandlePriceCoverage(
  candles: readonly Candle[],
  todayKst: string,
): (price: number) => boolean {
  const ranges = mergeRanges(
    candles.flatMap((c) => {
      if (
        realMsToYyyymmdd(c.ts_ms) !== todayKst ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.high)
      ) {
        return [];
      }
      return [{ low: Math.min(c.low, c.high), high: Math.max(c.low, c.high) }];
    }),
  );

  return (price: number): boolean => {
    if (!Number.isFinite(price)) return false;
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const range = ranges[mid];
      if (price < range.low) hi = mid - 1;
      else if (price > range.high) lo = mid + 1;
      else return true;
    }
    return false;
  };
}
