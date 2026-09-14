import { unixMsToKSTDate } from '../../util/time';
import type { SnapCandle } from './snap';

/** Index the full supplied day, never the visible logical range or cursor Y. */
export function indexDayExtremes(candles: readonly SnapCandle[]) {
  const days = new Map<string, { high: number; low: number }>();
  const invalid = new Set<string>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.ts_ms)) continue;
    const date = unixMsToKSTDate(candle.ts_ms);
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low) || candle.high < candle.low) {
      invalid.add(date);
      continue;
    }
    const prev = days.get(date);
    days.set(date, { high: Math.max(prev?.high ?? -Infinity, candle.high),
      low: Math.min(prev?.low ?? Infinity, candle.low) });
  }
  for (const date of invalid) days.delete(date);
  return days;
}
