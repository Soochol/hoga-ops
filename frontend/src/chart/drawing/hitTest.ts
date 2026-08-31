// frontend/src/chart/drawing/hitTest.ts

import type { Drawing, PaneId } from './types';
import { HIT_THRESHOLD, subBarOffsetPx, isLocked, isExtendedRight, rectXSpan } from './types';

/**
 * The subset the pointer-events gate hit-tests against: everything that is not
 * locked. Lives here, beside `hitTestDrawings`, because the two are only ever
 * used together and the ORDER of composition is the whole point.
 *
 * Filter the list, then hit-test — never hit-test, then check the winner for
 * `locked`. `hitTestDrawings` returns the TOPMOST match, so a locked drawing
 * drawn over an unlocked one would answer for both, and the live shape beneath
 * it would silently stop being grabbable. See ADR-0164.
 */
export function unlockedOnly(drawings: readonly Drawing[]): Drawing[] {
  return drawings.filter((d) => !isLocked(d));
}

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
  /**
   * PLOT width in CSS px — `timeScale().width()`, i.e. the canvas the renderer
   * actually draws on, EXCLUDING the price-axis gutter.
   *
   * It exists because the two widths differ and the difference is visible.
   * Render runs under a pane primitive whose `ctx.width` is the plot area;
   * hit-test runs off the DOM overlay container, which is `inset-0` and so
   * spans the gutter too (~50-70px wider). Feeding the container width into
   * `rectXSpan` would put an extended rect's right edge past where it is drawn
   * — the box would swallow clicks over the price axis and kill axis dragging
   * there. Falls back to `canvasWidth` for stubs that don't supply it, which is
   * exactly the pre-existing arithmetic.
   */
  plotWidth?: number;
  /** Pixel width of `text` at `sizePx`, using the same font as render — needed
   *  for the text-label bounding box. Optional for the same back-compat reason. */
  measureTextWidth?: (text: string, sizePx: number) => number;
  /** Effective bar width in canvas px, for a pencil point's sub-bar offset.
   *  MUST match what the renderer used (`ProjectCtx.barPx`) or a stroke becomes
   *  grabbable off its drawn position. Absent → offsets read as 0, the
   *  bar-anchored geometry, which is also what every pre-subX stub gets. */
  barPx?: number;
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
        rectBorderHit({ x: px, y: py }, coord, d.a, d.b, d.paneId, isExtendedRight(d)) ||
        rectInteriorHit({ x: px, y: py }, coord, d.a, d.b, d.paneId, isExtendedRight(d))
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
      // Straight chords between the vertices, while the RENDERER draws a
      // Catmull-Rom spline through them (see `smooth.ts`). The two therefore
      // disagree slightly — but the spline interpolates its vertices, so the
      // gap is only the bow between consecutive ones, and it is bounded far
      // below this kind's threshold. Measured on /live (1분봉, 봉 28px, 60
      // spans, longest chord 72.6px): **max deviation 1.23px** against
      // HIT_THRESHOLD.pencil = 8. The two cannot drift apart either — a long
      // chord only appears where RDP found the stroke nearly straight, and a
      // straight span bows by nothing.
      //
      // Flattening the Béziers here would close the gap exactly, at the cost
      // of ~8× the geometry on a path that runs every hover frame. Revisit
      // that trade only if the threshold drops or ε rises.
      const poly: Pixel[] = [];
      d.points.forEach((pt, i) => {
        const x = coord.realMsToCanvasX(pt.realMs);
        const y = coord.priceToCanvasY(pt.price, d.paneId);
        // Same offset the renderer applies — see `subBarOffsetPx`.
        if (x != null && y != null) poly.push({ x: x + subBarOffsetPx(d, i, coord.barPx), y });
      });
      if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) return d;
    }
  }
  return null;
}

/** A pixel-space selection rectangle (마퀴), already min/max-normalized. */
export type MarqueeRect = { x1: number; y1: number; x2: number; y2: number };

/** Normalize a drag's two corners into a MarqueeRect. */
export function marqueeRect(ax: number, ay: number, bx: number, by: number): MarqueeRect {
  return {
    x1: Math.min(ax, bx),
    y1: Math.min(ay, by),
    x2: Math.max(ax, bx),
    y2: Math.max(ay, by),
  };
}

/** Axis-aligned box overlap (touching counts). */
function boxesOverlap(a: MarqueeRect, b: MarqueeRect): boolean {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
}

/**
 * Liang–Barsky: does the segment p0→p1 intersect (or lie inside) the box?
 *
 * Picked over "test the four edges pairwise" because it also answers true for a
 * segment fully CONTAINED in the box — the common case when the user drags a
 * marquee around a short trendline — without a separate containment test.
 */
