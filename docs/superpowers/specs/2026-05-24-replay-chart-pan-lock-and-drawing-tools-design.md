# Replay Chart Pan-Lock Fix + Drawing Tools

**Status:** Draft (awaiting user review)
**Date:** 2026-05-24
**Scope:** `frontend/src/chart/`, `frontend/src/replay/`, `frontend/src/state/`

Two independent changes land in the same spec because both touch
`ChartStage` and share the canvas-overlay pattern established by
`DayBoundaryOverlay` / `AuctionWindowOverlay`.

---

## Part 1 — Chart Pan-Lock Fix

### Problem

In `/replay`, when a 10-day range is loaded and the chart is fully
zoomed out (all 10 days visible via the implicit `fitContent()` on
mount), mouse drag and wheel-pan do not move the chart. Any partial
zoom-in restores normal pan behavior.

### Root cause

`ChartStage.tsx:259-278` subscribes to
`subscribeVisibleLogicalRangeChange` and runs this clamp:

```ts
const handler = (range) => {
  const len = range.to - range.from;
  if (len > totalBars) {
    ts.setVisibleLogicalRange({ from: 0, to: totalBars });
    return;
  }
  ...
};
```

After `fitContent()` the visible logical range satisfies
`len ≈ totalBars`. A leftward pan makes `range.from` negative
(lightweight-charts permits this — empty space rendered to the left),
so `len = range.to - range.from > totalBars` and the handler snaps the
range back to `{from: 0, to: totalBars}` on every frame. The chart is
visually locked.

When zoomed in, `len < totalBars` and the clamp never fires, so pan
works.

### Fix

Replace the logical-range clamp with the library's native zoom-out
guard:

1. **Remove** the `len > totalBars` branch in
   `ChartStage.tsx:265-269`. Keep the `barSpacing > 50` zoom-in cap.
2. **Add** `timeScale.minBarSpacing` to the `createChart` options.
   Computed once on mount and refreshed on container resize as:
   ```
   minBarSpacing = max(0.5, containerWidth / totalBars)
   ```
   This means the chart cannot zoom out beyond "all bars fit", but
   pan within or beyond the data window is unconstrained.

Resize handling reuses the existing `ResizeObserver` on the chart
container (lightweight-charts' `autoSize: true` already observes it;
we add a separate observer to recompute `minBarSpacing` and call
`chart.applyOptions({ timeScale: { minBarSpacing } })`).

### Verification

- Manual: load a 10-day range, drag left/right with mouse, scroll
  wheel left/right. Chart pans in both directions.
- Manual: try to zoom out further than "all bars fit" — gesture has
  no effect (no overshoot, no rubber-band).
- Unit/E2E: Playwright spec drags 100px to the left from chart
  center; assert `subscribeVisibleTimeRangeChange` emits at least one
  event where `from` decreased. The current bug emits zero such
  events.

### Non-goals

- We do not add "infinite scroll" beyond the data window — the library
  already shows empty space to either side when panned beyond data.
- We do not change `rightOffset` or initial fit behavior.

---

## Part 2 — Drawing Tools

### Goal

Let users annotate the chart with **horizontal lines**, **trendlines**,
and **freehand pencil** strokes. Annotations are selectable, movable,
deletable, and persist across page reloads keyed by stock code.

### UI surface

