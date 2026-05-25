# Drawing Property Panel — Design Spec

**Date:** 2026-05-25
**Status:** Approved — ready for implementation plan
**Authors:** blessp@naver.com (via brainstorming session)
**Supersedes:** ADR-0030 (post-commit clears selection) — partial

## Problem

The Replay Viewer's drawing tools (horizontal line, trendline, pencil) are
currently locked to a single visual style: accent teal at 1.5 px, solid
stroke. A drawing's `color` and `width` fields exist in the model but are
never user-editable, and there is no `lineStyle` field at all. Users who
want a red resistance line, a dashed pivot, or a thicker support level
have no way to express that intent.

Adding a property panel is the natural next step. It changes the
*creation* flow too: ADR-0030 chose to keep a freshly-drawn shape
**unselected** so that "select mode" wouldn't visually contradict itself
(a non-clicked shape rendered with a halo read as noise). Once a
property panel exists, a fresh drawing has somewhere honest to point —
the halo is no longer "noise that means nothing," it's the visual anchor
for the panel the user is about to use. ADR-0030's premise no longer
holds, and this spec supersedes it.

## Goals

1. Per-drawing **color**, **stroke width**, and **line style** that
   render to canvas and persist with the drawing in `localStorage`.
2. A floating **Drawing Property Panel** that appears when a drawing is
   selected, lets the user change all three properties, and lets the
   user delete the drawing.
3. **Sticky defaults** — the last color/width/style the user picked is
   used as the starting value for the next new drawing of any kind,
   persisted across sessions.
4. Restore halo + selection on freshly-committed drawings (ADR-0030
   reversal), so the panel has a target.
5. Keep the rest of ADR-0030 intact — empty-click still deselects.
6. Backwards-compatible with existing `localStorage` drawings (no data
   migration scripts, hydration handles the gap).

## Non-Goals

- Locked drawings (`locked: boolean` field). User declined for v1.
- Arbitrary hex colour input. Sixteen-color palette is fixed.
- Persisting panel position across sessions. Session-only, in-memory.
- Panel that follows pan/zoom and "sticks" to its drawing. The panel
  re-positions when selection changes; it does not track the drawing
  on chart motion.
- Multi-selection.
- A real undo stack (still future work, mentioned in ADR-0030).
- Text-label drawings.

## Approach — Sibling component, store-driven, sticky defaults

The panel is a new sibling component of `DrawingOverlay`, mounted by
`ChartStage`. Both subscribe to `useDrawingsStore.selectedId` — the
overlay handles canvas hit-testing and drag-on-canvas, the panel handles
DOM popovers, the property edits, and panel drag-in-DOM. This split
keeps `DrawingOverlay.tsx` (currently 376 lines) from growing past 500
and makes the panel's responsibilities cohesive.

Sticky defaults live in the same store as a new `defaults` slice. Every
`update(id, patch)` that touches `color`, `width`, or `lineStyle` also
calls `setDefaults(patch)` so the store stays the single source of
truth for "what will the next drawing look like." Defaults are
persisted to a separate localStorage key (`replay.drawingDefaults.v1`)
that is scoped to the user, not the stock code — the user's color
preference is a personal preference, not a per-stock annotation.

## Detailed Design

### Domain model — `frontend/src/chart/drawing/types.ts`

```ts
export type LineStyle = 'solid' | 'dashed' | 'dotted';

interface DrawingBase {
  id: DrawingId;
  color: string;        // hex from COLOR_PALETTE; model accepts any string
  width: number;        // {1, 2, 3, 4, 5}; model accepts any positive number
  lineStyle: LineStyle; // NEW
  paneId: PaneId;
}

export const COLOR_PALETTE = [
  '#14B8A6', '#10B981', '#F43F5E', '#F59E0B',
  '#EF4444', '#F97316', '#EAB308', '#84CC16',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899',
  '#FFFFFF', '#9CA3AF', '#4B5563', '#1F2937',
] as const;

export const STROKE_WIDTHS = [1, 2, 3, 4, 5] as const;
export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
```

The model is permissive (string color, positive-number width) so that
legacy data with `width: 1.5` renders cleanly. The UI is restrictive
(palette + integer steps) so that no new data can drift from the
discrete set.

### State — `frontend/src/state/drawings.ts`

A new `defaults` slice and matching action are added:

```ts
type DrawingDefaults = {
  color: string;
  width: number;
  lineStyle: LineStyle;
};

const INITIAL_DEFAULTS: DrawingDefaults = {
  color: '#14B8A6',
  width: 2,
  lineStyle: 'solid',
};

type State = {
  // ...existing
  defaults: DrawingDefaults;
};

type Actions = {
  // ...existing
  setDefaults(patch: Partial<DrawingDefaults>): void;
};
```

`update(id, patch)` is amended to call `setDefaults` for any of
`color`/`width`/`lineStyle` it touches. Drawing-tool constructors in
`tools.ts` read `defaults` instead of hardcoded teal/1.5/solid.

