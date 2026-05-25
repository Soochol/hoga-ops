# Drawing commit clears selection

**Date:** 2026-05-25
**Scope:** Replay viewer — drawing tools post-commit behaviour
**Author:** Brainstorm session with user (blessp@naver.com)

## Problem

When a user draws a new hline, trendline, or pencil stroke on the replay
chart, two things happen on commit:

1. The active tool reverts to `select` (intended — single-use tools).
2. The newly created drawing becomes the selected drawing — so it renders
   with the halo + 2× width selection emphasis.

The user reports (2) as inconsistent: the toolbar now indicates "select
mode," yet a drawing the user did not click is rendered as if it were the
focused selection. The intuition "select mode = nothing selected" is
violated.

This is a Figma/Illustrator-style convenience (the just-created shape is
pre-selected so it can be immediately moved or deleted), but on a charting
overlay where hlines and trendlines are usually drawn and left alone, the
emphasis reads as visual noise rather than a useful affordance.

User has accepted the trade-off: deleting a just-drawn shape now requires
click → Backspace (two steps) instead of Backspace alone.

## Goal

After a drawing is committed, `selectedId` is `null` so the drawing renders
in its normal (non-emphasised) style. The active tool still reverts to
`select` as today.

**Goal 2 (added 2026-05-25 after first round of dogfooding):** In `select`
mode, clicking on empty chart space (any pixel that isn't on a Drawing)
clears the current selection. The chart's own pan/zoom behaviour for that
click must be preserved — the deselection runs in parallel with, not
instead of, the chart's pointer handling.

## Non-goals

- No change to keyboard ESC behaviour (already clears both selection and tool).
- No change to selection emphasis itself (the halo + 2× width still applies
  when the user explicitly clicks a drawing).
- No change to drawing persistence, hit-testing, or pane binding.
- No change to the toolbar button styling — the button already returns to
  its non-active style when `activeTool === 'select'`.

## Design

### Rename and simplify `commitAndRevert`

Current contract — [DrawingOverlay.tsx:265-269](../../../frontend/src/chart/DrawingOverlay.tsx#L265-L269):

```ts
commitAndRevert: (id) => {
  const s = useDrawingsStore.getState();
  s.setSelected(id);
  s.setActiveTool('select');
},
```

New contract:

```ts
revertToSelectMode: () => {
  const s = useDrawingsStore.getState();
  s.setSelected(null);
  s.setActiveTool('select');
},
```

The `id` parameter becomes unused, so the signature drops it. The name
`revertToSelectMode` better reflects what the function now does — there's
no longer a "commit" step (the `ctx.add` call earlier in each tool is the
commit; this function is purely about returning to neutral state).

### Update the `ToolCtx` type

In [tools.ts:140](../../../frontend/src/chart/drawing/tools.ts#L140):

```ts
// Before
commitAndRevert(id: string): void;

// After
revertToSelectMode(): void;
```

### Update the three call sites

In [tools.ts](../../../frontend/src/chart/drawing/tools.ts):

- Line 280 (hline): `ctx.commitAndRevert(id)` → `ctx.revertToSelectMode()`
- Line 318 (trendline): same change
- Line 371 (pencil): same change

The local `id` variable becomes unused — we still need it for `ctx.add({ id, ... })`
since drawings need ids, just not for the post-commit call.

### Empty-click deselect (Goal 2)

Current behaviour: in `select` mode, the **Drawing Overlay** sets
`pointerEvents = 'none'` and uses a window-level `mousemove` listener to
flip it to `'auto'` only when the cursor is over a hit-testable Drawing
(see [DrawingOverlay.tsx:288-314](../../../frontend/src/chart/DrawingOverlay.tsx#L288-L314)).
A click on empty chart space therefore never reaches `selectTool.onPointerDown`
— the event passes straight through to lightweight-charts for pan/zoom —
which is why a previously-selected Drawing stays selected when the user
clicks elsewhere.

Add a sibling window-level `mousedown` listener, mounted whenever
`activeTool === 'select' && selectedId != null`, that hit-tests the click
position against the same `hitTestAt`:

```ts
const onWindowMouseDown = (e: MouseEvent) => {
  if (dragRef.current) return;
  const rect = container.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const insideOverlay =
    px >= 0 && py >= 0 && px <= rect.width && py <= rect.height;
  if (!insideOverlay) return;             // clicks outside chart: ignore
  if (hitTestAt(px, py)) return;          // hit a drawing → selectTool handles it
  useDrawingsStore.getState().setSelected(null);
};
```

The handler must NOT `preventDefault` or `stopPropagation` — chart pan
remains driven by lightweight-charts' own pointer pipeline on the
underlying canvas. The handler only runs when there is something to
deselect (cheap mount/unmount when `selectedId` flips between `null` and
non-null) so the global listener is not a long-lived listener on a quiet
page.

This pairs with the existing `onHover` effect, but the two cannot trivially
merge — `mousemove` toggles `pointerEvents`, `mousedown` toggles
`selectedId`. They share `hitTestAt` and the inside-overlay guard; the
implementation can extract those into a small helper if it keeps the
gating effect readable.

### Unify the `Escape` keyboard handler

The keyboard ESC handler at
[DrawingOverlay.tsx:174-177](../../../frontend/src/chart/DrawingOverlay.tsx#L174-L177)
already does `setSelected(null) + setActiveTool('select')` — semantically
identical to the new `revertToSelectMode`. Keeping two copies invites a
future change to "return to neutral" that updates one path and silently
diverges from the other.

Extract a single helper at module scope (or as a closure shared by both
the `ToolCtx` builder and the keydown handler):

```ts
const revertToSelectMode = () => {
  const s = useDrawingsStore.getState();
  s.setSelected(null);
  s.setActiveTool('select');
};
```

Both `ToolCtx.revertToSelectMode` and the `Escape` branch call this single
function. ADR-0030 records the "one canonical return-to-neutral path"
intent.

## Implementation outline

1. Rename `commitAndRevert` → `revertToSelectMode` on `ToolCtx`
   ([tools.ts:140](../../../frontend/src/chart/drawing/tools.ts#L140)).
2. Define the shared `revertToSelectMode` helper in
   `DrawingOverlay.tsx` (replaces the old `commitAndRevert` body at
   [DrawingOverlay.tsx:265-269](../../../frontend/src/chart/DrawingOverlay.tsx#L265-L269)).
   Reuse it from the `ToolCtx` builder and from the `Escape` branch of the
   keydown handler at
   [DrawingOverlay.tsx:174-177](../../../frontend/src/chart/DrawingOverlay.tsx#L174-L177).
3. Update three call sites in
   [tools.ts](../../../frontend/src/chart/drawing/tools.ts) (lines 280, 318, 371):
   `ctx.commitAndRevert(id)` → `ctx.revertToSelectMode()`.
4. Update `tools.test.ts`:
   - 12 references to `commitAndRevert` (rename to `revertToSelectMode`).
   - Replace `.toHaveBeenCalledWith(addedId)` assertions (lines 97, 151, 194)
     with plain `.toHaveBeenCalledOnce()` — the new helper takes no id.
   - "never calls commitAndRevert" assertions on eraser / zero-length /
     too-short-pencil (lines 159, 181, 201) keep the same shape, only the
     mocked property name changes.
5. Update domain docs:
   - `CONTEXT.md` Drawing Tool entry: post-commit state and `commitAndRevert`
     → `revertToSelectMode` rename, link to ADR-0030.
   - Add `docs/adr/0030-drawing-commit-clears-selection.md` (records the
     trade-off against the Figma pattern).
6. Run `npm run typecheck` + `npm test` in `frontend/`. Manual QA per the
   scenarios below.

## Testing

### Unit / integration

- Grep for `commitAndRevert` across `frontend/`: only the four locations
  above plus possibly test files. Test files referencing the old name need
  rename; tests asserting post-commit `selectedId` need to expect `null`.
- `drawings.test.ts`, `Workarea.test.tsx`, and any drawing-tool unit tests
  are the likely candidates; verify and update.

### Manual QA (in `/replay`)

1. Pick the hline tool → click in a pane → verify:
   - Toolbar drawing button returns to the un-highlighted (select) state.
   - The new horizontal line renders **without** halo or thickened stroke.
2. Click the new hline once → verify it now shows halo + thickened stroke
   (selection emphasis still works on explicit click).
3. With it selected, press Backspace → verify it is deleted.
4. Repeat (1) for trendline (drag) and pencil (drag).
5. With nothing selected, press ESC → verify no error and no state change
   (ESC already handles null-selected case).

## Risks

- **Test churn:** Any test that asserted "new drawing is auto-selected" will
  fail. These need a one-line expectation update — low risk, easy to spot.
- **Workflow regression:** The "draw → Backspace to undo" shortcut is lost.
  User explicitly accepted this trade-off during brainstorm. Users who want
  to undo a just-drawn shape now need click → Backspace, or in the future
  we could add a real undo stack (out of scope).

## Decision log

- **Why not keep `commitAndRevert` and just pass `null`?** The function's
  whole purpose changes — it no longer "commits and reverts," it just
  reverts. Renaming makes the call sites read correctly. The `id` parameter
  becoming dead weight is the clearest signal that the rename is right.
- **Why not refactor ESC handler to use the new helper?** Out of scope.
  Worth doing, but mixing it into this change would dilute the review.
