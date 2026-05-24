# Drawing UX Improvements (replay)

Three small UX improvements to the replay chart's drawing tools, all
scoped to `frontend/src/chart/drawing/` and `frontend/src/chart/DrawingOverlay.tsx`.
No changes to the `Drawing` data model or persistence format.

## Goals

1. **Price label on horizontal lines.** When an `hline` is drawn, render
   a small price-coloured badge at the right edge of the chart showing
   the line's price level, so the trader sees the level at a glance.
2. **Auto-revert to select after committing a drawing.** After a tool
   commits a new `Drawing`, switch `activeTool` back to `select` and
   select the freshly-committed shape, so the natural next action
   (tweak, move, delete) is one click away.
3. **Keyboard shortcuts for tool switching.** Add `Alt+H/T/P/E/V` to
   pick `hline / trendline / pencil / eraser / select`, on top of the
   existing `Esc` (revert to select) and `Delete/Backspace` (remove
   selection).

## Non-goals

- Native lightweight-charts `createPriceLine` integration. Considered
  and rejected for this iteration; the rationale is in §A below.
- Editable price label (click label → input). Future work.
- Configurable shortcut bindings. The five bindings ship hardcoded.
- Touch / pen modifier alternatives to `Alt+`. Mouse + keyboard only.

## A. Price label on `hline`

### Approach

Extend `renderHline` in `frontend/src/chart/drawing/render.ts` only. The
existing render pipeline already runs on every `drawings` change and on
every visible-range / resize event, so the label is repainted in lockstep
with the line for free.

### Visual

- Position: right edge of the overlay canvas, inset 8px from
  `ctx.width`. Vertically centred on the line's `y`.
- Shape: filled rounded rect (radius 2px), padding `4px` horizontal /
  `2px` vertical.
- Background: the line's own `d.color`.
- Text colour: `#FFFFFF` or `#000000` chosen by the badge background's
  luminance (W3C relative-luminance formula, threshold 0.5) so the
  number always reads.
- Font: monospaced numeric, ~11px, matching the chart's own price-axis
  font where possible.
- Format: `price.toLocaleString('ko-KR')` — comma-separated integers
  (KR equities trade in integer KRW). If the price has a fractional
  component (defensive), show up to 2 decimals.
- Selection state: when the hline is selected, the existing halo logic
  already widens the line. Add 1px outline (`#FFFFFF` at 0.4 alpha) on
  the badge so it reads "lit up" without becoming a separate visual
  pass.

### Why not `createPriceLine`

`lightweight-charts` exposes `ISeriesApi.createPriceLine()` which paints
both the horizontal line and a price-axis label natively. It is tempting
because the label sits inside the real price-axis gutter, perfectly
aligned with crosshair tooltips.

But: the existing `hline` is persisted in the `Drawing[]` store and
participates in the same canvas-pixel hit-test, selection halo, and
pointer-drag machinery as `trendline` and `pencil`. Moving `hline` to a
chart-native object would force:

- Lifecycle sync between store mutations and chart objects.
- A separate hit-test path (or wiring chart-native event handlers).
- A divergent selection / drag implementation for one of three drawing
  kinds.

Cost is high and asymmetric. We keep the canvas badge for now; a future
ADR can revisit if more shapes warrant native treatment.

## B. Auto-revert to `select` after commit

### Approach

Add an optional helper on `ToolCtx` and let each tool call it at the
moment of commit:

```ts
// in tools.ts ToolCtx
commitAndRevert(id: string): void;
```

The implementation in `DrawingOverlay.buildCtx`:

```ts
commitAndRevert: (id) => {
  const store = useDrawingsStore.getState();
  store.setSelected(id);
  store.setActiveTool('select');
},
```

Each drawing tool calls `commitAndRevert(newId)` immediately after
`ctx.add(...)`:

- `hlineTool.onPointerDown` — after add.
- `trendlineTool.onPointerUp` — after add.
- `pencilTool.onPointerUp` — after add.

`eraserTool` is intentionally excluded: erasing multiple shapes in
succession is a common flow, and the user can press `Esc` or `Alt+V`
to leave eraser mode.

### Why a ctx helper, not store changes