A new **그리기 ▾** button sits next to the **⚙ 설정** button in the
replay `Toolbar` ([Toolbar.tsx:72-80](frontend/src/replay/Toolbar.tsx#L72-L80)).
Clicking it toggles a popover anchored beneath the button:

```
[그리기 ▾]
  ┌──────────────────┐
  │ ━  수평선         │
  │ ╱  추세선         │
  │ ✎  연필           │
  │ ⌫  지우개         │
  ├──────────────────┤
  │ ↶  선택           │
  │ ✕  모두 지우기     │
  └──────────────────┘
```

- Popover closes on outside click, on `Esc`, or on tool selection.
- Active tool is highlighted with `bg-accent` and the popover stays
  closed after selection. The toolbar button shows the active tool's
  icon (e.g. `━` instead of `✏`) until the user reverts to **선택**.
- No new dependency: hand-rolled popover with `useState` + `useEffect`
  outside-click listener.

When `activeTool === 'select'` (default), the chart behaves as today —
all mouse events go to lightweight-charts. When any drawing tool is
active, the overlay captures pointer events and the chart's built-in
pan is suppressed.

### Drawing primitives

```ts
type Point = { realMs: number; price: number };

type Hline = {
  id: string;        // nanoid
  kind: 'hline';
  price: number;
  color: string;     // CSS var ref or hex; v1 fixed to '--accent'
  width: number;     // px; v1 fixed to 1.5
};

type Trendline = {
  id: string;
  kind: 'trendline';
  a: Point;
  b: Point;
  color: string;
  width: number;
};

type Pencil = {
  id: string;
  kind: 'pencil';
  points: Point[];   // ≥ 2; throttled to ~8ms during capture
  color: string;
  width: number;
};

type Drawing = Hline | Trendline | Pencil;
```

**Why store `realMs` (Unix-ms), not virtual-ms or pixel coordinates:**
the chart's time axis is the stitched **Virtual Axis**
(`util/virtualAxis.ts`, ADR-0013 / Task 6.1) — but the virtual-ms space
is **scoped to a specific Stock-Date Range's axis construction**. A
drawing stored as virtual-ms would be meaningless under a different
range, even for the same **Code**. Persisting per **Code** (G2) therefore
requires the coordinate to be range-independent. Real Unix-ms is the
project-wide time encoding (ADR-0003: `Cursor`, `frontier_ms`,
`segments[*].session_open_ms` are all Unix-ms), so drawings stored as
`realMs` interoperate naturally with the rest of the system and with any
future server-side persistence.

Pixel coordinates are rejected for the same reason as before — they
desync on pan/zoom. The per-frame conversion cost
(`axis.toVirtual(realMs)` → `timeScale.timeToCoordinate(virtualMs/1000)`)
is two arithmetic ops + a binary search inside `toVirtual` per vertex;
negligible at the drawing counts users produce (typically < 50
drawings, < 5000 vertices per pencil).

**Out-of-range vertices:** when `realMs` falls outside every segment,
`axis.toVirtual` returns the prior-segment-end sentinel (per CONTEXT.md
**Virtual Axis** entry). The renderer treats those vertices as
"skip and break the polyline" rather than stacking them at the sentinel
— this keeps a drawing whose endpoints fall outside the current
**Stock-Date Range** invisible rather than collapsed onto a Day Boundary.

### Rendering

A new `DrawingOverlay.tsx` mounts inside `ChartStage` between
`AuctionWindowOverlay` and the chart's right edge:

```
ChartStage
  ├── lightweight-charts <canvas> (autoSized)
  ├── VolumeProfileOverlay (z-10, pointer-events-none)
  ├── DayBoundaryOverlay   (z-10, pointer-events-none)
  ├── AuctionWindowOverlay (z-10, pointer-events-none)
  └── DrawingOverlay       (z-20, pointer-events: auto when tool active)
```

`DrawingOverlay` owns one `<canvas>` sized to its container via
`ResizeObserver`. It redraws on:

- `subscribeVisibleLogicalRangeChange` (pan/zoom)
- Container resize
- Drawings store mutation
- `activeTool` change (for cursor preview)

All triggers funnel through a single `requestAnimationFrame` coalesce,
identical to `DayBoundaryOverlay`'s pattern.

Render is straight Canvas 2D — strokes only, no fills. For each drawing:

- **Hline:** read `priceScale.priceToCoordinate(price)`. If non-null,
  draw line across full canvas width.
- **Trendline:** convert each endpoint's `realMs` → virtual-ms via
  `axis.toVirtual`, then to canvas X via `timeToCoordinate`; convert
  `price` via `priceToCoordinate`. If either endpoint maps to a
  null/sentinel (outside any segment), clip to canvas bounds along the
  line's slope rather than skip — partial visibility is expected when
  the user pans away from one endpoint. If **both** endpoints are
  outside, skip rendering entirely.
- **Pencil:** convert each point; vertices that map outside any segment
  break the polyline into sub-strokes (rather than connecting across
  the gap with a fictional segment).

Selected drawings render with a 1px halo (`color` at 30% alpha,
2× width) underneath the main stroke. Trendline endpoints render as
6×6px filled squares (handles) when selected.

### Interaction matrix

| `activeTool` | mousedown | mousemove | mouseup |
|---|---|---|---|
| `select` | hit-test → set `selectedId`; if hit, capture drag-offset | if dragging, update drawing coords | release |
| `hline` | insert Hline at cursor's price | — | — |
| `trendline` | record point A; enter "drawing" state | render preview line from A to cursor | commit Trendline {a, b} |
| `pencil` | begin point array | append point (throttled to one per RAF, ~16ms) | commit Pencil |
| `eraser` | hit-test → delete drawing if hit | preview-highlight hovered drawing | — |

**Hit-test thresholds (canvas-space pixels):**
- Hline: vertical distance ≤ 6px
- Trendline body: point-to-segment distance ≤ 8px; handles: 6px radius
- Pencil: minimum distance to any polyline segment ≤ 8px

**Drag semantics in `select`:**
- Hline body drag: shift `price` only (no horizontal movement).
- Trendline body drag: translate both endpoints by `(Δvirtual, Δprice)`.
- Trendline handle drag: move that endpoint only.
- Pencil drag: translate all points by `(Δvirtual, Δprice)`.

`Δvirtual` and `Δprice` are computed by converting the current and
previous cursor pixel positions through the chart's coordinate APIs and
taking the difference — this way a drag remains visually anchored to the
cursor even mid-zoom.

### Keyboard

- `Delete` / `Backspace` → delete `selectedId` if set
- `Esc` → clear `selectedId` and set `activeTool = 'select'`

Listeners attach to `window` only while `DrawingOverlay` is mounted and
the user's focus is not in a text input (cheap check on `event.target`).

### State

New zustand store `frontend/src/state/drawings.ts`:

```ts
type DrawingsState = {
  byCode: Map<string, Drawing[]>;   // keyed by Code (CONTEXT.md term)
  activeCode: string | null;        // mirrors the active Replay Tab's selection.code
  activeTool: 'select'|'hline'|'trendline'|'pencil'|'eraser';  // global, not per-tab
  selectedId: string | null;        // reset when activeCode changes (no cross-Code selection)

  // actions
  setActiveCode(code: string | null): void;   // resets selectedId
  setActiveTool(tool: ...): void;
  add(d: Drawing): void;            // appends to byCode.get(activeCode)
  update(id: string, patch: Partial<Drawing>): void;
  remove(id: string): void;
  clearAll(): void;                 // clears byCode.get(activeCode) only — does NOT wipe other Codes
  setSelected(id: string | null): void;
};
```

**Scope rationale:**
- `activeTool` is **global** because it's a UI mode (the user's current
  intent), not data tied to a specific **Replay Tab** or **Code**. A
  user mid-pencil who switches tabs expects to keep pencilling.
- `selectedId` **resets** on `setActiveCode` because a selection ID
  drawn from `byCode.get('A')` is meaningless after the active list
  becomes `byCode.get('B')`.
- Multi-tab same-**Code** is consistent for free: both tabs read from
  `byCode.get(code)` and re-render via the same store subscription
  when either tab adds, edits, or removes a drawing.

`add/update/remove/clearAll` mutate `byCode.get(activeCode)`. `activeCode`
is wired from the active tab's `selection.code` via a small effect in
`ChartStage` (or `ReplayViewer`).

### Persistence

- **Storage:** `localStorage` under key `replay.drawings.v1.<code>`.
  Prefix matches the existing `replay.tabs.v1` convention; embedding the
  version in the key (rather than only in the wrapper) means a future
  schema bump can coexist with v1 readers during migration without
  destructive overwrites.
- **Wrapper:** `{ v: 1, items: Drawing[] }`. Reads with `v !== 1` fall
  back to `[]`. Writes always include the current version. The
  redundancy is intentional — the in-key version handles cross-version
  coexistence, the in-payload version handles bit-rot and accidental
  cross-key copy.
- **Write path:** `subscribeWithSelector` on the drawings store; any
  mutation queues a 250ms debounced `persist(activeCode)`. A
  `beforeunload` window listener flushes pending writes synchronously.
- **Read path:** `setActiveCode(code)` reads
  `replay.drawings.v1.<code>` and replaces `byCode.get(code)`. Cache the
  loaded codes in a `Set` so we don't re-read on every tab focus.
- **Quota:** each drawing is small (< 200 bytes JSON for hline, ~50
  bytes per pencil point). At pencil throttle 8ms a 10-second freehand
  stroke ≈ 1.25k points ≈ 60KB. Hard cap pencil at 5000 points
  client-side (silently stop appending) — keeps a single drawing under
  250KB and well within the per-origin quota.

Persistence is **per stock code, not per tab**. Two tabs of the same
code share drawings; same-code edits in one tab become visible in the
other on next render because both subscribe to the same store. This
matches the analyst workflow ("my trendline on 005930 sticks across
sessions").

### Tests

**Unit (vitest):**
- `drawings` store reducers: add / update / remove / clearAll respect
  `activeCode` partitioning.
- `hitTest.ts`: distance functions for hline, trendline (point-to-segment),
  pencil (min distance to polyline).
- `persistence.ts`: round-trip serialize/parse; `v !== 1` payload returns
  `[]`; corrupt JSON returns `[]`.

**E2E (playwright):**
- Pan-lock fix: load 10-day range, drag chart left 100px, assert
  visible range `from` decreased.
- Drawing: open menu → select 수평선 → click chart → assert one
  `[data-drawing="hline"]` element (or canvas pixel sample).
- Persistence: draw hline → reload page → drawing still rendered.
- Eraser: draw hline → activate eraser → click on it → drawing gone.
- Selection move: draw trendline → switch to 선택 → drag body → endpoints
  shifted by same `(Δx, Δy)`.

### File touchpoints

New:
- `frontend/src/chart/DrawingOverlay.tsx`
- `frontend/src/chart/drawing/types.ts`
- `frontend/src/chart/drawing/hitTest.ts`
- `frontend/src/chart/drawing/render.ts`
- `frontend/src/chart/drawing/persistence.ts`
- `frontend/src/replay/DrawingMenu.tsx`
- `frontend/src/state/drawings.ts`
- `frontend/src/state/drawings.test.ts`
- `frontend/src/chart/drawing/hitTest.test.ts`
- `frontend/src/chart/drawing/persistence.test.ts`
- `frontend/tests/e2e/drawing.spec.ts` (or equivalent location)

Modified:
- `frontend/src/chart/ChartStage.tsx` — remove logical-range clamp,
  add `minBarSpacing`, mount `DrawingOverlay`, wire `activeCode` from
  active tab.
- `frontend/src/replay/Toolbar.tsx` — add `그리기` button + popover
  mount point.

### Non-goals (v1)

- Vertical lines, Fibonacci, rectangles, text labels
- Per-drawing color/width pickers (v1: single accent color, fixed widths)
- Undo / redo
- Multi-selection / marquee select
- Cross-device sync (localStorage is per-origin per-device by definition)
- Sharing or exporting drawings

### Open questions resolved

- **Tools:** hline, trendline, pencil, eraser. Confirmed.
- **Persistence:** localStorage, per **Code**, v1 wrapper. Confirmed.
- **Coordinate encoding:** real Unix-ms, not virtual-ms (grilling G1) —
  aligns with ADR-0003 and makes drawings range-independent.
- **Drawing color:** fixed to `--accent` for v1 — keeps the design system
  honest (DESIGN.md owns palette) and avoids a color-picker scope creep.
- **Trendline geometry:** segment (two-endpoint) rather than infinite
  line — matches user mental model from competing platforms (TradingView,
  KiwoomHero) and makes hit-test trivial.
- **`activeTool` scope:** global (UI mode), not per-tab (grilling G5).
- **`selectedId` scope:** global, reset on `setActiveCode` (grilling G5).

### Domain alignment (CONTEXT.md cross-reference)

- **Code** — the 6-digit ticker is the persistence key; spec uses `code`
  variable name and never the _Avoid_'d "symbol"/"ticker".
- **Cursor** — the mouse cursor over the chart is intentionally not
  the domain **Cursor** (Unix-ms read-path concept). Spec text uses
  "mouse cursor" / "cursor pixel" when ambiguity could arise; the
  domain **Cursor** is unaffected by drawings.
- **Virtual Axis** — `axis.toVirtual(realMs)` is the only conversion;
  no spec code touches the segment array directly. Out-of-range vertex
  handling explicitly follows the sentinel-return contract from
  CONTEXT.md's **Virtual Axis** entry.
- **Stock-Date Range** — drawings persist by **Code**, not by Range. A
  drawing whose `realMs` falls outside the currently viewed Range is
  loaded into the store but renders nothing (no error, no warning).
- **Replay Tab** — drawings are a new persistence layer adjacent to
  `replay.tabs.v1`. Key prefix `replay.drawings.v1.` reuses the
  established convention.

### Follow-up artifacts (after spec approval)

- **CONTEXT.md additions:** new glossary entries for **Drawing**,
  **Drawing Overlay**, **Drawing Tool**. Land in a separate small PR
  to keep the spec/docs lineage clean.
- **ADR-0024:** "Drawing persistence uses real Unix-ms, not virtual-ms".
  Captures the trade-off (range-independence vs render-locality) and
  the rejected alternative (per-Range storage of virtual-ms). Meets
  the ADR threshold per the grill-with-docs heuristic: hard to reverse,
  surprising-without-context, and a genuine trade-off.
