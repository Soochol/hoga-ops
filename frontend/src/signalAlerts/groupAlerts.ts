import type { SignalAlertEvent } from '../api/signalAlerts';

/**
 * One code's collapsed alert activity. The signal feed repeats the same code as
 * a wall renews (e.g. 대한항공 firing 5× in a minute), which buries the few
 * distinct names under duplicates. Grouping by code keeps the "recent activity"
 * ordering (latest first) while surfacing per-name intensity: how many times it
 * renewed (`count`) and the strongest renewal (`peakRatioPct`).
 */
export interface SignalAlertGroup {
  code: string;
  name: string;
  /** Most recent firing — drives ordering, the shown time, and the jump target. */
  latestTMs: number;
  latestValue: number;
  /** Strongest 기준-대비 across the group — the headline intensity. */
  peakRatioPct: number;
  count: number;
  /** Stable React key = the latest event's id. */
  key: string;
}

/** Collapse a flat alert list into per-code groups, ordered latest-first.
 *  Pure — no ordering assumption on the input (each group tracks its own max). */
export function groupSignalAlertsByCode(
  alerts: readonly SignalAlertEvent[],
): SignalAlertGroup[] {
  const byCode = new Map<string, SignalAlertGroup>();
  for (const a of alerts) {
    const g = byCode.get(a.code);
    if (!g) {
      byCode.set(a.code, {
        code: a.code,
        name: a.name,
        latestTMs: a.t_ms,
        latestValue: a.value,
        peakRatioPct: a.ratio_pct,
        count: 1,
        key: a.id,
      });
      continue;
    }
    g.count += 1;
    if (a.ratio_pct > g.peakRatioPct) g.peakRatioPct = a.ratio_pct;
    if (a.t_ms >= g.latestTMs) {
      g.latestTMs = a.t_ms;
      g.latestValue = a.value;
      g.name = a.name;
      g.key = a.id;
    }
  }
  return [...byCode.values()].sort((x, y) => y.latestTMs - x.latestTMs);
}
