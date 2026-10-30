import type { LiveIndexCandle } from '../../api/liveIndices';
import type { MarketIndexQuote } from '../../api/marketIndexQuotes';
import { realMsToYyyymmdd, regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';

export { MAJOR_INDICES } from '../../state/majorIndicesSettings';

export interface IndexPercentPoint { tMs: number; percent: number }
export interface MajorIndexSeries {
  points: IndexPercentPoint[];
  value: number | null;
  percent: number | null;
  observedMs: number | null;
  closed: boolean;
  delayed: boolean;
}

const validClose = (c: LiveIndexCandle) => Number.isFinite(c.t_ms) && Number.isFinite(c.close) && c.close > 0;

export function latestIndexDate(candles: readonly LiveIndexCandle[], beforeOrOn: string): string | null {
  let latest: string | null = null;
  for (const c of candles) {
    if (!validClose(c)) continue;
    const date = realMsToYyyymmdd(c.t_ms);
    if (date <= beforeOrOn && (!latest || date > latest)) latest = date;
  }
  return latest;
}

/** All lines use the preceding trading day's close, never the first intraday point.
 * Historical daily closes also supply the closing-auction endpoint when minute history is partial.
 */
export function buildMajorIndexSeries(
  date: string,
  nowMs: number,
  candles: readonly LiveIndexCandle[],
  daily: readonly LiveIndexCandle[],
  quote?: MarketIndexQuote,
): MajorIndexSeries {
  const open = regularSessionOpenMs(date), close = regularSessionCloseMs(date);
  const today = realMsToYyyymmdd(nowMs);
  let previous: LiveIndexCandle | undefined, finalDaily: LiveIndexCandle | undefined;
  for (const c of daily) {
    if (!validClose(c)) continue;
    const d = realMsToYyyymmdd(c.t_ms);
    if (d < date && (!previous || c.t_ms > previous.t_ms)) previous = c;
    if (d === date && date < today) finalDaily = c;
  }
  const q = quote && Number.isFinite(quote.value) && quote.value > 0
    && Number.isFinite(quote.change) && Number.isFinite(quote.tMs)
    && quote.tMs >= open && quote.tMs <= nowMs + 60_000
    && realMsToYyyymmdd(quote.tMs) === date ? quote : undefined;
  const quoteBase = q ? q.value - q.change : 0;
  const base = quoteBase > 0 && Number.isFinite(quoteBase) ? quoteBase : previous?.close;
  const byTime = new Map<number, number>();
  for (const c of candles) {
    if (validClose(c) && c.t_ms >= open && c.t_ms <= Math.min(close, nowMs)) byTime.set(c.t_ms, c.close);
  }
  const ordered = [...byTime].sort((a, b) => a[0] - b[0]);
  let observedMs = ordered.at(-1)?.[0] ?? null;
  let value = ordered.at(-1)?.[1] ?? null;
  if (q && (observedMs === null || q.tMs >= observedMs)) {
    observedMs = q.tMs;
    value = q.value;
    byTime.set(Math.min(q.tMs, close), q.value);
  }
  if (finalDaily) {
    value = finalDaily.close;
    observedMs = close;
    byTime.set(close, value);
  }
  const points = base && base > 0 ? [...byTime].sort((a, b) => a[0] - b[0])
    .map(([tMs, v]) => ({ tMs, percent: (v / base - 1) * 100 })) : [];
  const closed = nowMs >= close && observedMs !== null && observedMs >= close;
  const delayed = date === today && nowMs >= open && (
    observedMs === null || (nowMs < close ? nowMs - observedMs > 180_000 : !closed)
  );
  return { points, value, percent: base && value !== null ? (value / base - 1) * 100 : null, observedMs, closed, delayed };
}

/** No extrapolation across missing minutes or past a series' last observation. */
export function indexPercentAt(points: readonly IndexPercentPoint[], tMs: number): number | null {
  return seriesValueAt(points, tMs, point => point.percent);
}

export function seriesValueAt<T extends { tMs: number }>(points: readonly T[], tMs: number, value: (point: T) => number, maxGapMs = 120_000): number | null {
  let lo = 0, hi = points.length - 1;
  if (!points.length || tMs < points[0].tMs || tMs > points[hi].tMs) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].tMs < tMs) lo = mid + 1;
    else hi = mid;
  }
  const next = points[lo];
  if (next.tMs === tMs) return value(next);
  const prev = points[lo - 1];
  if (!prev || next.tMs - prev.tMs > maxGapMs) return null;
  return value(prev) + (value(next) - value(prev)) * (tMs - prev.tMs) / (next.tMs - prev.tMs);
}
