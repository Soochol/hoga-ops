# Drawing commit clears selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a drawing tool (hline/trendline/pencil) commits a new Drawing on the Replay chart, render the new shape in its normal (un-emphasised) style — `selectedId` becomes `null` and `activeTool` reverts to `select`. Selection emphasis (halo + 2× stroke) is reserved for shapes the user explicitly clicks.

**Architecture:** Rename `ToolCtx.commitAndRevert(id)` → `revertToSelectMode()` (no args). Move the body into a single helper shared by both the `ToolCtx` builder and the `Escape` keyboard handler in `DrawingOverlay.tsx`. Three call sites in `tools.ts` drop the `id` argument. Tool tests update mock name + drop `.toHaveBeenCalledWith(addedId)` assertions.

**Tech Stack:** TypeScript, React, Zustand (`useDrawingsStore`), Vitest. No new dependencies. No store schema or persistence change.

**Spec:** [docs/superpowers/specs/2026-05-25-drawing-commit-clears-selection-design.md](../specs/2026-05-25-drawing-commit-clears-selection-design.md)
**ADR:** [docs/adr/0030-drawing-commit-clears-selection.md](../../adr/0030-drawing-commit-clears-selection.md)
**Glossary:** [CONTEXT.md](../../../CONTEXT.md) — Drawing Tool entry (already updated)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/chart/drawing/tools.ts` | Modify | `ToolCtx` interface — rename helper, drop `id` param. Three call sites (hline/trendline/pencil) drop the `id` argument. |
| `frontend/src/chart/drawing/tools.test.ts` | Modify | 12 `commitAndRevert` references → `revertToSelectMode`; 3 `.toHaveBeenCalledWith(addedId)` assertions become `.toHaveBeenCalledOnce()`. |
| `frontend/src/chart/DrawingOverlay.tsx` | Modify | Define shared `revertToSelectMode` closure inside the component. Wire `ToolCtx.revertToSelectMode` to it. Replace the inline `setSelected(null) + setActiveTool('select')` in the `Escape` branch with a call to the same closure. |

No new files. `eraser` tool is untouched (it never calls the helper; spec confirms).

---

## Task 1: Rename `commitAndRevert` → `revertToSelectMode` (tools + tool tests)

**Files:**
- Modify: `frontend/src/chart/drawing/tools.test.ts` (12 sites at lines 29, 92, 95, 97, 139, 149, 151, 154, 159, 177, 181, 186, 192, 194, 197, 201)
- Modify: `frontend/src/chart/drawing/tools.ts` (interface at line 140; call sites at lines 280, 318, 371)

This task is a single coordinated rename + signature change. The behavioural meaning lives in the wiring (Task 2). At the tool layer, the only invariant is "tools that auto-revert after commit call the helper exactly once, with no arguments."

- [ ] **Step 1: Update `tools.test.ts` — rename mock + drop `addedId` assertions (failing)**

Edit `frontend/src/chart/drawing/tools.test.ts`:

In the `makeCtx` helper at line 29, change the mock property name:

```ts
// Before
commitAndRevert: vi.fn(),
// After
revertToSelectMode: vi.fn(),
```

Then update every `ctx.commitAndRevert` reference to `ctx.revertToSelectMode`. Specifically:

- Line 92 (test name): `'calls commitAndRevert with the new id after add'` → `'calls revertToSelectMode after add'`
- Line 95: `expect(ctx.commitAndRevert).toHaveBeenCalledOnce();` → `expect(ctx.revertToSelectMode).toHaveBeenCalledOnce();`
- Lines 96-97: **delete** these two lines (the `addedId` resolution and the `.toHaveBeenCalledWith(addedId)` assertion). The helper no longer takes an id.

```ts
// Before (lines 92-98)
  it('calls commitAndRevert with the new id after add', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.commitAndRevert).toHaveBeenCalledWith(addedId);
  });

// After
  it('calls revertToSelectMode after add', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.revertToSelectMode).toHaveBeenCalledOnce();
  });
```

Apply the same pattern at lines 139-152 (trendline) and 186-195 (pencil):

```ts
// trendline — replace lines 139-152
  it('calls revertToSelectMode on pointer-up commit', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const downCtx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(downCtx);
    const upCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: downCtx.trendlineDraft,
    });
    trendlineTool.onPointerUp!(upCtx);
    expect(upCtx.revertToSelectMode).toHaveBeenCalledOnce();
  });

// pencil — replace lines 186-195
  it('calls revertToSelectMode on pointer-up commit', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    ctx.pencilDraft.current!.points.push({ realMs: 1_700_000_000_001, price: 70_010 });
    pencilTool.onPointerUp!(ctx);
    expect(ctx.revertToSelectMode).toHaveBeenCalledOnce();
  });
