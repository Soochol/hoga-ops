import type { ProgramTradePoint, ProgramTradeSeries } from '../api/types';

function nullableSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function livePoint(snapshot: Record<string, unknown>): ProgramTradePoint | null {
  const t = snapshot.t_ms;
  if (typeof t !== 'number' || !Number.isSafeInteger(t)) return null;
  return {
    t,
    net_qty: nullableSafeInteger(snapshot.net_qty),
    net_amount: nullableSafeInteger(snapshot.net_amount),
    // 0w raw frames expose cumulative values only. Do not fabricate the
    // collector's 30-second delta semantics at the per-frame display cadence.
    delta_qty: null,
    delta_amount: null,
    gap_risk: false,
  };
}

// API 필터 결과는 불변 배열이다. 저장 이력의 중복 제거·정렬은 배열이 바뀔 때만 한다.
const historyCache = new WeakMap<ProgramTradePoint[], {
  points: ProgramTradePoint[];
  seamMs: number;
}>();
const EMPTY_POINTS: ProgramTradePoint[] = [];

function normalizedHistory(points: ProgramTradePoint[]) {
  const cached = historyCache.get(points);
  if (cached) return cached;
  let seamMs = -Infinity;
  const byTime = new Map<number, ProgramTradePoint>();
  for (const point of points) {
    if (point.t > seamMs) seamMs = point.t;
    byTime.set(point.t, point);
  }
  const result = { points: [...byTime.values()].sort((a, b) => a.t - b.t), seamMs };
  historyCache.set(points, result);
  return result;
}

/**
 * Join durable program-trade history to the display-only WebSocket tail.
 *
 * The persisted global max timestamp is the seam. Points at or before it stay
 * owned by /api/range; only later live snapshots are appended. Normalize the
 * immutable history once, then deduplicate/sort only the live tail. Both keep
 * last-wins timestamps and tolerate retrograde delivery.
 */
export function mergeProgramTradeSeriesWithLiveTail(
  persisted: ProgramTradeSeries | null | undefined,
  liveSnapshots: readonly Record<string, unknown>[],
): ProgramTradeSeries {
  const history = normalizedHistory(persisted?.points ?? EMPTY_POINTS);
  const byTime = new Map<number, ProgramTradePoint>();
  for (const snapshot of liveSnapshots) {
    const point = livePoint(snapshot);
    if (point !== null && point.t > history.seamMs) byTime.set(point.t, point);
  }

  return {
    source: persisted?.source ?? 'kis_program_trade',
    points: byTime.size === 0 ? history.points
      : history.points.concat([...byTime.values()].sort((a, b) => a.t - b.t)),
  };
}
