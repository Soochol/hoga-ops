import type { MouseEventParams } from 'lightweight-charts';

type Snapshot = Pick<MouseEventParams, 'time' | 'seriesData'> | null;

/** Legend values depend on the bar and series data, never pointer X/Y. Copy
 * point records so an intrabar update cannot mutate the comparison baseline. */
export function legendCrosshairSnapshot(param: MouseEventParams): Snapshot {
  if (param.point == null) return null;
  return { time: param.time, seriesData: new Map(
    Array.from(param.seriesData ?? [], ([series, data]) => [series, { ...data }]),
  ) };
}

export function sameLegendCrosshair(a: Snapshot, b: Snapshot): boolean {
  if (a === null || b === null) return a === b;
  if (a.time !== b.time || a.seriesData.size !== b.seriesData.size) return false;
  for (const [series, value] of a.seriesData) {
    const next = b.seriesData.get(series);
    if (!next) return false;
    const before = value as unknown as Record<string, unknown>;
    const after = next as unknown as Record<string, unknown>;
    const keys = Object.keys(before);
    if (keys.length !== Object.keys(after).length || keys.some(key => !Object.is(before[key], after[key]))) return false;
  }
  return true;
}
