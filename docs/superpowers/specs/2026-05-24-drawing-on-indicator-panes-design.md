# Drawings on Indicator Panes

**Status:** Draft (awaiting user review)
**Date:** 2026-05-24
**Scope:** `frontend/src/chart/`, `frontend/src/state/`

Extend the Drawing Overlay so users can draw `hline`, `trendline`, and
`pencil` shapes on indicator panes (volume, ratio, quoteTotals,
fillStrength) — not just the candle pane. The candle pane today is the
only writable surface; indicator panes are visually present but rejected
by both the render clip and the hit-test guard.

---

## Problem

At `/replay`, the Drawing Overlay (`frontend/src/chart/DrawingOverlay.tsx`)
is hard-wired to pane 0:

1. It takes a single `priceSeries` prop — the candle series from pane 0 —
   and all price↔Y conversion runs through it
   ([DrawingOverlay.tsx:48][overlay-props]).
2. Every drawing is clipped to `chart.panes()[0].getHeight()`
   ([DrawingOverlay.tsx:103-106][overlay-clip]). Any drawing whose
   extrapolated Y would land in an indicator pane is suppressed by design
   (commit `5eadbc8` introduced this clip to stop hline price-badges from
   bleeding into volume/ratio).
3. The hit-test rejects any pointer Y outside pane 0
   ([DrawingOverlay.tsx:197][overlay-hit]).

Users want to mark levels and trends on the indicator panes too — e.g. a
horizontal "10만 주" level on the volume pane, or a trendline tracking
ratio drift across days. The current architecture prevents this.

[overlay-props]: ../../frontend/src/chart/DrawingOverlay.tsx#L48
[overlay-clip]: ../../frontend/src/chart/DrawingOverlay.tsx#L103-L106
[overlay-hit]: ../../frontend/src/chart/DrawingOverlay.tsx#L197

---

## Design decisions (settled in brainstorming)

| Decision | Choice |
|---|---|
| Tool scope | All three tools (hline, trendline, pencil) on every pane |
| Pane binding (persisted) | New `paneId: PaneId` field on `Drawing` — a stable string ID, not the array index |
| Pane binding (runtime) | Memoised `paneIndex: number` derived from `paneId` via the active `PANE_SPECS` lookup |
| Overlay architecture | Single canvas, pane-aware (no per-pane overlays) |
| Cross-pane drag (creation) | Clamp drag Y to the pane where pointer-down occurred |
| Cross-pane drag (selection move) | Same clamp — a selected Drawing's body-translate stays inside its origin pane |
| Price-series source | Registry owned by `ChartStage`, keyed by `paneId`, passed as prop |

The `Drawing.price` field's *meaning* now varies by pane: KRW for candle,
share count for volume, −1..1 for ratio, etc. The persisted shape adds a
single `paneId: string` field.

**Why `paneId` not `paneIndex`** (sharpened during the grill pass): the
array position in `frontend/src/chart/paneSpecs.ts` is a code-layout
detail and reordering it is a one-line change. Encoding the array index
into persisted user data couples every saved drawing to that ordering —
a future reorder would silently shift drawings to the wrong pane with no
data-shape change to detect. Encoding by **stable PaneSpec name** (the
existing `PaneSpec.name` field — `'candle'`, `'volume'`, `'ratio'`,
`'quote-totals'`, `'fill-strength'`) decouples persistence from
ordering. The numeric `paneIndex` still exists at runtime for clip-rect
math and lightweight-charts API calls; it is derived from `paneId` on
load (and on every PANE_SPECS-array change, which is essentially never
during a session). See ADR-0028.

---

## Architecture

### Data model

`frontend/src/chart/drawing/types.ts`:

```ts
/** Stable identifier for a chart pane. Mirrors `PaneSpec.name`. */
export type PaneId =
  | 'candle'
  | 'volume'
  | 'ratio'
  | 'quote-totals'
  | 'fill-strength';

interface DrawingBase {
  id: DrawingId;
  color: string;
  width: number;
  paneId: PaneId;  // NEW. Stable across PANE_SPECS reorders.
}
```

