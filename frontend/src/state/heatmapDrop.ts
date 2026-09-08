import type { ChartDropEntry } from './entryDrag';

type Point = { x: number; y: number };
type HeatmapDropResolver = (point: Point, entry: ChartDropEntry) => boolean;
let resolver: HeatmapDropResolver | null = null;

/** The mounted heatmap owns hit testing; panels only submit a single Code.
 * Returning true consumes the gesture, including duplicate/busy drops. */
export function registerHeatmapDropTarget(next: HeatmapDropResolver): () => void {
  resolver = next;
  return () => { if (resolver === next) resolver = null; };
}

export function resolveDropOnHeatmap(point: Point | null, entry: ChartDropEntry): boolean {
  return point !== null && /^\d{6}$/.test(entry.code) && (resolver?.(point, entry) ?? false);
}
