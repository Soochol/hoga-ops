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

import type { Drawing, Hline, Pencil, Trendline } from './types';

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
    case 'trendline':
      return translateTrendline(drawing, dMs, dPrice);
    case 'pencil':
      return translatePencil(drawing, dMs, dPrice);
  }
}

function translateHline(h: Hline, dPrice: number): Partial<Hline> {
  return { price: h.price + dPrice };
}

function translateTrendline(t: Trendline, dMs: number, dPrice: number): Partial<Trendline> {
  return {
    a: { realMs: t.a.realMs + dMs, price: t.a.price + dPrice },
    b: { realMs: t.b.realMs + dMs, price: t.b.price + dPrice },
  };
}

function translatePencil(p: Pencil, dMs: number, dPrice: number): Partial<Pencil> {
  return {
    points: p.points.map((pt) => ({
      realMs: pt.realMs + dMs,
      price: pt.price + dPrice,
    })),
  };
}
