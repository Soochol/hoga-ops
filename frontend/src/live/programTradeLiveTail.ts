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

/**
 * Join durable program-trade history to the display-only WebSocket tail.
 *
 * The persisted global max timestamp is the seam. Points at or before it stay
 * owned by /api/range; only later live snapshots are appended. A Map makes
 * duplicate live timestamps last-wins, matching the sidecar store's overwrite
 * behavior, and the final sort tolerates retrograde WebSocket delivery.
 */
export function mergeProgramTradeSeriesWithLiveTail(
  persisted: ProgramTradeSeries | null | undefined,
  liveSnapshots: readonly Record<string, unknown>[],
): ProgramTradeSeries {
  const persistedPoints = persisted?.points ?? [];
  let seamMs = -Infinity;
  for (const point of persistedPoints) {
    if (point.t > seamMs) seamMs = point.t;
  }

  const byTime = new Map<number, ProgramTradePoint>();
  for (const point of persistedPoints) byTime.set(point.t, point);
  for (const snapshot of liveSnapshots) {
    const point = livePoint(snapshot);
    if (point !== null && point.t > seamMs) byTime.set(point.t, point);
  }

  return {
    source: persisted?.source ?? 'kis_program_trade',
    points: [...byTime.values()].sort((a, b) => a.t - b.t),
  };
}
