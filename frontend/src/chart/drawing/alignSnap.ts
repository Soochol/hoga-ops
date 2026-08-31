// frontend/src/chart/drawing/alignSnap.ts
//
// Shape-to-shape alignment snapping — the "magnet" that makes a dragged
// rectangle grab its neighbours' edges instead of only the candle grid.
//
// How this differs from `snap.ts`. That module snaps the CURSOR to a candle,
// and it does so by wrapping the overlay's coordinate converters
// (`pixelToData`), so a tool never learns it was snapped. That works for the
// one-click tools, but it cannot express this feature: the thing that must
// line up is not the cursor, it is an EDGE of the shape being moved, and the
// candidate positions come from other shapes' geometry. So the question moves
// up a level — from pixels to boxes — and gets its own module.
//
// Three rules the kernel below encodes:
//
//  1. **Judge in pixels, commit in the domain.** Proximity is a visual
//     question, so the threshold is a pixel distance. But the value written
//     back is the TARGET's own domain value, copied verbatim — never a pixel
//     converted back. A pixel round-trip re-quantizes, and the two shapes
//     drift apart the next time the user zooms.
//
//  2. **The axes are independent.** X can snap while Y stays free. Anything
//     else makes the shape jump on an axis the user was not aiming at.
//
//  3. **3x3 anchors per axis.** min / max / center on both sides. That single
//     product covers both readings of "align": edge-flush (my left = your
//     left) AND abutment (my left = your right), which is the one the user
//     most likely means by "인접 사각형에 자석". No extra code path.
//
// The kernel is domain-agnostic: callers hand it numbers plus a converter to
// pixels. The drag path passes BAR ORDINALS for X (not realMs) because that is
// the domain body-drag already translates in — see `DragBarDomain` and the
// long note in selectTool.onPointerMove about inter-session gaps. Y is a plain
// pane price.

import type { PaneId } from './types';

/**
 * A guide line in DOMAIN coordinates, ready for any canvas to project.
 *
 * Same travelling shape as `GhostPreview`, and for the same reason spelled out
 * in render.ts: the overlay owns the chart-global knowledge needed to DECIDE
 * the line, while each pane primitive owns the projection that DRAWS it. A
 * pixel-space guide would be right on exactly one of those canvases.
 */
export type AlignGuide = {
  axis: 'x' | 'y';
  /** Pane that owns the line. Other panes skip it — a price only means
   *  something on the scale it came from. */
  paneId: PaneId;
  /** x: the aligned realMs (the line is vertical). y: the aligned price. */
  at: number;
  /** Bounds on the OTHER axis — prices for a vertical line, realMs for a
   *  horizontal one — spanning both boxes so the line connects them. */
  from: number;
  to: number;
};

/** Snap threshold in canvas pixels. Deliberately tighter than `SNAP_PX` (16),
 *  which is a CURSOR-aim tolerance: this one fires on shape geometry the user
 *  is not aiming at directly, so a generous radius would grab constantly. */
export const ALIGN_SNAP_PX = 8;

/** The three snap anchors of one axis of a box. `center` is the midpoint, so
 *  a degenerate box (a point) has all three equal — which is exactly what the
 *  creation / resize paths want. */
export type Anchors = { min: number; max: number; center: number };

/** Anchors from two opposite coordinates, in either order (a rect's stored
 *  corners may be crossed — see `Rect.a`/`Rect.b`). */
export function anchorsOf(v1: number, v2: number): Anchors {
  const min = Math.min(v1, v2);
  const max = Math.max(v1, v2);
  return { min, max, center: (min + max) / 2 };
}

/** Anchors for a single coordinate — a point, used when only one corner moves
 *  (rect resize) or when a shape is still being drawn. */
export function pointAnchors(v: number): Anchors {
  return { min: v, max: v, center: v };
}

/** One candidate the moving box may align to, already reduced to anchors. */
export type SnapBox = { id: string; x: Anchors; y: Anchors };

/**
 * A guide line to draw for a snap that fired, in the SAME domain the kernel
 * was given (bar ordinals for x, prices for y — the caller converts).
 *
 * `at` is the aligned coordinate on the snapping axis; `from`/`to` bound the
 * line on the other axis, spanning both boxes so the line visibly connects
 * them rather than floating next to one.
 */
export type RawAlignGuide = {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
};

