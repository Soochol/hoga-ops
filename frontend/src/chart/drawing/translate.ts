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
 * Horizontal shift for a translation: either a flat Δrealms or a mapping
 * function. The function form exists because the drag path shifts in the
 * gap-compressed VIRTUAL time domain — `toReal(toVirtual(ms) + dVirtual)` is
 * not expressible as a constant real-ms delta across session boundaries
 * (a flat Δms lands vertices inside inter-session gaps; see DragTimeDomain).
 */
export type TimeShift = number | ((realMs: number) => number);

function toShiftFn(dMs: TimeShift): (realMs: number) => number {
  return typeof dMs === 'function' ? dMs : (ms) => ms + dMs;
}

/**
 * Body-drag translation: shift the whole drawing by (Δrealms, Δprice).
 * Returns the partial patch a caller passes to the store's `update`.
 */
export function translateDrawing(
  drawing: Drawing,
  dMs: TimeShift,
  dPrice: number,
): Partial<Drawing> {
  const shift = toShiftFn(dMs);
  switch (drawing.kind) {
    case 'hline':
      return translateHline(drawing, dPrice);
    case 'vline':
      return translateVline(drawing, shift);
    case 'trendline':
      return translateTrendline(drawing, shift, dPrice);
    case 'rect':
      return translateRect(drawing, shift, dPrice);
    case 'measure':
      return translateMeasure(drawing, shift, dPrice);
    case 'text':
      return translateText(drawing, shift, dPrice);
    case 'pencil':
      return translatePencil(drawing, shift, dPrice);
  }
}

type ShiftFn = (realMs: number) => number;

function translateHline(h: Hline, dPrice: number): Partial<Hline> {
  return { price: h.price + dPrice };
}

function translateVline(v: Vline, shift: ShiftFn): Partial<Vline> {
  // Time-only: vline carries no price, so Δprice is discarded (mirrors how
  // hline discards Δms).
  return { realMs: shift(v.realMs) };
}

function translateTrendline(t: Trendline, shift: ShiftFn, dPrice: number): Partial<Trendline> {
  return {
    a: { realMs: shift(t.a.realMs), price: t.a.price + dPrice },
    b: { realMs: shift(t.b.realMs), price: t.b.price + dPrice },
  };
}

function translateRect(r: Rect, shift: ShiftFn, dPrice: number): Partial<Rect> {
  return {
    a: { realMs: shift(r.a.realMs), price: r.a.price + dPrice },
    b: { realMs: shift(r.b.realMs), price: r.b.price + dPrice },
  };
}

function translateMeasure(m: Measure, shift: ShiftFn, dPrice: number): Partial<Measure> {
  return {
    a: { realMs: shift(m.a.realMs), price: m.a.price + dPrice },
    b: { realMs: shift(m.b.realMs), price: m.b.price + dPrice },
  };
}

function translateText(t: Text, shift: ShiftFn, dPrice: number): Partial<Text> {
  return { at: { realMs: shift(t.at.realMs), price: t.at.price + dPrice } };
}

function translatePencil(p: Pencil, shift: ShiftFn, dPrice: number): Partial<Pencil> {
  return {
    points: p.points.map((pt) => ({
      realMs: shift(pt.realMs),
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

/** Every time-bearing vertex of a Drawing (real Unix-ms). An hline has none,
 *  so it returns [] — clampDVirtualForDrawing then leaves Δvirtual unclamped,
 *  which is correct (hline discards the horizontal shift entirely). */
export function timesOf(drawing: Drawing): number[] {
  switch (drawing.kind) {
    case 'hline':
      return [];
    case 'vline':
      return [drawing.realMs];
    case 'trendline':
      return [drawing.a.realMs, drawing.b.realMs];
    case 'rect':
      return [drawing.a.realMs, drawing.b.realMs];
    case 'measure':
      return [drawing.a.realMs, drawing.b.realMs];
    case 'text':
      return [drawing.at.realMs];
    case 'pencil':
      return drawing.points.map((p) => p.realMs);
  }
}

/**
 * Cap a requested body-drag Δvirtual (leftward) so that EVERY vertex of
 * `drawing` stays at or right of the axis origin — the time-axis sibling of
 * `clampDPriceForDrawing`. Without it a leftward drag past the first session
 * would clamp vertices one by one against the origin (axis.toReal floors
 * there), permanently compressing the shape. Rightward needs no cap: the
 * future band is open-ended.
 */
export function clampDVirtualForDrawing(
  drawing: Drawing,
  dVirtual: number,
  originV: number,
  toVirtual: (realMs: number) => number,
): number {
  if (dVirtual >= 0) return dVirtual;
  const times = timesOf(drawing);
  if (times.length === 0) return dVirtual;
  let minV = Infinity;
  for (const t of times) minV = Math.min(minV, toVirtual(t));
  return Math.max(dVirtual, originV - minV);
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
