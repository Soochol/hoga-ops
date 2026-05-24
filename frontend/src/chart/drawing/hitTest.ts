// frontend/src/chart/drawing/hitTest.ts

export type Pixel = { x: number; y: number };

/** Vertical distance from a pixel to a horizontal line at the given Y. */
export function distanceToHline(p: Pixel, lineY: number): number {
  return Math.abs(p.y - lineY);
}

/** Euclidean distance from a pixel to a line segment defined by endpoints a, b. */
export function distanceToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate: a == b. Treat as point distance.
    const px = p.x - a.x;
    const py = p.y - a.y;
    return Math.hypot(px, py);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/** Minimum distance from a pixel to any consecutive segment of a polyline. */
export function distanceToPolyline(p: Pixel, polyline: readonly Pixel[]): number {
  if (polyline.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const d = distanceToSegment(p, polyline[i - 1], polyline[i]);
    if (d < min) min = d;
  }
  return min;
}