Keeps the `setSelected → setActiveTool` ordering in one place, makes the
behaviour easy to disable per-tool by simply not calling the helper, and
preserves the test-isolated `ToolCtx` contract (tests already inject
stubbed `add`/`setSelected`/`setActiveTool`).

## C. Keyboard shortcuts

### Bindings

| Key       | Action          |
|-----------|-----------------|
| `Alt+H`   | activate `hline`     |
| `Alt+T`   | activate `trendline` |
| `Alt+P`   | activate `pencil`    |
| `Alt+E`   | activate `eraser`    |
| `Alt+V`   | activate `select`    |
| `Esc`     | (existing) clear selection + revert to `select` |
| `Delete`/`Backspace` | (existing) remove selected drawing |

### Source of truth

Add an optional `shortcut` field to `DrawingToolSpec`:

```ts
shortcut?: { alt?: boolean; key: string }; // key is lowercase
```

Each tool spec declares its own shortcut:

```ts
hlineTool.shortcut     = { alt: true, key: 'h' };
trendlineTool.shortcut = { alt: true, key: 't' };
pencilTool.shortcut    = { alt: true, key: 'p' };
eraserTool.shortcut    = { alt: true, key: 'e' };
selectTool.shortcut    = { alt: true, key: 'v' };
```

The `DrawingOverlay` keydown effect iterates the `TOOLS` registry and
matches. New tools wire their shortcut in the spec — no second edit
site.

### Handler placement

Extend the existing `keydown` effect in `DrawingOverlay.tsx`. The
existing guard `target.tagName === 'INPUT' | 'TEXTAREA' | isContentEditable`
already prevents firing while typing in form fields; reuse it.

Pressing the shortcut for the *already-active* tool is a no-op (already
the case for `setActiveTool` because the store setter just writes the
same value).

### macOS Option-key consideration

On macOS, `Option+letter` typically inserts a special character into
text inputs. Because our handler bails on `INPUT/TEXTAREA/isContentEditable`,
this is safe — the chart area is not an input. We do not call
`preventDefault()` on the shortcut path because there is nothing to
prevent outside an input.

## Touched files

- `frontend/src/chart/drawing/types.ts`
  - Add `autoRevertOnCommit` is *not* needed (each tool calls
    `commitAndRevert` explicitly — simpler than a declarative flag).
  - Add `shortcut?: { alt?: boolean; key: string }` to `DrawingToolSpec`.
- `frontend/src/chart/drawing/tools.ts`
  - `hlineTool`, `trendlineTool`, `pencilTool` call
    `ctx.commitAndRevert(id)` after `ctx.add(...)`.
  - Declare `shortcut` on five tool specs.
- `frontend/src/chart/drawing/render.ts`
  - `renderHline` paints the price badge after the line stroke.
  - Internal helper `drawPriceBadge(c, x, y, text, bgColor, selected)`
    for clarity and future reuse.
- `frontend/src/chart/DrawingOverlay.tsx`
  - `ToolCtx` gains `commitAndRevert` and the `buildCtx` adds the impl.
  - keydown effect adds the shortcut dispatch loop.

## Tests

- `frontend/src/chart/drawing/tools.test.ts`
  - `hlineTool.onPointerDown` → asserts `setSelected(newId)` and
    `setActiveTool('select')` called after `add`.
  - Same for `trendlineTool.onPointerUp` and `pencilTool.onPointerUp`.
  - `eraserTool.onPointerDown` → asserts neither is called.
- `frontend/src/chart/drawing/render.test.ts` (new, if absent)
  - Spy on a fake `CanvasRenderingContext2D`; assert `renderHline`
    invokes `fillText` with the formatted price string and positions
    the badge near the right edge.
- Keyboard: extract the shortcut dispatch into a small pure helper
  (`matchShortcut(e, TOOLS): DrawingTool | null`) and unit-test it.
  Keeps `DrawingOverlay` untestable surface area small.

## Out of scope / follow-ups

- Editable label (click-to-edit price).
- Snap-to-tick on draw / drag.
- Hover preview line before commit (currently only pencil previews).
- Shortcut customisation UI.

## Open questions

None at spec-write time.
