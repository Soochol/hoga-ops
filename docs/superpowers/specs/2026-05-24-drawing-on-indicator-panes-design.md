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
| Pane binding | New `paneIndex: number` field on `Drawing` |
| Overlay architecture | Single canvas, pane-aware (no per-pane overlays) |
| Cross-pane drag | Clamp drag to the pane where pointer-down occurred |
| Price-series source | Registry owned by `ChartStage`, passed as prop |

The `Drawing.price` field's *meaning* now varies by pane: KRW for candle,
share count for volume, −1..1 for ratio, etc. The persisted shape does not
change beyond the new `paneIndex`.

---

## Architecture

### Data model

`frontend/src/chart/drawing/types.ts`:

```ts
interface DrawingBase {
  id: DrawingId;
  color: string;
  width: number;
  paneIndex: number;  // NEW. 0 = candle, 1 = volume, etc.
}
```

`paneIndex` lives on `DrawingBase` so every kind (Hline, Trendline,
Pencil) carries it uniformly. `Trendline.{a,b}` and `Pencil.points` remain
`Point { realMs, price }` — but `price` is interpreted in the pane's
Y-domain, not always KRW.

### Series registry

`ChartStage` owns a `Map<number, ISeriesApi<any>>` from `paneIndex` to the
**primary series** of that pane (the first series in `PaneSpec.series` —
not reference lines added via `afterAdd`).

```ts
// ChartStage.tsx
const paneSeriesRef = useRef<Map<number, ISeriesApi<any>>>(new Map());

// RangeSeriesPane gets a new prop:
<RangeSeriesPane
  paneIndex={paneIndex}
  spec={spec}
  onPrimarySeriesReady={(s) => paneSeriesRef.current.set(paneIndex, s)}
  onPrimarySeriesGone={() => paneSeriesRef.current.delete(paneIndex)}
/>

<DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeriesRef.current} />
```

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
gain a `paneIndex` argument; the `PriceSeries` parameter becomes a
`PaneSeriesMap`:

```ts
export type PaneSeriesMap = ReadonlyMap<number, ISeriesApi<any>>;

export function priceToCanvasY(
  paneSeries: PaneSeriesMap,
  paneIndex: number,
  price: number,
): number | null;

export function pixelToData(
  chart: IChartApi,
  axis: VirtualAxis,
  paneSeries: PaneSeriesMap,
  paneIndex: number,
  px: number,
  py: number,
): Point | null;

// realMsToCanvasX unchanged — time axis is shared across panes.
```

The Y returned by lightweight-charts' `priceToCoordinate` is in
chart-global pixel space (it already includes the pane's vertical
offset), so callers can use the value verbatim against the canvas
without re-adding `paneTop`.

### Pane dispatch (which pane was clicked?)

New helper, colocated with `chartCoordinates.ts`:

```ts
export function paneIndexAtY(chart: IChartApi, py: number): number {
  let cursor = 0;
  const panes = chart.panes();
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (py >= cursor && py < cursor + h) return i;
    cursor += h;
  }
  return panes.length - 1;  // safety: pointer below all panes → last
}
```

Used in two places:
- `onPointerDown` to decide the `paneIndex` of a brand-new Drawing.
- `hitTestAt` to skip drawings whose paneIndex differs from the pointer's
  current pane (preserves the no-leak guarantee from `5eadbc8`).

### Clamp-to-start-pane

While a drag is in flight, the start pane is "sticky":

```ts
// tools.ts — ToolCtx gets one more helper
clampYToPane(paneIndex: number, py: number): number {
  const panes = chart.panes();
  let top = 0;
  for (let i = 0; i < paneIndex; i++) top += panes[i].getHeight();
  const bottom = top + panes[paneIndex].getHeight();
  return Math.max(top, Math.min(bottom - 1, py));
}
```

