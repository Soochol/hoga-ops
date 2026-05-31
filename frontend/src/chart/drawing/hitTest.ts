// frontend/src/chart/drawing/hitTest.ts

import type { Drawing, PaneId } from './types';
import { HIT_THRESHOLD } from './types';

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

/** Coordinate projectors hitTestDrawings needs, injected so the geometry can
 * be tested with plain-number stubs instead of a live IChartApi (SR-5). These
 * are the same closures DrawingOverlay already builds over chart + axis.
 * `null` means the coordinate is off the current axis/pane and the drawing is
 * skipped. */
export interface HitCoord {
  realMsToCanvasX: (realMs: number) => number | null;
  priceToCanvasY: (price: number, paneId: PaneId) => number | null;
  paneIdAtY: (py: number) => PaneId | null;
}

/** Topmost drawing under pixel (px, py), or null. Iterates back-to-front so a
 * later-drawn (visually on top) drawing wins. Only drawings on the cursor's
 * pane are considered; each kind uses its own HIT_THRESHOLD. Pure: all chart
 * access is via the injected `coord` closures.
 *
 * Lifted verbatim from DrawingOverlay's former inline hitTestAt — the kind
 * dispatch (hline / trendline / pencil) and threshold compares are unchanged;
 * only the chart dependency became an injected bag so it is unit-testable. */
export function hitTestDrawings(
  coord: HitCoord,
  drawings: readonly Drawing[],
  px: number,
  py: number,
): Drawing | null {
  const cursorPaneId = coord.paneIdAtY(py);
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    if (d.paneId !== cursorPaneId) continue;
    if (d.kind === 'hline') {
      const y = coord.priceToCanvasY(d.price, d.paneId);
      if (y != null && distanceToHline({ x: px, y: py }, y) <= HIT_THRESHOLD.hline) return d;
    } else if (d.kind === 'trendline') {
      const xa = coord.realMsToCanvasX(d.a.realMs);
      const ya = coord.priceToCanvasY(d.a.price, d.paneId);
      const xb = coord.realMsToCanvasX(d.b.realMs);
      const yb = coord.priceToCanvasY(d.b.price, d.paneId);
      if (xa != null && ya != null && xb != null && yb != null &&
          distanceToSegment({ x: px, y: py }, { x: xa, y: ya }, { x: xb, y: yb }) <= HIT_THRESHOLD.trendlineBody) {
        return d;
      }
    } else if (d.kind === 'pencil') {
      const poly: Pixel[] = [];
      for (const pt of d.points) {
        const x = coord.realMsToCanvasX(pt.realMs);
        const y = coord.priceToCanvasY(pt.price, d.paneId);
        if (x != null && y != null) poly.push({ x, y });
      }
      if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) return d;
    }
  }
  return null;
}