`paneId` lives on `DrawingBase` so every kind (Hline, Trendline, Pencil)
carries it uniformly. `Trendline.{a,b}` and `Pencil.points` remain
`Point { realMs, price }` — but `price` is interpreted in the pane's
Y-domain, not always KRW.

Adding a new pane primitive in the future means: append a literal to
`PaneId`, add the corresponding `PaneSpec.name` (which already exists),
and document the binding in CONTEXT.md.

### Series registry

`ChartStage` owns a `Map<PaneId, ISeriesApi<any>>` from `paneId` to the
**primary series** of that pane (the first series in `PaneSpec.series` —
not reference lines added via `afterAdd`).

```ts
// ChartStage.tsx
const paneSeriesRef = useRef<Map<PaneId, ISeriesApi<any>>>(new Map());

// RangeSeriesPane gets a new prop:
<RangeSeriesPane
  paneIndex={paneIndex}
  spec={spec}
  onPrimarySeriesReady={(s) => paneSeriesRef.current.set(spec.name as PaneId, s)}
  onPrimarySeriesGone={() => paneSeriesRef.current.delete(spec.name as PaneId)}
/>

<DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeriesRef.current} />
```

`PaneSpec.name` is already the stable identifier used elsewhere
(`data-pane` HTML attr, E2E selectors); this design promotes it to a
typed `PaneId` and uses it as the registry key.

The candle-pane-specific `priceSeries={candleSeries}` prop is removed; the
registry is the single source. `RangeSeriesPane` already mounts/unmounts
its series in a `useEffect`, so registration hooks into that lifecycle
(call `onPrimarySeriesReady` after `chart.addSeries(...)` for `series[0]`,
call `onPrimarySeriesGone` in the cleanup).

**Why "primary series" not "every series"**: each pane's price scale is
shared across its series in lightweight-charts v5, so the first data
series is sufficient for `priceToCoordinate` / `coordinateToPrice`.
RATIO_SPEC's `afterAdd` reference line is decorative and need not be in
the registry.

### Coordinate functions

`frontend/src/chart/drawing/chartCoordinates.ts` — Y-conversion functions
gain a `paneId` argument; the `PriceSeries` parameter becomes a
`PaneSeriesMap`:

```ts
export type PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>;

export function priceToCanvasY(
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  price: number,
): number | null;

export function pixelToData(
  chart: IChartApi,
  axis: VirtualAxis,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  px: number,
  py: number,
): Point | null;

// realMsToCanvasX unchanged — time axis is shared across panes.
```

A small `paneIdToIndex(paneId)` helper resolves `paneId → paneIndex` by
scanning `PANE_SPECS` for the matching `.name`. Cached in a module-level
`Map<PaneId, number>` rebuilt once at module load. This helper is
internal to `chartCoordinates.ts`; consumers always pass `paneId`.

The Y returned by lightweight-charts' `priceToCoordinate` is in
chart-global pixel space (it already includes the pane's vertical
offset), so callers can use the value verbatim against the canvas
without re-adding `paneTop`.

### Pane dispatch (which pane was clicked?)

New helper, colocated with `chartCoordinates.ts`:

```ts
export function paneIdAtY(chart: IChartApi, py: number): PaneId {
  let cursor = 0;
  const panes = chart.panes();
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (py >= cursor && py < cursor + h) return PANE_SPECS[i].name as PaneId;
    cursor += h;
  }
  return PANE_SPECS[PANE_SPECS.length - 1].name as PaneId;
}
```

Used in three places:
- `onPointerDown` to decide the `paneId` of a brand-new Drawing.
- `hitTestAt` to skip drawings whose `paneId` differs from the pointer's
  current pane (preserves the no-leak guarantee from commit `5eadbc8`).
- The select-tool body-translate guard (see Clamp section).

### Clamp-to-start-pane

While a drag is in flight, the start pane is "sticky". Applies uniformly
to three flows: creation drag (trendline `b` point + pencil tail),
**body-translate of a selected Drawing in select mode**, and the
in-flight draft renderer.

