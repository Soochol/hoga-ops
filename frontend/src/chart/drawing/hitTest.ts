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
  /** Off-axis-tolerant X for single-anchor drawings (text): snaps a gap/pre-axis
   *  realMs to the nearest session boundary so an off-axis text stays grabbable
   *  (it also renders clamped). Optional so existing test stubs that only cover
   *  hline/trendline/pencil still type-check; text falls back to
   *  `realMsToCanvasX` when absent. */
  realMsToCanvasXClamped?: (realMs: number) => number | null;
  priceToCanvasY: (price: number, paneId: PaneId) => number | null;
  paneIdAtY: (py: number) => PaneId | null;
  /** Overlay canvas width in CSS px. Lets a rect whose corner is off the
   *  virtual axis fall back to the visible edge (mirrors render). Optional so
   *  existing test stubs that only exercise hline/trendline/pencil still
   *  type-check. */
  canvasWidth?: number;
  /** Pixel width of `text` at `sizePx`, using the same font as render — needed
   *  for the text-label bounding box. Optional for the same back-compat reason. */
  measureTextWidth?: (text: string, sizePx: number) => number;
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
    // vline is pane-agnostic (spans every pane), so it's tested BEFORE the
    // per-pane filter — a cursor in any pane can grab it by horizontal
    // proximity alone.
    if (d.kind === 'vline') {
      const x = coord.realMsToCanvasX(d.realMs);
      if (x != null && Math.abs(px - x) <= HIT_THRESHOLD.vline) return d;
      continue;
    }
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
    } else if (d.kind === 'rect' || d.kind === 'measure') {
      // A rect/measure is a solid box: clicking anywhere in the fill (or border)
      // grabs it to select/move — like every charting tool's filled shapes. The
      // chart is still pannable by starting the drag OUTSIDE the box. (Previously
      // border-only, which made a filled box feel unmovable — the reported bug.)
      if (
        rectBorderHit({ x: px, y: py }, coord, d.a, d.b, d.paneId) ||
        rectInteriorHit({ x: px, y: py }, coord, d.a, d.b, d.paneId)
      ) {
        return d;
      }
    } else if (d.kind === 'text') {
      // Clamped X mirrors renderText: an off-axis text is snapped to the
      // nearest session boundary so it stays grabbable where it's drawn (not
      // lost). Fall back to the plain projector for stubs without the clamp.
      const projectX = coord.realMsToCanvasXClamped ?? coord.realMsToCanvasX;
      const x = projectX(d.at.realMs);
      const y = coord.priceToCanvasY(d.at.price, d.paneId);
      const w = coord.measureTextWidth?.(d.text, d.fontSize) ?? 0;
      if (
        x != null &&
        y != null &&
        px >= x - 3 &&
        px <= x + w + 3 &&
        py >= y - 2 &&
        py <= y + d.fontSize + 4
      ) {
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

/** True when pixel `p` is within rectBorder px of any of the rect's four edges.
 *  Corners that fall off the virtual axis fall back to canvas bounds (0/…),
 *  mirroring the render-time fallback so a rect straddling the visible edge
 *  stays selectable instead of vanishing from hit-testing. */
function rectBorderHit(
  p: Pixel,
  coord: HitCoord,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
  paneId: PaneId,
): boolean {
  const xaRaw = coord.realMsToCanvasX(a.realMs);
  const xbRaw = coord.realMsToCanvasX(b.realMs);
  const ya = coord.priceToCanvasY(a.price, paneId);
  const yb = coord.priceToCanvasY(b.price, paneId);
  if (ya == null || yb == null) return false;
  if (xaRaw == null && xbRaw == null) return false;
  const width = coord.canvasWidth ?? 0;
  const xa = xaRaw ?? 0;
  const xb = xbRaw ?? width;
  const x1 = Math.min(xa, xb);
  const x2 = Math.max(xa, xb);
  const y1 = Math.min(ya, yb);
  const y2 = Math.max(ya, yb);
  const tl = { x: x1, y: y1 };
  const tr = { x: x2, y: y1 };
  const br = { x: x2, y: y2 };
  const bl = { x: x1, y: y2 };
  const edges: [Pixel, Pixel][] = [
    [tl, tr],
    [tr, br],
    [br, bl],
    [bl, tl],
  ];
  for (const [s, e] of edges) {
    if (distanceToSegment(p, s, e) <= HIT_THRESHOLD.rectBorder) return true;
  }
  return false;
}

/** True when pixel `p` is inside the rect's (min/max-normalized) box. Same
 *  projection + off-axis fallback as rectBorderHit, so a selected rect can be
 *  grabbed anywhere in its fill to move it. */
function rectInteriorHit(
  p: Pixel,
  coord: HitCoord,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
  paneId: PaneId,
): boolean {
  const xaRaw = coord.realMsToCanvasX(a.realMs);
  const xbRaw = coord.realMsToCanvasX(b.realMs);
  const ya = coord.priceToCanvasY(a.price, paneId);
  const yb = coord.priceToCanvasY(b.price, paneId);
  if (ya == null || yb == null) return false;
  if (xaRaw == null && xbRaw == null) return false;
  const width = coord.canvasWidth ?? 0;
  const xa = xaRaw ?? 0;
  const xb = xbRaw ?? width;
  return (
    p.x >= Math.min(xa, xb) &&
    p.x <= Math.max(xa, xb) &&
    p.y >= Math.min(ya, yb) &&
    p.y <= Math.max(ya, yb)
  );
}