```

The "does NOT call" tests at lines 154-160 (trendline zero-length), 177-182 (eraser), and 197-202 (pencil too-short) only need the mock name swapped — the behavioural assertion shape is unchanged:

```ts
// Pattern, applied three places:
//   expect(ctx.commitAndRevert).not.toHaveBeenCalled();
// → expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
```

The test name strings on lines 154, 177, 197 should also be updated for consistency:

- Line 154: `'does NOT call commitAndRevert when the trendline is zero-length (rejected)'` → `'does NOT call revertToSelectMode when the trendline is zero-length (rejected)'`
- Line 177: `'never calls commitAndRevert (continuous-erase flow)'` → `'never calls revertToSelectMode (continuous-erase flow)'`
- Line 197: `'does NOT call commitAndRevert when the pencil has fewer than 2 points'` → `'does NOT call revertToSelectMode when the pencil has fewer than 2 points'`

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- tools.test.ts`
Expected: tests fail with TypeScript error or runtime "ctx.revertToSelectMode is not a function" — because `ToolCtx` still has `commitAndRevert` and tools.ts still calls `ctx.commitAndRevert(id)`. This proves the test is checking the new contract.

- [ ] **Step 3: Update `ToolCtx` interface in `tools.ts`**

Edit `frontend/src/chart/drawing/tools.ts` lines 136-140:

```ts
// Before
  setSelected(id: string | null): void;
  /** Helper that selects the just-committed drawing and reverts the active
   *  tool to `select`. Called by tools that auto-revert after commit
   *  (hline, trendline, pencil). The overlay's buildCtx wires this to
   *  `setSelected(id)` + `setActiveTool('select')` on the store. */
  commitAndRevert(id: string): void;

// After
  setSelected(id: string | null): void;
  /** Helper that returns the overlay to neutral state: clears `selectedId`
   *  and switches the active tool back to `select`. Called by tools that
   *  auto-revert after commit (hline, trendline, pencil). The overlay's
   *  buildCtx wires this to a shared closure that the `Escape` keyboard
   *  handler also calls — one canonical "return to neutral" path. See
   *  ADR-0030. */
  revertToSelectMode(): void;
```

- [ ] **Step 4: Update the three call sites in `tools.ts`**

Three identical edits at lines 280, 318, 371:

```ts
// Before (each site)
    ctx.commitAndRevert(id);
// After
    ctx.revertToSelectMode();
```

The local `const id = nanoid(8);` line above each site **stays** — it's still passed to `ctx.add({ id, ... })`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npm test -- tools.test.ts`
Expected: all `tools.test.ts` tests pass. If any fail, double-check that every `commitAndRevert` reference in the test file was renamed (a leftover would surface as `ctx.commitAndRevert is undefined`).

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: passes. If `DrawingOverlay.tsx` errors with "Property 'revertToSelectMode' is missing", that is **expected** — Task 2 fixes it. Proceed to Task 2 without committing if the typecheck error is only the missing wiring in DrawingOverlay.

Actually — the typecheck error blocks `npm test` from running cleanly across the project. To keep tasks atomically committable, defer the commit to **after Task 2**. Mark this task done but do not commit yet; the next task's commit will cover both.

---

## Task 2: Wire `revertToSelectMode` in `DrawingOverlay` + unify `Escape` handler

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx` (lines 156-181 for the keydown effect; lines 238-271 for the `ToolCtx` builder)

This task makes the rename runnable: defines the new closure, wires the `ToolCtx`, and routes the `Escape` branch through the same closure so the two formerly-identical code paths converge.

- [ ] **Step 1: Add the shared `revertToSelectMode` closure inside the component body**

Place the closure at component scope (top of the function body, before any `useEffect` so the keyboard effect can close over it). Insert just before the `useEffect` at line 60 (the redraw loop):

```ts
// Shared "return to neutral" path. Routed to from:
//   - ToolCtx.revertToSelectMode (called by hline/trendline/pencil after commit)
//   - Escape keypress handler
// See ADR-0030 for why a just-committed shape is no longer auto-selected.
const revertToSelectMode = () => {
  const store = useDrawingsStore.getState();
  store.setSelected(null);
  store.setActiveTool('select');
};
```

- [ ] **Step 2: Replace the inline body in the `Escape` branch**

Edit `frontend/src/chart/DrawingOverlay.tsx` lines 174-177:

```ts
// Before
      } else if (e.key === 'Escape') {
        useDrawingsStore.getState().setSelected(null);
        useDrawingsStore.getState().setActiveTool('select');
      }

// After
      } else if (e.key === 'Escape') {
        revertToSelectMode();
      }
```

- [ ] **Step 3: Update `ToolCtx` wiring**

Edit `frontend/src/chart/DrawingOverlay.tsx` lines 265-269 (inside `buildCtx`):

```ts
// Before
      commitAndRevert: (id) => {
        const s = useDrawingsStore.getState();
        s.setSelected(id);
        s.setActiveTool('select');
      },

// After
      revertToSelectMode,