Defaults are loaded **once at store creation** (module init time, same
moment the `useDrawingsStore` create-callback runs) and persisted on
every change, debounced 250 ms (same pattern as per-code drawings),
under key `replay.drawingDefaults.v1`. On read failure or absent key,
fall back to `INITIAL_DEFAULTS` silently.

### Persistence — `frontend/src/chart/drawing/persistence.ts`

The existing wrapper version stays `v: 1`. The hydration map adds:

```ts
const lineStyle = (item as { lineStyle?: LineStyle }).lineStyle ?? 'solid';
return { ...rest, paneId, lineStyle } as Drawing;
```

Legacy drawings without `lineStyle` get `'solid'`. Legacy `width: 1.5`
renders identically to before — the thickness picker shows the closest
member of `STROKE_WIDTHS` (2 px) as selected for display only; the
first time the user changes the thickness, the value snaps to the
chosen integer step.

A separate module-level helper handles `defaults`:

```ts
const DEFAULTS_KEY = 'replay.drawingDefaults.v1';
export function loadDefaults(): DrawingDefaults { ... }
export function saveDefaults(d: DrawingDefaults): void { ... }
```

### Rendering — `frontend/src/chart/drawing/render.ts`

`setStroke` learns `lineStyle`:

```ts
function setStroke(c, d, selected) {
  c.strokeStyle = d.color;
  c.lineWidth = selected ? d.width * 2 : d.width;
  c.lineCap = d.lineStyle === 'dotted' ? 'round' : 'butt';
  c.lineJoin = 'round';
  c.setLineDash(dashPattern(d.lineStyle, d.width));
}

function dashPattern(style: LineStyle, width: number): number[] {
  switch (style) {
    case 'solid':  return [];
    case 'dashed': return [width * 3, width * 2];
    case 'dotted': return [0, width * 2.5]; // round cap + 0-len dash = dots
  }
}
```

Halo behaviour is unchanged in `render.ts` — it still draws when
`selected` is true. The reversal lives in `tools.ts` (next subsection).

### Tool commit flow — `frontend/src/chart/drawing/tools.ts`

`revertToSelectMode()` is restored to the pre-ADR-0030 semantics:

```ts
function revertToSelectMode(newDrawingId: DrawingId) {
  const s = useDrawingsStore.getState();
  s.setActiveTool('select');
  s.setSelected(newDrawingId); // <-- restored
}
```

All three tool constructors (`hline`, `trendline`, `pencil`) call this
with their freshly-added drawing's id. The `Escape` keyboard handler in
`DrawingOverlay` keeps calling the *no-id* path
(`setActiveTool('select') + setSelected(null)`) since Escape's
semantics ("return to neutral") have not changed.

The companion behaviour ADR-0030 added — *empty-click deselects in
select mode* — is preserved as-is.

### Components

**New file:** `frontend/src/chart/DrawingPropertyPanel.tsx` (~250 lines)

Mounted by `ChartStage` as a sibling of `DrawingOverlay`. **Renders
only when `activeTool === 'select' && selectedId != null`** — the
two-clause gate matters: if the user has a drawing selected and then
switches to a drawing tool (e.g. hline) to draw a new shape, the
panel for the previously-selected drawing must disappear, otherwise
the user would see a property panel for an unrelated drawing while
they draft a new one. Reads the selected drawing from the store and
writes back via `update(id, patch)`.

Structure:

```
<DrawingPropertyPanel>
  <Grip />                        // ⋮⋮, owns drag
  <ColorTrigger />                // ✎ + 3px bar in drawing.color
    <ColorPopover />              // 4×4 swatch grid (no labels)
  <ThicknessTrigger />            // — Npx
    <ThicknessList />             // 5 items, each with stroke preview
  <LineStyleTrigger />            // — or - - or · · ·
    <LineStylePopover />          // 3 items: 실선 / 대시 / 도트
  <Divider />
  <DeleteButton />                // 🗑 → remove(id)
</DrawingPropertyPanel>
```

Local state:

- `position: { x: number; y: number } | null` — recomputed on
  `selectedId` change; written by the drag handler.
- `openPopover: 'color' | 'thickness' | 'lineStyle' | null` — one at a
  time; clicking another trigger swaps; outside mousedown or Escape
  closes it.

Initial position when `selectedId` becomes non-null. All coordinates are
in the **chart container's local coordinate space** (the same space the
panel is `position: absolute`-ed in), derived from the pane's offset
within the chart container plus the drawing's canvas coordinates:

- **hline**: pane-left + 14 px,  y(price) − 38 px.
- **trendline**: midpoint of `a` and `b` projected to canvas, then
  offset `(−8 px, −38 px)`.
- **pencil**: top-left of the point bounding box (canvas-projected),
  offset `(0, −38 px)`.
- Clamped to the chart container's visible rect — the panel never
  drifts off-screen on initial placement.

Drag: `mousedown` on grip captures start mouse + start panel; window
`mousemove` updates position absolutely; window `mouseup` ends. No
preventDefault — text selection on chart doesn't happen anyway, and
hands-off keeps the chart panable everywhere else.