```ts
// tools.ts — ToolCtx gets one more helper
clampYToPane(paneId: PaneId, py: number): number {
  const panes = chart.panes();
  const idx = paneIdToIndex(paneId);
  let top = 0;
  for (let i = 0; i < idx; i++) top += panes[i].getHeight();
  const bottom = top + panes[idx].getHeight();
  return Math.max(top, Math.min(bottom - 1, py));
}
```

Each tool's `onPointerMove` clamps the live cursor Y to the start pane
before calling `pixelToData(..., startPaneId, px, clampedPy)`. Pointer
capture (`setPointerCapture` already used) keeps the gesture even when
the cursor leaves the canvas.

**Body-translate clamp**: when the select tool drags an existing
Drawing's body (Hline's full line, Trendline's segment, Pencil's
polyline), the cumulative dy is clamped so the Drawing's bounding-box
top stays ≥ pane top and bounding-box bottom stays ≤ pane bottom. This
keeps Drawings visible after the drag — moving an indicator-pane
Drawing into the candle pane's pixel region would only render under
clip and look "lost". The clamp is applied in the same `translate.ts`
path that already exists for body-drag.

**Draft render clip**: when the renderer paints the in-flight pencil
draft or trendline preview, it clips to the start pane's rect (same
rect math as a confirmed Drawing's clip with that `paneId`). The draft
shape carries `paneId` set at pointer-down so render and data clamp use
the same source of truth.

### Rendering

`DrawingOverlay`'s draw loop changes from one global clip to a per-drawing
clip:

```ts
const panes = chart.panes();
const paneTops = (() => {
  const tops: number[] = [];
  let acc = 0;
  for (const p of panes) { tops.push(acc); acc += p.getHeight(); }
  return tops;
})();

for (const d of drawings) {
  const series = paneSeries.get(d.paneId);
  if (!series) continue;  // pane removed → skip silently
  const idx = paneIdToIndex(d.paneId);
  const top = paneTops[idx];
  const h = panes[idx].getHeight();
  c.save();
  c.beginPath();
  c.rect(0, top, w, h);
  c.clip();
  renderDrawing(c, projCtxForPane(d.paneId), d, d.id === selectedId);
  c.restore();
}
```

`projCtxForPane(id)` is `{ chart, axis, paneSeries, paneId: id, width, height }`,
matching the new `chartCoordinates` signatures inside `renderDrawing`.

### Hit-test

```ts
function hitTestAt(px: number, py: number): Drawing | null {
  const cursorPaneId = paneIdAtY(chart, py);
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    if (d.paneId !== cursorPaneId) continue;
    // existing per-kind distance checks, but priceToCanvasY uses d.paneId
  }
  return null;
}
```

The same `cursorPaneId !== d.paneId` filter applies in the
select-mode pointer-events gating `useEffect` (hover-driven `auto` /
`none` toggle) — the hover detector reuses `hitTestAt` so the filter
is inherited.

### Tool changes

`tools.ts`:
- `onPointerDown` for hline / trendline / pencil resolves `paneId` via
  `paneIdAtY(chart, ctx.py)` and stamps it on the new Drawing (and on
  any per-gesture draft in `trendlineDraft` / `pencilDraft`).
- `onPointerMove` clamps Y via `ctx.clampYToPane(startPaneId, py)`
  before recording the next point.
- `ToolCtx` gains: `paneIdAtY(py): PaneId`, `clampYToPane(id, py): number`.
- `eraser` is unaffected at the tool layer — it already calls
  `hitTestAt` + `remove(id)`, and the pane filter inside `hitTestAt`
  scopes erasure to the pointer's current pane automatically.

The select tool resolves its drag target via the existing `hitTestAt`
(now pane-filtered). Body-translate uses the new `clampYToPane(d.paneId,
…)` to keep the moved Drawing inside its origin pane (see Clamp
section).

### Persistence migration

`frontend/src/chart/drawing/persistence.ts` already wraps payloads in
`{ v: 1, items }`. Keep `v: 1` — the change is a forward-compatible
superset migration. In `loadDrawings`, post-process every item:

