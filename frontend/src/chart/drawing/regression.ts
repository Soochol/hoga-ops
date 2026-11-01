import type { DrawingCandle, Point, Regression, RegressionSource } from './types';

export type RegressionFit = { first: Point; last: Point; deviation: number; count: number };
const cache = new WeakMap<readonly DrawingCandle[], Map<string, RegressionFit | null>>();

function sourceValue(c: DrawingCandle, source: RegressionSource): number | null {
  const fields = source === 'hl2' ? [c.high, c.low]
    : source === 'hlc3' ? [c.high, c.low, c.close]
      : source === 'ohlc4' ? [c.open, c.high, c.low, c.close] : [c[source]];
  if (fields.some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
  return (fields as number[]).reduce((sum, v) => sum + v / fields.length, 0);
}

function lowerBound(candles: readonly DrawingCandle[], ms: number): number {
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candles[mid].ts_ms < ms) low = mid + 1; else high = mid;
  }
  return low;
}

/** OLS on loaded bar ordinals; sigma is sqrt(mean squared residual).
 * Requires both range anchors, never fabricates missing prices or extrapolates
 * unavailable endpoints. The array identity is immutable in the chart data flow. */
export function fitRegression(d: Pick<Regression, 'a' | 'b' | 'source'>, candles?: readonly DrawingCandle[]): RegressionFit | null {
  if (!candles?.length) return null;
  const from = Math.min(d.a.realMs, d.b.realMs), to = Math.max(d.a.realMs, d.b.realMs);
  const key = `${from}|${to}|${d.source}`;
  let entries = cache.get(candles);
  if (!entries) { entries = new Map(); cache.set(candles, entries); }
  if (entries.has(key)) return entries.get(key)!;
  const start = lowerBound(candles, from), end = lowerBound(candles, to);
  let result: RegressionFit | null = null;
  if (start < end && candles[start]?.ts_ms === from && candles[end]?.ts_ms === to) {
    const values: number[] = [];
    for (let i = start; i <= end; i++) {
      if (i > start && candles[i].ts_ms <= candles[i - 1].ts_ms) break;
      const value = sourceValue(candles[i], d.source);
      if (value == null) break;
      values.push(value);
    }
    const n = end - start + 1;
    if (values.length === n) {
      const meanX = (n - 1) / 2;
      const reference = values[0];
      // Center prices too, avoiding cancellation for a small move on a large price.
      const meanY = values.reduce((sum, v) => sum + (v - reference) / n, 0);
      let xy = 0, xx = 0;
      for (let i = 0; i < n; i++) { xy += (i - meanX) * (values[i] - reference - meanY); xx += (i - meanX) ** 2; }
      const slope = xy / xx, intercept = reference + meanY - slope * meanX;
      let squares = 0;
      for (let i = 0; i < n; i++) squares += (values[i] - (intercept + slope * i)) ** 2;
      const last = intercept + slope * (n - 1), deviation = Math.sqrt(squares / n);
      if ([intercept, last, deviation].every(Number.isFinite)) {
        result = { first: { realMs: from, price: intercept }, last: { realMs: to, price: last }, deviation, count: n };
      }
    }
  }
  entries.set(key, result);
  if (entries.size > 128) entries.delete(entries.keys().next().value!);
  return result;
}