```

(Plain shorthand — the closure is in scope and matches the `ToolCtx` interface signature `revertToSelectMode(): void`.)

- [ ] **Step 4: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: passes. The `ToolCtx` shape now matches (`revertToSelectMode` is present, `commitAndRevert` is gone).

- [ ] **Step 5: Run the full frontend test suite**

Run: `cd frontend && npm test`
Expected: all tests pass. Specifically watch for:

- `tools.test.ts` — passes (Task 1 changes now compile because the interface exists).
- `drawings.test.ts` — untouched, passes.
- `Workarea.test.tsx` — untouched, passes.
- `DrawingOverlay` tests if any exist — passes.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/drawing/tools.ts \
        frontend/src/chart/drawing/tools.test.ts \
        frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(replay): clear selection on drawing commit (revertToSelectMode)

Rename ToolCtx.commitAndRevert(id) -> revertToSelectMode(). After a
drawing tool commits, selectedId is cleared instead of being set to the
just-committed id, so the new shape renders without the halo. Escape
keyboard handler now routes through the same shared helper.

ADR-0030 and CONTEXT.md Drawing Tool entry already record the intent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Manual QA on `/replay`

This is a behaviour change. Code-level tests cover the wiring contract; visual emphasis and keyboard regressions need eyes on the page.

**Files:** none modified.

**Pre-requisites:** Backend + frontend dev servers running (see [CLAUDE.md](../../../CLAUDE.md) "Dev servers" section). Open `http://localhost:5173/replay` and load any Stock-Date Range so a chart is on screen.

- [ ] **Step 1: hline — draw and observe no halo**

1. Click the drawing toolbar button (✏) → "수평선" (hline).
2. Click in the candle pane.
3. **Verify:** drawing toolbar button glyph returns to ✏ (select mode). The new horizontal line renders **thin** — no halo, no glow. The price badge on the right edge does not show the white selection border.

- [ ] **Step 2: hline — explicit selection still works**

1. With the hline drawn from Step 1, click the line itself.
2. **Verify:** line thickens, halo appears, badge gets a white border. (Pre-existing selection emphasis path is unaffected.)
3. Press Backspace.
4. **Verify:** the hline is deleted.

- [ ] **Step 3: trendline — drag, then observe no halo**

1. Click drawing toolbar → "추세선" (trendline).
2. Drag from one point to another in the candle pane.
3. **Verify:** drawing toolbar returns to ✏. Trendline renders thin, no halo, no endpoint handles.
4. Click the trendline to confirm explicit selection still adds halo + endpoint handles.
5. Delete it with Backspace.

- [ ] **Step 4: pencil — freehand, then observe no halo**

1. Click drawing toolbar → "연필" (pencil).
2. Drag a freehand stroke.
3. **Verify:** drawing toolbar returns to ✏. Pencil stroke renders thin.
4. Click it → halo appears. Backspace deletes.

- [ ] **Step 5: eraser — unchanged continuous-erase flow**

1. Draw two or three hlines (each one renders thin per the new behaviour — good).
2. Click drawing toolbar → "지우개" (eraser).
3. Click one of the hlines → it disappears.
4. **Verify:** eraser stays active (toolbar still shows ⌫, not ✏). Click another hline → it disappears. The continuous-erase flow is preserved.
5. Press Escape to return to select mode.

- [ ] **Step 6: Escape — still works in both directions**

1. Pick the hline tool from the menu (toolbar shows ━).
2. Press Escape **before** drawing anything.
3. **Verify:** active tool reverts to select (toolbar back to ✏), no errors in browser console.
4. Draw an hline → click it to select → press Escape.
5. **Verify:** selection cleared (halo gone), active tool already select (no change).

- [ ] **Step 7: Mark QA done**

If all 6 scenarios pass, this plan is complete. If anything fails, file a regression note against the spec and revisit Task 2.

---

## Self-Review (already performed during plan authoring)

**Spec coverage:**
- Spec "Rename and simplify `commitAndRevert`" → Task 1 (Steps 3-4) + Task 2 (Step 3).
- Spec "Update the `ToolCtx` type" → Task 1 Step 3.
- Spec "Update the three call sites" → Task 1 Step 4.
- Spec "Unify the `Escape` keyboard handler" → Task 2 Steps 1-2.
- Spec "Implementation outline" item 4 (test updates) → Task 1 Steps 1-2.
- Spec "Implementation outline" item 5 (CONTEXT.md + ADR-0030) → already committed in the grill step (`d816324`); intentionally NOT re-listed as a task.
- Spec "Testing: Manual QA" → Task 3.

**Placeholder scan:** no TBDs, no "implement later", every code step shows exact code, every command shows expected output.

**Type consistency:** the helper is named `revertToSelectMode` in `ToolCtx` (Task 1 Step 3), in the closure (Task 2 Step 1), in the wiring (Task 2 Step 3), and in all test mocks (Task 1 Step 1). The signature is `(): void` everywhere — no calls pass an id.
