import type { BrokerSeriesEntry } from '../api/types';


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