Popover dismissal mirrors the existing `DrawingMenu.tsx` pattern:
window `mousedown` listener checks `popoverRef.current.contains`,
`keydown` checks `Escape`.

**Selection indicator inside each popover/list**:
- Colour popover: swatch whose hex matches `drawing.color` shows a
  white 2 px border + check glyph.
- Thickness list: row whose value equals `drawing.width` is
  highlighted (`bg-bg-input-hover`, accent-coloured text). If
  `drawing.width` is not in `STROKE_WIDTHS` (legacy 1.5 px), the
  closest member is highlighted for display only — picking any value
  writes the integer.
- Line-style list: row matching `drawing.lineStyle` is highlighted
  the same way.

### ADR-0032 — Drawing Property Panel (supersedes ADR-0030)

New file: `docs/adr/0032-drawing-property-panel.md`.

Outline:
- **Status**: accepted (2026-05-25)
- **Decision**: post-commit `selectedId = newDrawing.id`; halo + panel
  on fresh drawings; sticky defaults persisted; sixteen-color palette;
  five thickness steps; three line styles; session-only panel
  position; empty-click-deselects retained.
- **Why this supersedes ADR-0030**: the "halo as noise" critique
  depended on there being no DOM affordance pointing at the freshly-
  drawn shape. Once the property panel exists, the halo is the visual
  anchor for the panel; removing it would make the panel point at
  nothing in particular.
- **Why the palette is fixed**: free-form colour entry would break the
  design-token discipline DESIGN.md sets and add an entire input
  surface (eyedropper, hex parsing, accessibility contrast) for a
  marginal-value feature. Sixteen colours covers the practical needs.
- **Why session-only panel position**: persistent position
  per-drawing is feature creep — the panel's purpose is "edit this
  drawing now," not "remember where I parked the panel for this line."
  The simpler model also avoids designing what "follow the chart on
  pan" means when the drawing is off-screen.

### Domain doc updates

- `CONTEXT.md` gets a new glossary entry **Drawing Property Panel**
  (definition, dependencies, lifecycle bullet).
- `CONTEXT.md`'s existing **Drawing Tool** entry's post-commit
  description is rewritten to point at ADR-0032.
- `DESIGN.md` gets a one-paragraph addition under the colour discipline
  section: "user-annotation layer" is a fourth category, distinct from
  UI / status / market direction — the sixteen-colour drawing palette
  lives there.

## Interaction reference table

| Action | Result |
|---|---|
| Draw new shape (any tool) | `setActiveTool('select')`, `setSelected(newId)`; halo + panel shown |
| Click swatch in colour popover | `update(id, {color}) + setDefaults({color})`; popover closes |
| Click thickness item | `update(id, {width}) + setDefaults({width})`; popover closes |
| Click line-style item | `update(id, {lineStyle}) + setDefaults({lineStyle})`; popover closes |
| Click 🗑 | `remove(id)`; panel disappears |
| Click empty chart | `setSelected(null)`; panel disappears |
| Click different drawing | `setSelected(otherId)`; panel re-positions; popover closes |
| Drag grip | Panel moves in DOM; drawing untouched |
| Chart pan/zoom | Drawing moves; panel keeps last drag position |
| Escape (popover open) | Popover closes; selection retained |
| Escape (no popover) | `setSelected(null) + setActiveTool('select')`; panel disappears |
| Switch stock code | Selection cleared, panel position reset |
| Switch to a drawing tool (any non-select) | Panel hides immediately (gated by `activeTool === 'select'`); selection state itself is untouched |

## Testing

| File | Cases |
|---|---|
| `state/drawings.test.ts` | `update` syncs `defaults`; `setDefaults` partial patches; defaults persisted via debounced write; defaults load on init; missing key → `INITIAL_DEFAULTS` |
| `chart/drawing/persistence.test.ts` | legacy item without `lineStyle` hydrates to `'solid'`; legacy `width: 1.5` preserved as-is |
| `chart/drawing/tools.test.ts` | post-commit assertion flips from `setSelected(null)` to `setSelected(newId)` for all three tools |
| `chart/drawing/render.test.ts` | `setLineDash` called with `dashPattern(style, width)`; lineCap switches for `'dotted'` |
| `chart/DrawingPropertyPanel.test.tsx` *(new)* | renders when `selectedId != null`; each popover open/close (trigger, outside click, Escape); selecting a swatch dispatches `update + setDefaults`; clicking delete dispatches `remove`; drag updates local position; only one popover open at a time |

## Migration

- No data migration script. Hydration handles legacy items:
  `lineStyle ?? 'solid'`, `width` preserved.
- Defaults key is new; absent on first run, falls back to `INITIAL_DEFAULTS`.
- No bump of the per-code wrapper `v: 1`.

## Out of scope (future work)

- Locked drawings.
- Free-form hex colour entry.
- Panel position persistence (per-drawing or per-stock).
- Panel pinned-to-drawing on pan/zoom.
- Multi-selection of drawings.
- Real undo stack.
- Text-label drawings.