```ts
return (parsed.items as Array<Drawing & { paneIndex?: number }>).map((d) => {
  if (typeof d.paneId === 'string') return d as Drawing;
  // Legacy paneless drawing → candle pane (the only writable surface
  // before this change).
  // Legacy drawings persisted with paneIndex (none ever shipped to users,
  // but a defensive branch in case a dev branch wrote some) → resolve via
  // PANE_SPECS[paneIndex].name.
  const paneId: PaneId =
    typeof d.paneIndex === 'number' && PANE_SPECS[d.paneIndex]
      ? (PANE_SPECS[d.paneIndex].name as PaneId)
      : 'candle';
  return { ...d, paneId } as Drawing;
});
```

Readers from `main` (no `paneId` awareness) ignore the new field; new
readers backfill legacy data with `paneId = 'candle'`.

Bumping to `v: 2` was rejected: would discard legacy drawings on first
load from older writers, violating the "user work is never silently
lost" principle.

### Pane removed / mismatched

If `PANE_SPECS` is edited later and a Drawing's `paneId` no longer
matches any spec, `paneSeries.get(d.paneId)` returns `undefined` and the
draw loop skips it. Storage is untouched, so the drawing reappears if
`PANE_SPECS` is restored. No UI notice for v1 — silent skip is acceptable
because PANE_SPECS changes are developer-driven, not user-driven.

---

## File-by-file change list

| File | Change |
|---|---|
| `chart/drawing/types.ts` | Add `PaneId` literal union and `paneId: PaneId` on `DrawingBase` |
| `chart/paneSpecs.ts` | Add a top-of-file comment declaring "the `name` field on each PaneSpec is a stable persistence ID — never rename, never reuse"; export typed `PaneId` from here too if more consumers grow |
| `chart/drawing/chartCoordinates.ts` | Replace `PriceSeries` with `PaneSeriesMap` keyed by `PaneId`; add `paneId` arg to `priceToCanvasY` / `pixelToData`; add `paneIdAtY` + internal `paneIdToIndex` helpers |
| `chart/drawing/persistence.ts` | Backfill missing `paneId` with `'candle'` on load; tolerate legacy `paneIndex` by mapping through `PANE_SPECS` |
| `chart/drawing/render.ts` | `ProjectCtx` swaps `priceSeries` → `paneSeries: PaneSeriesMap` + `paneId: PaneId`; all Y conversions use new signatures |
| `chart/drawing/tools.ts` | `ToolCtx` gains `paneIdAtY` + `clampYToPane(paneId, py)`; each tool's pointer handlers stamp `paneId` (creation) and clamp (creation + select-body) |
| `chart/drawing/translate.ts` | Body-translate clamps to origin pane's Y range; `translateDrawing` takes (or reads from ctx) the pane bounds |
| `chart/drawing/hitTest.ts` | (unchanged — pure geometry; callers feed it pane-correct coordinates) |
| `chart/DrawingOverlay.tsx` | Drop `priceSeries` prop, take `paneSeries: PaneSeriesMap`; per-drawing clip via `d.paneId`; hit-test pane filter; pane-aware coord helpers; draft preview clipped to draft's `paneId` |
| `chart/RangeSeriesPane.tsx` | Accept `onPrimarySeriesReady` / `onPrimarySeriesGone` callbacks; fire after first series mount / before removeSeries cleanup |
| `chart/ChartStage.tsx` | Own `paneSeriesRef: Map<PaneId, ISeriesApi<any>>`; wire callbacks on every `RangeSeriesPane`; remove the `candleSeries` `useState` + setter (verified to be used only by `DrawingOverlay`) and pass `paneSeries` to `DrawingOverlay` instead |
| `state/drawings.ts` | (no change — Drawing shape change is transparent here) |

---

## Tests