Each tool's `onPointerMove` clamps the live cursor Y to the start pane
before calling `pixelToData(..., startPaneIndex, px, clampedPy)`. Pointer
capture (`setPointerCapture` already used) keeps the gesture even when
the cursor leaves the canvas.

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
  const series = paneSeries.get(d.paneIndex);
  if (!series) continue;  // pane removed → skip silently
  const top = paneTops[d.paneIndex];
  const h = panes[d.paneIndex].getHeight();
  c.save();
  c.beginPath();
  c.rect(0, top, w, h);
  c.clip();
  renderDrawing(c, projCtxForPane(d.paneIndex), d, d.id === selectedId);
  c.restore();
}
```

`projCtxForPane(i)` is `{ chart, axis, paneSeries, paneIndex: i, width, height }`,
matching the new `chartCoordinates` signatures inside `renderDrawing`.

### Hit-test

```ts
function hitTestAt(px: number, py: number): Drawing | null {
  const cursorPane = paneIndexAtY(chart, py);
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    if (d.paneIndex !== cursorPane) continue;
    // existing per-kind distance checks, but priceToCanvasY uses d.paneIndex
  }
  return null;
}
```

### Tool changes

`tools.ts`:
- `onPointerDown` for hline / trendline / pencil resolves `paneIndex` via
  `paneIndexAtY(chart, ctx.py)` and stamps it on the new Drawing (and on
  any per-gesture draft in `trendlineDraft` / `pencilDraft`).
- `onPointerMove` clamps Y via `ctx.clampYToPane(startPaneIndex, py)`
  before recording the next point.
- `ToolCtx` gains: `paneIndexAtY(py): number`, `clampYToPane(i, py): number`.

The select tool resolves its drag target via the existing `hitTestAt` —
no extra paneIndex bookkeeping needed because the moved Drawing keeps its
own `paneIndex`.

### Persistence migration

`frontend/src/chart/drawing/persistence.ts` already wraps payloads in
`{ v: 1, items }`. Two compatible options:

- **Chosen:** Keep `v: 1`. In `loadDrawings`, post-process every item:
  ```ts
  return (parsed.items as Drawing[]).map((d) => ({
    ...d,
    paneIndex: typeof d.paneIndex === 'number' ? d.paneIndex : 0,
  }));
  ```
  This is a forward-compatible superset migration — readers from `main`
  (no `paneIndex` awareness) ignore the new field; new readers backfill
  legacy data with `paneIndex = 0` (candle).

- Bump to `v: 2`: rejected. Would discard legacy drawings on first load
  from older writers, which violates the "user work is never silently
  lost" principle.

### Pane removed / mismatched

If `PANE_SPECS` is edited later and a Drawing's `paneIndex` no longer
resolves to a registered series, the draw loop skips it (the `if (!series)
continue` above). Storage is untouched, so the drawing reappears if
`PANE_SPECS` is reverted. No UI notice for v1 — silent skip is acceptable
because pane changes are developer-driven, not user-driven.

---

## File-by-file change list

| File | Change |
|---|---|
| `chart/drawing/types.ts` | Add `paneIndex: number` on `DrawingBase` |
| `chart/drawing/chartCoordinates.ts` | Replace `PriceSeries` with `PaneSeriesMap`; add `paneIndex` arg to `priceToCanvasY` / `pixelToData`; add `paneIndexAtY` helper |
| `chart/drawing/persistence.ts` | Backfill missing `paneIndex` with 0 on load |
| `chart/drawing/render.ts` | `ProjectCtx` swaps `priceSeries` → `paneSeries: PaneSeriesMap` + `paneIndex`; all Y conversions use new signatures |
| `chart/drawing/tools.ts` | `ToolCtx` gains `paneIndexAtY` + `clampYToPane`; each tool's pointer handlers stamp paneIndex and clamp |
| `chart/drawing/hitTest.ts` | (unchanged — pure geometry; callers feed it pane-correct coordinates) |
| `chart/DrawingOverlay.tsx` | Drop `priceSeries` prop, take `paneSeries: PaneSeriesMap`; per-drawing clip; hit-test pane filter; pane-aware coord helpers |
| `chart/RangeSeriesPane.tsx` | Accept `onPrimarySeriesReady` / `onPrimarySeriesGone` callbacks; fire after first series mount |
| `chart/ChartStage.tsx` | Own `paneSeriesRef` map; wire `onPrimarySeriesReady` / `onPrimarySeriesGone` on every `RangeSeriesPane`; remove the `candleSeries` `useState` + setter (verified to be used only by `DrawingOverlay`) and pass `paneSeries` to `DrawingOverlay` instead |
| `state/drawings.ts` | (no change — Drawing shape change is transparent here) |

---

## Tests

| File | Cases |
|---|---|
| `persistence.test.ts` | Legacy payload (no `paneIndex`) loads with `paneIndex=0`; new payload round-trips `paneIndex` faithfully |
| `tools.test.ts` | hline / trendline / pencil pointer-down at y inside pane 2 stamps `paneIndex=2`; trendline drag with cursor moving into pane 3 keeps `b.price` interpreted in pane 2 |
| `hitTest.test.ts` | Drawings with `paneIndex=2` are unreachable from pointer in pane 0 (covers no-leak guarantee) |
| `render.test.ts` | Mock canvas `rect`/`clip` calls observed once per drawing with the pane's `(0, top, w, paneH)` rect |
| **NEW** `paneDispatch.test.ts` | `paneIndexAtY` cumulative-height mapping; `clampYToPane` boundaries (top, bottom, mid, out-of-pane on either side) |
| `translate.test.ts` | (unchanged — translation operates on `price` numerically, pane-agnostic) |

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
  sanity check during implementation.
- **`afterAdd` series mounted first**: if any future `PaneSpec` adds a
  reference line *before* the data series in `spec.series`,
  "first series = primary" is wrong. Mitigation: `RangeSeriesPane`
  registers the first series with `seriesType !== 'Line'` filter, or
  the spec declares its primary index explicitly. v1 keeps the simple
  rule and documents the invariant in `paneSpecs.ts`.

---

## ADR / CONTEXT touchpoints

- ADR-0024 (real-ms anchors for drawings) is unaffected — `Point.realMs`
  still anchors to the virtual axis; pane binding is orthogonal.
- CONTEXT.md term "**Drawing**" gains a sub-concept: every Drawing is
  now **pane-bound** by its `paneIndex`. Update the Drawing Overlay
  section to mention this.
