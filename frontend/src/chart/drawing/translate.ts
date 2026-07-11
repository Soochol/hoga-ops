// frontend/src/chart/drawing/translate.ts
//
// Drawing translation — the per-kind dispatcher that maps a (Δrealms,
// Δprice) into the shape-specific store patch. Lives in the drawing
// module so selectTool stays narrow (a tool is an interaction policy,
// not a geometry library) and so future drawing primitives plug in by
// extending one switch rather than threading through selectTool's
// onPointerMove.
//
// Hline carries no realMs of its own (it spans the full canvas width),
// so its translate-by-(Δms, Δprice) collapses to a price-only shift.
// Trendline shifts both endpoints. Pencil shifts every vertex.

import type { Drawing, Hline, Measure, Pencil, Rect, Text, Trendline, Vline } from './types';

/**
 * Body-drag translation: shift the whole drawing by (Δrealms, Δprice).
 * Returns the partial patch a caller passes to the store's `update`.
 */
export function translateDrawing(
  drawing: Drawing,
  dMs: number,
  dPrice: number,
): Partial<Drawing> {
  switch (drawing.kind) {
    case 'hline':
      return translateHline(drawing, dPrice);
    case 'vline':
      return translateVline(drawing, dMs);
    case 'trendline':
      return translateTrendline(drawing, dMs, dPrice);
    case 'rect':
      return translateRect(drawing, dMs, dPrice);
    case 'measure':
      return translateMeasure(drawing, dMs, dPrice);
    case 'text':
      return translateText(drawing, dMs, dPrice);
    case 'pencil':
      return translatePencil(drawing, dMs, dPrice);
  }
}

function translateHline(h: Hline, dPrice: number): Partial<Hline> {
  return { price: h.price + dPrice };
}

function translateVline(v: Vline, dMs: number): Partial<Vline> {
  // Time-only: vline carries no price, so Δprice is discarded (mirrors how
  // hline discards Δms).
  return { realMs: v.realMs + dMs };
}

function translateTrendline(t: Trendline, dMs: number, dPrice: number): Partial<Trendline> {
  return {
    a: { realMs: t.a.realMs + dMs, price: t.a.price + dPrice },
    b: { realMs: t.b.realMs + dMs, price: t.b.price + dPrice },
  };
}

function translateRect(r: Rect, dMs: number, dPrice: number): Partial<Rect> {
  return {
    a: { realMs: r.a.realMs + dMs, price: r.a.price + dPrice },
    b: { realMs: r.b.realMs + dMs, price: r.b.price + dPrice },
  };
}

function translateMeasure(m: Measure, dMs: number, dPrice: number): Partial<Measure> {
  return {
    a: { realMs: m.a.realMs + dMs, price: m.a.price + dPrice },
    b: { realMs: m.b.realMs + dMs, price: m.b.price + dPrice },
  };
}

function translateText(t: Text, dMs: number, dPrice: number): Partial<Text> {
  return { at: { realMs: t.at.realMs + dMs, price: t.at.price + dPrice } };
}

function translatePencil(p: Pencil, dMs: number, dPrice: number): Partial<Pencil> {
  return {
    points: p.points.map((pt) => ({
      realMs: pt.realMs + dMs,
      price: pt.price + dPrice,
    })),
  };
}

/** Every price-bearing vertex of a Drawing (in pane Y-domain units). A vline
 *  has none, so it returns [] — clampDPriceForDrawing then leaves Δprice
 *  unclamped, which is correct (vline never moves vertically). */
export function pricesOf(drawing: Drawing): number[] {
  switch (drawing.kind) {
    case 'hline':
      return [drawing.price];
    case 'vline':
      return [];
    case 'trendline':
      return [drawing.a.price, drawing.b.price];
    case 'rect':
      return [drawing.a.price, drawing.b.price];
    case 'measure':
      return [drawing.a.price, drawing.b.price];
    case 'text':
      return [drawing.at.price];
    case 'pencil':
      return drawing.points.map((p) => p.price);
  }
}

/**
 * Cap a requested body-drag Δprice so that EVERY vertex of `drawing`
 * stays within the pane's price bounds after translation. The cap is
 * shape-preserving: the same dPrice is applied to all vertices, so the
 * trendline's spread / pencil's curvature survive a boundary hit. A
 * post-translate per-vertex clamp would have collapsed the shape at
 * the edge — see the v1 grill pass and the body-drag-shear note.
 *
 * Bounds may be in either order (top > bottom for KRW, bottom > top
 * on inverted scales); we sort internally.
 */
export function clampDPriceForDrawing(
  drawing: Drawing,
  dPrice: number,
  bounds: { top: number; bottom: number },
): number {
  const lo = Math.min(bounds.top, bounds.bottom);
  const hi = Math.max(bounds.top, bounds.bottom);
  const prices = pricesOf(drawing);
  // Freeze the drag if any vertex is already outside the bounds (e.g. an
  // autoscale shift while a drag is in flight). The alternative — letting
  // the clamp snap the drawing back to the edge — would surprise-yank it
  // out from under the cursor.
  for (const p of prices) {
    if (p < lo || p > hi) return 0;
  }
  let maxUp = Infinity;     // largest positive dPrice keeping every vertex ≤ hi
  let maxDown = -Infinity;  // most negative dPrice keeping every vertex ≥ lo
  for (const p of prices) {
    maxUp = Math.min(maxUp, hi - p);
    maxDown = Math.max(maxDown, lo - p);
  }
  return Math.max(maxDown, Math.min(maxUp, dPrice));
}
