// frontend/src/chart/drawing/simplify.ts
//
// Ramer–Douglas–Peucker polyline simplification for the pencil tool. Run at
// commit time so a freehand stroke keeps its shape with far fewer points —
// smaller localStorage footprint (PENCIL_MAX_POINTS is a hard cap, this trims
// the common case) and a smoother line. Simplification is done in PIXEL space
// (constant epsilon reads as a constant on-screen tolerance) but the ORIGINAL
// data points at the surviving indices are returned, so realMs/price are never
// re-derived.

export type Px = { x: number; y: number };

/** Perpendicular distance from point p to the line through a→b (pixel space). */
function perpDistance(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // |cross product| / |a→b|
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Indices of `pts` kept by RDP at tolerance `epsilon` (always includes the
 *  first and last). Iterative stack to avoid deep recursion on long strokes. */
export function rdpKeptIndices(pts: readonly Px[], epsilon: number): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let maxDist = 0;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(pts[i], pts[lo], pts[hi]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxDist > epsilon) {
      keep[idx] = true;
      stack.push([lo, idx]);
      stack.push([idx, hi]);
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  return kept;
}

/**
 * Simplify `items` by projecting each to a pixel via `project`, running RDP at
 * `epsilon` px, and returning the original items at the surviving indices.
 * Items that fail to project (off-axis) are excluded from the RDP geometry but
 * always kept, so no data is silently dropped. Fewer than 3 items → unchanged.
 */
export function simplifyByPixels<T>(
  items: readonly T[],
  project: (item: T) => Px | null,
  epsilon: number,
): T[] {
  if (items.length < 3) return items.slice();
  const projected: Px[] = [];
  const projectedIndex: number[] = []; // projected[i] ↔ items[projectedIndex[i]]
  const unprojectable = new Set<number>();
  items.forEach((item, i) => {
    const px = project(item);
    if (px == null) {
      unprojectable.add(i);
    } else {
      projected.push(px);
      projectedIndex.push(i);
    }
  });
  if (projected.length < 3) return items.slice();
  const keptProjected = new Set(rdpKeptIndices(projected, epsilon).map((k) => projectedIndex[k]));
  return items.filter((_, i) => keptProjected.has(i) || unprojectable.has(i));
}

/** Default pencil simplification tolerance in canvas pixels. */
export const PENCIL_SIMPLIFY_EPSILON = 1.5;
