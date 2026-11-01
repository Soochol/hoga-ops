import type { XY, Segment } from './analysisGeometry';

/** Shared by painting, picking and marquee selection, including extensions. */
export function extendSegment(a: XY, b: XY, width: number, left = false, right = false): Segment {
  const first = a.x <= b.x ? a : b, last = a.x <= b.x ? b : a;
  const dx = last.x - first.x, dy = last.y - first.y;
  if (Math.abs(dx) < 0.001) {
    return { a: { x: a.x, y: left ? -1e6 : Math.min(a.y, b.y) },
      b: { x: b.x, y: right ? 1e6 : Math.max(a.y, b.y) } };
  }
  const at = (x: number): XY => ({ x, y: first.y + (x - first.x) * dy / dx });
  return { a: left ? at(Math.min(0, first.x)) : first,
    b: right ? at(Math.max(width, last.x)) : last };
}