| File | Cases |
|---|---|
| `persistence.test.ts` | Legacy payload (no `paneId`) loads with `paneId='candle'`; legacy with `paneIndex` resolves via PANE_SPECS; new payload round-trips `paneId` faithfully |
| `tools.test.ts` | hline / trendline / pencil pointer-down at y inside ratio pane stamps `paneId='ratio'`; trendline drag with cursor moving into another pane keeps `b.price` interpreted in ratio pane |
| `hitTest.test.ts` | Drawings with `paneId='ratio'` are unreachable from pointer in candle pane (covers no-leak guarantee) |
| `render.test.ts` | Mock canvas `rect`/`clip` calls observed once per drawing with the pane's `(0, top, w, paneH)` rect; pencil/trendline draft also clips to draft's pane |
| **NEW** `paneDispatch.test.ts` | `paneIdAtY` cumulative-height mapping; `paneIdToIndex` resolves all literals; `clampYToPane` boundaries (top, bottom, mid, out-of-pane on either side) |
| `translate.test.ts` | Body-translate clamps `dy` so a Hline at the bottom of volume pane cannot be dragged below the pane; mid-pane translates accumulate `dy` faithfully |

Manual verification (browser, `/replay`):

1. Existing candle-pane drawings from `main` survive checkout: load same
   `code`, drawings show on pane 0 unchanged.
2. Draw hline on volume pane; the price-label shows the share-count value
   (not a KRW figure); reload — hline persists.
3. Draw trendline on ratio pane; drag cursor down through quoteTotals and
   fillStrength — line stays clamped to ratio pane's bottom edge; final
   `b.price` is in ratio's −1..1 domain.
4. Switch active tool via Alt+L / Alt+T / Alt+P shortcuts, then click in
   different panes — each new shape lands on the clicked pane.
5. Click an indicator-pane drawing with the select tool, press Delete —
   it disappears and persists removed.
6. Resize the chart container width — all pane drawings re-render at
   correct positions (autoscale path).

---

## Out of scope (v1)

- Per-pane tool palette / color picker (current single-accent color is
  retained across all panes).
- Drawings that span multiple panes (e.g. a vertical line through every
  pane). Each Drawing stays in exactly one pane.
- Moving a drawing from one pane to another (requires re-interpreting
  `price`, ambiguous UX — out of scope).
- A UI affordance for "this drawing belongs to pane X" — the visual
  location is the indicator. v1 has no list view.
- Price labels customised per indicator-pane semantics (volume label
  could say "주", ratio label could be "−0.42"). v1 reuses the candle-pane
  formatter; refinements ship later if needed.

---

## Open risks

- **lightweight-charts pane Y assumption**: this design assumes
  `priceToCoordinate` on an indicator-pane series returns chart-global Y
  (including pane offset). Verified in v5 docs but worth a runtime
  sanity check during implementation (first task in the plan should be a
  small spike in the dev server confirming this on the ratio or volume
  pane).
- **`afterAdd` series mounted first**: if any future `PaneSpec` adds a
  reference line *before* the data series in `spec.series`,
  "first series = primary" is wrong. Mitigation: keep the convention
  that `series[0]` is the price-scale anchor, document this in
  `paneSpecs.ts`. A future tightening can require `PaneSpec.primarySeriesIndex`
  but v1 keeps the simple rule.
- **`PaneSpec.name` renamed**: renaming an existing `PaneSpec.name`
  silently strands users' drawings. The new top-of-file comment in
  `paneSpecs.ts` declares names as stable persistence IDs; ADR-0028
  records the rationale. Code reviewers must catch rename PRs.

---

## ADR / CONTEXT touchpoints

- **New ADR-0028** "Drawing pane binding by stable `paneId`, not array
  index" — recorded in `docs/adr/0028-drawing-pane-binding.md`.
- ADR-0024 (real-ms anchors for drawings) is unaffected — `Point.realMs`
  still anchors to the virtual axis; pane binding is orthogonal.
- CONTEXT.md term "**Drawing**" definition extended: every Drawing is
  bound to one pane via its `paneId`, and the `price` field's meaning is
  pane-dependent (KRW for candle, share count for volume, signed ratio
  for 호가비, etc.). No new term — pane binding is a property of every
  Drawing, not a separate kind.
- CONTEXT.md term "**Drawing Overlay**" updated to mention it now reads
  from a `paneId → primary series` registry rather than a single
  candle-pane prop.
