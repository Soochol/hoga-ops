import type { Candle } from '../../api/types';

export type NewHighBearishSignal = {
  ts_ms: number;
  price: number;
  highTsMs: number;
  ordinal: number;
};

/** One pass over chronological daily candles. The high window excludes today's bar. */
export function computeNewHighBearishOpen(
  candles: readonly Candle[],
  lookback: number,
  dropPct: number,
  maxCount: 1 | 2,
  isClosed: (candle: Candle) => boolean = () => true,
): NewHighBearishSignal[] {
  if (!Number.isInteger(lookback) || lookback < 1 || !Number.isFinite(dropPct) || dropPct <= 0 || dropPct > 100 || ![1, 2].includes(maxCount)) return [];
  const signals: NewHighBearishSignal[] = [];
  let highs: number[] = [], head = 0, validRun = 0;
  let highTsMs: number | null = null, count = 0;
  let previous: Candle | null = null;
  const closes: number[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!isClosed(c)) break;
    if (![c.ts_ms, c.open, c.high, c.low, c.close].every(Number.isFinite)
      || c.low <= 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)
      || (previous !== null && c.ts_ms <= previous.ts_ms)) {
      highs = []; head = 0; validRun = 0; highTsMs = null; count = 0;
      previous = null; closes.length = 0; sum = 0;
      continue;
    }
    sum += c.close;
    closes.push(c.close);
    if (closes.length > 5) sum -= closes.shift()!;
    while (head < highs.length && highs[head] < i - lookback) head++;
    const newHigh = validRun >= lookback && head < highs.length && c.high > candles[highs[head]].high;
    if (newHigh) {
      highTsMs = c.ts_ms;
      count = 0; // A high-day bearish candle never qualifies on that same day.
    } else if (highTsMs !== null && count < maxCount && previous && closes.length === 5
      && c.close < c.open && c.close < sum / 5
      && c.low <= previous.close * (100 - dropPct) / 100 + previous.close * 1e-12) {
      count++;
      signals.push({ ts_ms: c.ts_ms, price: c.open, highTsMs, ordinal: count });
    }
    while (highs.length > head && candles[highs[highs.length - 1]].high <= c.high) highs.pop();
    highs.push(i);
    if (head > 1024) { highs = highs.slice(head); head = 0; }
    previous = c;
    validRun++;
  }
  return signals;
}

/** Daily timestamps are 09:00 KST display anchors, not the close time. */
export function domesticDailyCandleClosed(tsMs: number, nowMs: number, venue: 'KRX' | 'NXT' | 'UN'): boolean {
  const dayStart = Math.floor((tsMs + 9 * 3600_000) / 86400_000) * 86400_000 - 9 * 3600_000;
  const close = venue === 'KRX' ? (15 * 60 + 30) * 60_000 : 20 * 3600_000;
  return Number.isFinite(tsMs) && nowMs >= dayStart + close;
}

/** Calendar months in KST, clamping month-end (Aug 31 + 6 months = Feb 28/29). */
export function bearishRayEndMs(tsMs: number, months: number): number {
  const start = new Date(tsMs + 9 * 3600_000);
  const year = start.getUTCFullYear(), month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()) - 9 * 3600_000;
}
