import type { Candle } from '../api/types';

export type CalendarCandleGranularity = 'D' | 'W' | 'M';

function calendarMergeKey(tsMs: number, granularity: CalendarCandleGranularity): string {
  const kst = new Date(tsMs + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  if (granularity === 'M') return `${y}-${m}`;
  if (granularity === 'D') return `${y}-${m}-${d}`;
  const dow = kst.getUTCDay();
  const offsetToMon = (dow + 6) % 7;
  const monday = new Date(Date.UTC(y, m, d - offsetToMon));
  return `W:${monday.getUTCFullYear()}-${monday.getUTCMonth()}-${monday.getUTCDate()}`;
}

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

export function mergeCalendarCandlesByPriority(
  primary: readonly Candle[],
  fallback: readonly Candle[],
  granularity: CalendarCandleGranularity,
): Candle[] {
  const byBucket = new Map<string, Candle>();
  for (const candle of fallback) {
    byBucket.set(calendarMergeKey(candle.ts_ms, granularity), candle);
  }
  for (const candle of primary) {
    byBucket.set(calendarMergeKey(candle.ts_ms, granularity), candle);
  }
  return Array.from(byBucket.values()).sort((a, b) => a.ts_ms - b.ts_ms);
}
