# Drawing Kind Spec — concentrate per-`DrawingKind` behaviour

Deepening refactor for the drawing module. Surfaces a sibling registry
to **Drawing Tool**: **Drawing Kind Spec** — the single owner of all
per-`DrawingKind` (hline / trendline / pencil) data behaviour (render,
hit-test, translate, hit-threshold).

## Motivation

CONTEXT.md (Drawing Tool entry) claims that adding a new drawing
primitive (vertical line, fibonacci, text label) is "one new spec
object plus a registry entry — no edits in Drawing Overlay or Drawing
Menu". This is half-true today.

Adding a `vline` primitive currently requires edits in:

1. `drawing/types.ts` — extend `DrawingKind` union, extend `HIT_THRESHOLD`
2. `drawing/tools.ts` — new `DrawingToolSpec` (the claim's "one spec")
3. `drawing/render.ts` — new `renderVline` + a branch in `renderDrawing`
4. `drawing/translate.ts` — new `translateVline` + a branch in `translateDrawing`
5. `chart/DrawingOverlay.tsx` — new branch in `hitTestAt`

Five sites, four switches on `d.kind`. The deepening claim is only
realised for *interaction* (which tool is active) — not for the
*Drawing* itself.

`DrawingOverlay.hitTestAt` is the most painful leak: it threads
coordinate helpers through a 30-line switch that knows each primitive's
geometry. That code does not belong in the overlay; it belongs in the
drawing module.

## Goal

Introduce **Drawing Kind Spec** as the per-`DrawingKind` analogue of
**Drawing Tool Spec**. After this refactor:

- Adding a primitive = one `DrawingToolSpec` + one `DrawingKindSpec` +
  one `DrawingKind` union member. Three sites — all in `drawing/`.
- `DrawingOverlay.hitTestAt` shrinks to ~10 lines: iterate drawings,
  dispatch into the registry.
- `render.ts` becomes a thin re-export of `KIND_SPECS[d.kind].render(...)`
  plus the shared helpers (`drawHaloThenMain`, `drawPriceBadge`,
  `luminance`).
- `translate.ts` collapses to a one-line dispatcher (or is absorbed).

## Non-goals

- New drawing primitives. The refactor enables future additions; it
  doesn't ship one.
- Changes to the `Drawing` data model or persistence format.
- Changes to `DrawingToolSpec` (tool interaction stays as-is).
- Changes to the `lightweight-charts` rendering pipeline.

## Design

### New module: `frontend/src/chart/drawing/kinds.ts`

```ts
import type { CanvasRenderingContext2D } from '...'; // ambient
import type { ProjectCtx } from './render';
import type { Pixel } from './hitTest';
import type { Drawing, DrawingKind, Hline, Pencil, Trendline } from './types';

export type CoordHelpers = {
  realMsToCanvasX(realMs: number): number | null;
  priceToCanvasY(price: number): number | null;
};

export interface DrawingKindSpec<D extends Drawing = Drawing> {
  kind: D['kind'];
  /** Hit-test radius in canvas-space pixels for *body* hits. Endpoint /
   *  handle thresholds (trendline handle) live separately because they
   *  are UI affordances, not per-kind geometry. */
  hitThreshold: number;
  /** Render the drawing onto the canvas. Selection halo is the
   *  responsibility of the spec — it can call `drawHaloThenMain` or
   *  draw its own selected state. */
  render(c: CanvasRenderingContext2D, ctx: ProjectCtx, d: D, selected: boolean): void;
  /** Return true if `p` (canvas pixel) hits the drawing within
   *  `hitThreshold`. The helpers convert stored realMs/price into
   *  canvas coordinates. Returns false if the helpers can't resolve
   *  (e.g. price scale unavailable). */
  hitTest(d: D, p: Pixel, helpers: CoordHelpers): boolean;
  /** Body-drag translation: shift the whole drawing by
   *  (Δrealms, Δprice). Returns the partial patch the store consumes. */
  translate(d: D, dMs: number, dPrice: number): Partial<D>;
}

export const hlineKind: DrawingKindSpec<Hline> = { ... };
export const trendlineKind: DrawingKindSpec<Trendline> = { ... };
export const pencilKind: DrawingKindSpec<Pencil> = { ... };

export const KIND_SPECS = {
  hline: hlineKind,
  trendline: trendlineKind,
  pencil: pencilKind,
} satisfies Record<DrawingKind, DrawingKindSpec>;

/** Convenience accessor that preserves the narrowed kind type. */
export function specOf<D extends Drawing>(d: D): DrawingKindSpec<D> {
  return KIND_SPECS[d.kind] as DrawingKindSpec<D>;
}
```

### Touched files (post-refactor)

- **NEW** `drawing/kinds.ts` — owns three `DrawingKindSpec` values + `KIND_SPECS` registry + `CoordHelpers` type.
- **NEW** `drawing/kinds.test.ts` — per-spec unit tests (one describe block per kind).
- **MODIFY** `drawing/types.ts` — remove `HIT_THRESHOLD.hline/trendlineBody/pencil` (moved to kinds.ts). Keep `HIT_THRESHOLD.trendlineHandle` (it's an endpoint affordance, not per-kind body geometry).
- **MODIFY** `drawing/render.ts` — keep `drawHaloThenMain`, `drawPriceBadge`, `luminance`, `setStroke`. Remove `renderHline`, `renderTrendline`, `renderPencil`, `renderDrawing`. Export `projectPoint` as before.
- **MODIFY** `drawing/translate.ts` — delete the file (its three implementations move to kinds.ts). The `translateDrawing` dispatcher becomes `specOf(d).translate(d, dMs, dPrice)` at the one call site (`tools.ts` selectTool).
- **MODIFY** `drawing/tools.ts` — `selectTool.onPointerMove` calls `specOf(target).translate(...)` instead of importing `translateDrawing`.
- **MODIFY** `chart/DrawingOverlay.tsx` — `hitTestAt` collapses to:
  ```ts
  const hitTestAt = (px: number, py: number): Drawing | null => {
    const helpers = { realMsToCanvasX, priceToCanvasY };
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (specOf(d).hitTest(d, { x: px, y: py }, helpers)) return d;
    }
    return null;
  };
  ```
  The redraw effect calls `specOf(d).render(c, projCtx, d, selected)` instead of `renderDrawing`.

### Tests

`drawing/kinds.test.ts` mirrors the structure of `tools.test.ts`:

- `describe('hlineKind.render', ...)` — same assertions as the current `renderHline price badge` tests in `render.test.ts` (relocated, not rewritten).
- `describe('hlineKind.hitTest', ...)` — extracts the hit-test logic currently buried in `DrawingOverlay.hitTestAt`'s switch.
- `describe('hlineKind.translate', ...)` — equivalent to the current `translate.test.ts` `hline` cases.
- Same for `trendlineKind` and `pencilKind`.
- `describe('KIND_SPECS registry', ...)` — asserts every `DrawingKind` union member has a spec (compile-time `satisfies` + runtime sanity check).

Existing `render.test.ts` and `translate.test.ts` are deleted (their tests move into `kinds.test.ts`). `tools.test.ts` is unchanged.

`DrawingOverlay` is not unit-tested (manual verification covers it). The refactor's correctness is established by the kinds.test.ts test suite plus the existing tools.test.ts (which exercises the full select-drag flow through a stubbed `update`).

## Migration order

1. Create `kinds.ts` with all three specs delegating to the existing functions (render delegates to `renderHline`, hitTest to `distanceToHline`, translate to `translateHline`). All existing tests still pass.
2. Move the implementations into kinds.ts spec bodies; the now-empty top-level `render.ts`/`translate.ts` functions become single-line re-exports.
3. Switch call sites (`DrawingOverlay.hitTestAt`, `DrawingOverlay` redraw effect, `selectTool.onPointerMove`) to `specOf(d).xxx(...)`.
4. Delete the obsolete dispatchers (`renderDrawing`, `translateDrawing`, `HIT_THRESHOLD.hline/trendlineBody/pencil`).
5. Move tests from `render.test.ts` / `translate.test.ts` into `kinds.test.ts`. Delete the old test files.

Each step is one commit; the test suite stays green throughout.

## Open questions

None.

## See also

- CONTEXT.md: **Drawing**, **Drawing Tool**, **Drawing Overlay** (this
  spec extends the Drawing Tool entry to introduce a sibling **Drawing
  Kind Spec**).
- ADR-0024: Drawing persistence uses real Unix-ms (unaffected; the
  `Drawing` payload shape doesn't change).
- ADR-0025: hline price label rendered on canvas (unaffected;
  `drawPriceBadge` remains a private helper inside `render.ts`'s
  shared section).
