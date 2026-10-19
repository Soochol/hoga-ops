import type { BrokerSeriesEntry } from '../api/types';
import { isForeignBroker } from './brokerDisplayNames';

const quantities = new Intl.NumberFormat('ko-KR');
export function formatBrokerNet(value: number): string {
  return `${value > 0 ? '+' : ''}${quantities.format(value)}`;
}

/** Reserve the full loaded range, including simultaneous foreign totals.
 * Cursor movement then only changes text, never the shared column width. */
export function brokerFigureSizingValues(rows: readonly BrokerSeriesEntry[]): string[] {
  let min = 0, max = 0;
  const foreignChanges = new Map<number, number>();
  for (const row of rows) {
    const foreign = isForeignBroker(row.broker);
    let previous = 0;
    for (const point of row.points) {
      min = Math.min(min, point.net);
      max = Math.max(max, point.net);
      if (foreign) {
        foreignChanges.set(point.ts_ms, (foreignChanges.get(point.ts_ms) ?? 0) + point.net - previous);
        previous = point.net;
      }
    }
  }
  let total = 0;
  for (const [, delta] of [...foreignChanges].sort(([a], [b]) => a - b)) {
    total += delta;
    min = Math.min(min, total);
    max = Math.max(max, total);
  }
  return [formatBrokerNet(min), formatBrokerNet(max)];
}


/** Pure function. Binary-searches entry.points for the last ts <= cursorMs.
 *  Returns null when cursorMs is null or precedes the first observation —
 *  "아직 등장 전"을 진짜 순매수 0과 구분하기 위해서다(표시는 —). */
export function netAtCursor(
  entry: BrokerSeriesEntry,
  cursorMs: number | null,
): number | null {
  if (cursorMs == null) return null;
  const pts = entry.points;
  if (pts.length === 0) return null;
  if (cursorMs < pts[0].ts_ms) return null;
  // Binary search for the rightmost point with ts_ms <= cursorMs.
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].ts_ms <= cursorMs) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo].net;
}