export type AlignSnapResult = {
  /** Correction to ADD to every x coordinate of the moving box. 0 = no snap. */
  dx: number;
  /** Correction to ADD to every y coordinate of the moving box. 0 = no snap. */
  dy: number;
  guides: RawAlignGuide[];
};

const NO_SNAP: AlignSnapResult = { dx: 0, dy: 0, guides: [] };

type AxisHit = { delta: number; at: number; targetId: string };

const ANCHOR_KEYS = ['min', 'max', 'center'] as const;

/**
 * Nearest anchor pairing on one axis, or null when nothing is within
 * `thresholdPx`.
 *
 * Ties resolve to the first pair in (moving min→max→center) x (target
 * min→max→center) order, which makes the result deterministic — a coin-flip
 * here would show up as a guide line that flickers between two equidistant
 * neighbours.
 *
 * A candidate whose pixel position is unresolvable (`toPx` → null, e.g. a
 * price outside a mounted scale) is skipped rather than treated as distance 0.
 */
function snapAxis(
  moving: Anchors,
  targets: readonly { id: string; anchors: Anchors }[],
  toPx: (v: number) => number | null,
  thresholdPx: number,
): AxisHit | null {
  let best: AxisHit | null = null;
  let bestDist = thresholdPx;
  for (const mk of ANCHOR_KEYS) {
    const mv = moving[mk];
    const mpx = toPx(mv);
    if (mpx == null) continue;
    for (const t of targets) {
      for (const tk of ANCHOR_KEYS) {
        const tv = t.anchors[tk];
        const tpx = toPx(tv);
        if (tpx == null) continue;
        const d = Math.abs(tpx - mpx);
        // Strict `<` keeps the first winner on a tie (see the determinism note).
        if (d < bestDist) {
          bestDist = d;
          best = { delta: tv - mv, at: tv, targetId: t.id };
        }
      }
    }
  }
  return best;
}

/** Union of two closed intervals — the guide line's extent across both boxes. */
function span(a: Anchors, aShift: number, b: Anchors): { from: number; to: number } {
  return {
    from: Math.min(a.min + aShift, b.min),
    to: Math.max(a.max + aShift, b.max),
  };
}

/**
 * Snap `moving` to the nearest of `targets` on each axis independently.
 *
 * `acceptX` / `acceptY` let the caller veto a correction it cannot actually
 * apply — the drag path uses them to reject a snap that its pane/axis clamps
 * would trim, because a TRIMMED snap is the worst outcome available: the guide
 * line says "aligned" while the shape sits a few pixels off. Vetoing one axis
 * leaves the other one's snap intact, per rule 2 above.
 */
export function alignSnapBox(
  moving: { x: Anchors; y: Anchors },
  targets: readonly SnapBox[],
  ctx: {
    xToPx(v: number): number | null;
    yToPx(v: number): number | null;
    thresholdPx?: number;
    acceptX?(dx: number): boolean;
    acceptY?(dy: number): boolean;
  },
): AlignSnapResult {
  if (targets.length === 0) return NO_SNAP;
  const threshold = ctx.thresholdPx ?? ALIGN_SNAP_PX;

  const xHitRaw = snapAxis(
    moving.x,
    targets.map((t) => ({ id: t.id, anchors: t.x })),
    ctx.xToPx,
    threshold,
  );
  const yHitRaw = snapAxis(
    moving.y,
    targets.map((t) => ({ id: t.id, anchors: t.y })),
    ctx.yToPx,
    threshold,
  );

  const xHit = xHitRaw && (ctx.acceptX?.(xHitRaw.delta) ?? true) ? xHitRaw : null;
  const yHit = yHitRaw && (ctx.acceptY?.(yHitRaw.delta) ?? true) ? yHitRaw : null;

  const dx = xHit?.delta ?? 0;
  const dy = yHit?.delta ?? 0;

  // Guides are built AFTER both vetoes resolve, so a line's cross-axis extent
  // reflects where the box actually lands — not where it would have landed if
  // the other axis had also snapped.
  const guides: RawAlignGuide[] = [];
  if (xHit) {
    const t = targets.find((c) => c.id === xHit.targetId);
    if (t) guides.push({ axis: 'x', at: xHit.at, ...span(moving.y, dy, t.y) });
  }
  if (yHit) {
    const t = targets.find((c) => c.id === yHit.targetId);
    if (t) guides.push({ axis: 'y', at: yHit.at, ...span(moving.x, dx, t.x) });
  }
  return { dx, dy, guides };
}