function segmentIntersectsBox(p0: Pixel, p1: Pixel, r: MarqueeRect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const clip: [number, number][] = [
    [-dx, p0.x - r.x1],
    [dx, r.x2 - p0.x],
    [-dy, p0.y - r.y1],
    [dy, r.y2 - p0.y],
  ];
  for (const [pp, qq] of clip) {
    if (pp === 0) {
      // Parallel to this edge: outside it → no intersection, ever.
      if (qq < 0) return false;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/** The right edge `rectXSpan` measures against — the PLOT width, matching what
 *  the renderer drew on. See `HitCoord.plotWidth`. */
function rightEdgeOf(coord: HitCoord): number {
  return coord.plotWidth ?? coord.canvasWidth ?? 0;
}

/** The rect/measure box in pixels, via the same `rectXSpan` the renderer uses
 *  (off-axis fallback + `extendRight`). Null when the price scale can't
 *  resolve, or when neither corner resolves horizontally. */
function boxOf(
  coord: HitCoord,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
  paneId: PaneId,
  extendRight = false,
): MarqueeRect | null {
  const ya = coord.priceToCanvasY(a.price, paneId);
  const yb = coord.priceToCanvasY(b.price, paneId);
  if (ya == null || yb == null) return null;
  const span = rectXSpan(
    coord.realMsToCanvasX(a.realMs),
    coord.realMsToCanvasX(b.realMs),
    rightEdgeOf(coord),
    extendRight,
  );
  if (span == null) return null;
  return marqueeRect(span.x1, ya, span.x2, yb);
}

/**
 * Every drawing that INTERSECTS the marquee rectangle, in list (z) order.
 *
 * Intersection, not containment. Containment is the wrong rule on a chart: an
 * hline spans the full canvas width and a vline the full height, so neither can
 * ever be "inside" a box the user drew — a containment marquee would silently
 * refuse to pick up the two most common drawings.
 *
 * Pane filtering is deliberately absent: `priceToCanvasY` returns CHART-GLOBAL
 * pixels (it adds the pane's top offset), so a shape on the indicator pane
 * already projects into that pane's band of the canvas. The marquee is drawn in
 * those same pixels, so "what the box visually covers" is exactly what this
 * returns — across panes, which is the behavior we want (a selection may span
 * panes; the drag path converts Δprice per member pane).
 *
 * Callers pass `unlockedOnly(drawings)` — filter, THEN test, the same ordering
 * rule ADR-0164 fixes for hit-testing. A locked shape must not join a set the
 * group-drag would then try (and fail) to move.
 */
export function drawingsInRect(
  coord: HitCoord,
  drawings: readonly Drawing[],
  rect: MarqueeRect,
): Drawing[] {
  const out: Drawing[] = [];
  for (const d of drawings) {
    if (hitsRect(coord, d, rect)) out.push(d);
  }
  return out;
}

function hitsRect(coord: HitCoord, d: Drawing, rect: MarqueeRect): boolean {
  switch (d.kind) {
    case 'vline': {
      const x = coord.realMsToCanvasX(d.realMs);
      return x != null && x >= rect.x1 && x <= rect.x2;
    }
    case 'hline': {
      const y = coord.priceToCanvasY(d.price, d.paneId);
      return y != null && y >= rect.y1 && y <= rect.y2;
    }
    case 'trendline':
    case 'measure': {
      const xa = coord.realMsToCanvasX(d.a.realMs);
      const ya = coord.priceToCanvasY(d.a.price, d.paneId);
      const xb = coord.realMsToCanvasX(d.b.realMs);
      const yb = coord.priceToCanvasY(d.b.price, d.paneId);
      if (xa == null || ya == null || xb == null || yb == null) return false;
      return segmentIntersectsBox({ x: xa, y: ya }, { x: xb, y: yb }, rect);
    }
    case 'rect': {
      // 마퀴도 **확장된 폭**을 본다 — 사용자가 둘러싼 것은 화면에 보이는 띠다.
      const box = boxOf(coord, d.a, d.b, d.paneId, isExtendedRight(d));
      return box != null && boxesOverlap(box, rect);
    }
    case 'text': {
      const projectX = coord.realMsToCanvasXClamped ?? coord.realMsToCanvasX;
      const x = projectX(d.at.realMs);
      const y = coord.priceToCanvasY(d.at.price, d.paneId);
      if (x == null || y == null) return false;
      const w = coord.measureTextWidth?.(d.text, d.fontSize) ?? 0;
      // Same box renderText draws into (and hitTestDrawings clicks), minus the
      // few px of click slop — a marquee is aimed, not fumbled for.
      return boxesOverlap({ x1: x, y1: y, x2: x + w, y2: y + d.fontSize }, rect);
    }
    case 'pencil': {
      const poly: Pixel[] = [];
      d.points.forEach((pt, i) => {
        const x = coord.realMsToCanvasX(pt.realMs);
        const y = coord.priceToCanvasY(pt.price, d.paneId);
        if (x != null && y != null) poly.push({ x: x + subBarOffsetPx(d, i, coord.barPx), y });
      });
      // A single-vertex stroke has no segment; fall back to the point itself so
      // a dot-stroke is still selectable.
      if (poly.length === 1) {
        const [q] = poly;
        return q.x >= rect.x1 && q.x <= rect.x2 && q.y >= rect.y1 && q.y <= rect.y2;
      }
      for (let i = 1; i < poly.length; i++) {
        if (segmentIntersectsBox(poly[i - 1], poly[i], rect)) return true;
      }
      return false;
    }
  }
}

/** True when pixel `p` is within rectBorder px of any of the rect's four edges.
 *  The box comes from `boxOf`, so the off-axis fallback and `extendRight` match
 *  render exactly — a rect straddling the visible edge stays selectable instead
 *  of vanishing from hit-testing. */
function rectBorderHit(
  p: Pixel,
  coord: HitCoord,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
  paneId: PaneId,
  extendRight = false,
): boolean {
  const box = boxOf(coord, a, b, paneId, extendRight);
  if (box == null) return false;
  const { x1, x2, y1, y2 } = box;
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
 *  `boxOf` as rectBorderHit, so a selected rect can be grabbed anywhere in its
 *  fill to move it — including the extended band, which is part of the shape
 *  the user sees. */
function rectInteriorHit(
  p: Pixel,
  coord: HitCoord,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
  paneId: PaneId,
  extendRight = false,
): boolean {
  const box = boxOf(coord, a, b, paneId, extendRight);
  if (box == null) return false;
  return p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2;
}
