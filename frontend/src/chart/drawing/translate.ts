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

import type { Drawing, Hline, Measure, PaneId, Pencil, Rect, Text, Trendline, Vline } from './types';

/**
 * Horizontal shift for a translation: either a flat Δrealms or a mapping
 * function. The function form exists because the drag path shifts in the
 * screen-uniform BAR ORDINAL domain — `toReal(toBar(ms) + dBar)` is not
 * expressible as a constant real-ms delta across session boundaries (a flat
 * Δms lands vertices inside inter-session gaps; see DragBarDomain).
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
    // Sub-bar offsets survive a translation unchanged: `shift` moves whole bar
    // ordinals (see TimeShift / DragBarDomain), so every vertex keeps the same
    // position WITHIN its bar. Copied rather than shared because
    // `cloneWithOffset` builds a duplicate from this patch — the clone must not
    // alias the original's array. Absent stays absent (a pre-subX stroke does
    // not grow an all-zero array just by being dragged).
    ...(p.subX ? { subX: [...p.subX] } : {}),
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
 * Cap a requested body-drag Δbar (leftward) so that EVERY vertex of `drawing`
 * stays at or right of the axis origin — the time-axis sibling of
 * `clampDPriceForDrawing`. Without it a leftward drag past the first session
 * would clamp vertices one by one against the origin (the domain's toReal
 * floors there), permanently compressing the shape. Rightward needs no cap:
 * the future band is open-ended.
 *
 * `toBar` and `originBar` must come from the SAME DragBarDomain the caller
 * shifts with — the cap is a comparison in that domain's units.
 */
export function clampDBarForDrawing(
  drawing: Drawing,
  dBar: number,
  originBar: number,
  toBar: (realMs: number) => number,
): number {
  if (dBar >= 0) return dBar;
  const times = timesOf(drawing);
  if (times.length === 0) return dBar;
  let minBar = Infinity;
  for (const t of times) minBar = Math.min(minBar, toBar(t));
  return Math.max(dBar, originBar - minBar);
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

// ─── group translation (다중 선택 이동) ─────────────────────────────────────

/** Coordinate access `planGroupTranslate` needs, injected so the plan is a pure
 *  function of numbers (same SR-5 shape as HitCoord). */
export type GroupTranslateCoords = {
  priceToCanvasY(price: number, paneId: PaneId): number | null;
  canvasYToPrice(py: number, paneId: PaneId): number | null;
  priceBoundsForPane(paneId: PaneId): { top: number; bottom: number } | null;
  toBar(realMs: number): number;
  toReal(bar: number): number;
  originBar: number;
};

/** The magnitude-smaller of two same-signed deltas (0 wins over everything). */
function signedMin(a: number, b: number): number {
  return a >= 0 ? Math.min(a, b) : Math.max(a, b);
}

/**
 * Plan a group body-drag: one Δbar and one PIXEL Δy for the whole selection,
 * turned into per-drawing patches.
 *
 * Two things make this more than a loop over `translateDrawing`:
 *
 * **1. The vertical delta travels in PIXELS, not price.** A selection may span
 * panes, and each pane has its own price scale — a candle-pane Δprice of 500원
 * means nothing on an RSI pane. Carrying the cursor's Δy and converting it
 * per member (project the member's own reference price to Y, add Δy, read the
 * price back) is what makes cross-pane group drag land where the cursor went.
 * This is the same trick `duplicateSelectedRef` uses for its 14px offset.
 *
 * **2. The clamps are computed for the SET, then applied to everyone.** Capping
 * each member against its own pane bounds independently would stop the topmost
 * shape while the others kept going — the formation the user selected would
 * deform mid-drag. So each member reports the largest delta IT can take, and
 * the whole group moves by the smallest of those. That is the same
 * shape-preserving argument `clampDPriceForDrawing` makes for the vertices of
 * one drawing, one level up.
 *
 * Every member's allowance is computed against the RAW request (never against a
 * running minimum), so the result does not depend on the order of `members`.
 */
export function planGroupTranslate(
  members: readonly Drawing[],
  dBarRaw: number,
  dyPxRaw: number,
  coords: GroupTranslateCoords,
): { id: string; patch: Partial<Drawing> }[] {
  // ── horizontal: shared bar-ordinal domain, so cap directly in bars ──────
  let dBar = dBarRaw;
  for (const m of members) {
    dBar = signedMin(dBar, clampDBarForDrawing(m, dBarRaw, coords.originBar, coords.toBar));
  }

  // ── vertical: cap in PIXELS so panes with different scales agree ────────
  let dyPx = dyPxRaw;
  for (const m of members) {
    const prices = pricesOf(m);
    if (prices.length === 0) continue; // vline: no vertical component at all
    const bounds = coords.priceBoundsForPane(m.paneId);
    const ref = prices[0];
    const y0 = coords.priceToCanvasY(ref, m.paneId);
    if (bounds == null || y0 == null) continue;
    const want = coords.canvasYToPrice(y0 + dyPxRaw, m.paneId);
    if (want == null) continue;
    const rawDPrice = want - ref;
    const capped = clampDPriceForDrawing(m, rawDPrice, bounds);
    if (capped === rawDPrice) continue;
    // Re-express this member's price cap as a pixel cap so it is comparable
    // with the other panes'.
    const yCap = coords.priceToCanvasY(ref + capped, m.paneId);
    if (yCap != null) dyPx = signedMin(dyPx, yCap - y0);
  }

  const shift = (ms: number) => coords.toReal(coords.toBar(ms) + dBar);
  const out: { id: string; patch: Partial<Drawing> }[] = [];
  for (const m of members) {
    const prices = pricesOf(m);
    let dPrice = 0;
    if (prices.length > 0 && dyPx !== 0) {
      const ref = prices[0];
      const y0 = coords.priceToCanvasY(ref, m.paneId);
      const moved = y0 == null ? null : coords.canvasYToPrice(y0 + dyPx, m.paneId);
      if (moved != null) dPrice = moved - ref;
    }
    // Emit even when both deltas are 0: the shift round-trip is the identity
    // for a healthy vertex and HEALS one stranded in an inter-session gap by an
    // old real-ms drag (same reasoning as the single-drag path).
    out.push({ id: m.id, patch: translateDrawing(m, shift, dPrice) });
  }
  return out;
}
