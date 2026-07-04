import type { Candle } from '../api/types';

export function mergeCandlesByPriority(
  primary: readonly Candle[],
  fallback: readonly Candle[],
): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const candle of fallback) {
    byTs.set(candle.ts_ms, candle);
  }
  for (const candle of primary) {
    byTs.set(candle.ts_ms, candle);
  }
  return Array.from(byTs.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}
