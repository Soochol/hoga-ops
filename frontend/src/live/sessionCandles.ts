import type { Candle, RangeSegment } from '../api/types';

/** Validate ordering once, then locate each [open, close) session in O(log N).
 * Legacy callers may supply unsorted candles; preserve their input order. */
export function createSessionCandleLookup(candles: readonly Candle[]) {
  const sorted = candles.every((c, i) => Number.isFinite(c.ts_ms)
    && (i === 0 || candles[i - 1].ts_ms <= c.ts_ms));
  function lowerBound(time: number): number {
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (candles[mid].ts_ms < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  return (segment: Pick<RangeSegment, 'session_open_ms' | 'session_close_ms'>): Candle[] => {
    const { session_open_ms: open, session_close_ms: close } = segment;
    if (!(open < close)) return [];
    if (!sorted) return candles.filter(c => c.ts_ms >= open && c.ts_ms < close);
    return candles.slice(lowerBound(open), lowerBound(close));
  };
}
