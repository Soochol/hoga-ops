# Drawing UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three small UX improvements to the replay chart's drawing tools — hline price label, auto-revert to select after commit, and `Alt+` keyboard shortcuts — all scoped to `frontend/src/chart/drawing/` and `frontend/src/chart/DrawingOverlay.tsx`.

**Architecture:** Extends the existing **Drawing Tool** deep module (`tools.ts` spec registry) with two new optional fields (`shortcut?`, behavioural hook via `ToolCtx.commitAndRevert(id)`), one new render-helper in `render.ts` (`drawPriceBadge`), and one new keydown branch in `DrawingOverlay.tsx`. No changes to the `Drawing` data model, persistence format, or store shape. See spec `docs/superpowers/specs/2026-05-24-drawing-ux-improvements-design.md` and ADR-0025.

**Tech Stack:** TypeScript, React, Zustand, Vitest, lightweight-charts. Tests run with `cd frontend && npm run test`. Single-file test run: `npx vitest run src/chart/drawing/<file>.test.ts`.

---

## File Structure

**Modify:**
- `frontend/src/chart/drawing/tools.ts` — add `shortcut?` to `DrawingToolSpec`, add `commitAndRevert` to `ToolCtx`, wire commit-and-revert into `hlineTool`/`trendlineTool`/`pencilTool`, declare `shortcut` on all five specs, export new helper `matchShortcut`
- `frontend/src/chart/drawing/render.ts` — add private `drawPriceBadge` helper, extend `renderHline` to paint the badge
- `frontend/src/chart/DrawingOverlay.tsx` — supply `commitAndRevert` in `buildCtx`, extend keydown effect to dispatch `Alt+` shortcuts with active-gesture guard

**Modify (tests):**
- `frontend/src/chart/drawing/tools.test.ts` — add tests for `commitAndRevert` invocation and `matchShortcut` helper

**Create (tests):**
- `frontend/src/chart/drawing/render.test.ts` — new file, tests for `renderHline` price badge

---

## Task 1: Add `commitAndRevert` to `ToolCtx` (failing test first)

**Files:**
- Modify: `frontend/src/chart/drawing/tools.test.ts`

- [ ] **Step 1.1: Add the failing test for `commitAndRevert` being called by `hlineTool`**

In `frontend/src/chart/drawing/tools.test.ts`, replace the existing `describe('hlineTool.onPointerDown', ...)` block with this expanded version (preserve the two existing tests, add the third):

```ts
describe('hlineTool.onPointerDown', () => {
  it('adds an Hline at the cursor price', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.kind).toBe('hline');
    if (added.kind === 'hline') {
      expect(added.price).toBe(70_000);
      expect(added.color).toBe('#14B8A6');
    }
  });

  it('does nothing when pixelToData returns null (price scale unavailable)', () => {
    const ctx = makeCtx({ pixelToData: vi.fn(() => null) });
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });

  it('calls commitAndRevert with the new id after add', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.commitAndRevert).toHaveBeenCalledWith(addedId);
  });
});
```

Also extend the `makeCtx` helper near the top of the file — add `commitAndRevert: vi.fn(),` to the `base: ToolCtx` object (alphabetically near `capturePointer`):

```ts
    capturePointer: vi.fn(),
    commitAndRevert: vi.fn(),
    releasePointer: vi.fn(),
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`

Expected: TypeScript compile error — `Property 'commitAndRevert' is missing in type 'ToolCtx'`, plus runtime failure on the new assertion. This confirms `ToolCtx` does not yet declare the field.

- [ ] **Step 1.3: Add `commitAndRevert` to the `ToolCtx` type**

In `frontend/src/chart/drawing/tools.ts`, inside the `export type ToolCtx = { ... }` block, add the field at the end of the "Store actions" section (after `setSelected`):

```ts
  setSelected(id: string | null): void;
  /** Helper that selects the just-committed drawing and reverts the active
   *  tool to `select`. Called by tools that auto-revert after commit
   *  (hline, trendline, pencil). The overlay's buildCtx wires this to
   *  `setSelected(id)` + `setActiveTool('select')` on the store. */
  commitAndRevert(id: string): void;
};
```

- [ ] **Step 1.4: Wire `hlineTool` to call `commitAndRevert`**

In `frontend/src/chart/drawing/tools.ts`, replace the `hlineTool.onPointerDown` body:

```ts
export const hlineTool: DrawingToolSpec = {
  kind: 'hline',
  label: '수평선',
  glyph: '━',
  cursor: 'crosshair',
  onPointerDown(ctx) {
    const data = ctx.pixelToData(ctx.px, ctx.py);
    if (!data) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'hline',
      price: data.price,
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
    });
    ctx.commitAndRevert(id);
  },
};
```

- [ ] **Step 1.5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`

Expected: all `hlineTool` tests pass (3/3). The other tools still pass too; they don't yet call `commitAndRevert` but their existing tests don't assert on it.

- [ ] **Step 1.6: Commit**

```bash
git add frontend/src/chart/drawing/tools.ts frontend/src/chart/drawing/tools.test.ts
git commit -m "feat(drawing): hline auto-reverts to select after commit via ToolCtx.commitAndRevert"
```

---

## Task 2: Wire `commitAndRevert` for `trendlineTool` and `pencilTool`

**Files:**
- Modify: `frontend/src/chart/drawing/tools.ts`
- Modify: `frontend/src/chart/drawing/tools.test.ts`

- [ ] **Step 2.1: Add failing tests for trendline + pencil + eraser-exclusion**

In `frontend/src/chart/drawing/tools.test.ts`, append to the existing `describe('trendlineTool — drag commits a 2-point segment', ...)` block (inside it, alongside the existing `it` tests):

```ts
  it('calls commitAndRevert with the new trendline id on pointer-up', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const downCtx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(downCtx);
    const upCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: downCtx.trendlineDraft,
    });
    trendlineTool.onPointerUp!(upCtx);
    expect(upCtx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((upCtx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(upCtx.commitAndRevert).toHaveBeenCalledWith(addedId);
  });

  it('does NOT call commitAndRevert when the trendline is zero-length (rejected)', () => {
    const p: Point = { realMs: 1_000, price: 100 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => p) });
    trendlineTool.onPointerDown!(ctx);
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.commitAndRevert).not.toHaveBeenCalled();
  });
```

Append a new `describe` block for pencil commit:

```ts
describe('pencilTool commit', () => {
  it('calls commitAndRevert with the new pencil id on pointer-up', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    // Manually seed a second point so the >=2 commit guard passes.
    ctx.pencilDraft.current!.points.push({ realMs: 1_700_000_000_001, price: 70_010 });
    pencilTool.onPointerUp!(ctx);
    expect(ctx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.commitAndRevert).toHaveBeenCalledWith(addedId);
  });

  it('does NOT call commitAndRevert when the pencil has fewer than 2 points', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    pencilTool.onPointerUp!(ctx); // only 1 point in draft
    expect(ctx.commitAndRevert).not.toHaveBeenCalled();
  });
});
```

Append to the existing `describe('eraserTool', ...)` block:

```ts
  it('never calls commitAndRevert (continuous-erase flow)', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5 };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.commitAndRevert).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`

Expected: 2 new trendline failures + 1 new pencil failure on the "calls commitAndRevert" assertions. The "does NOT call" assertions and the eraser exclusion pass already (those tools don't call the helper yet).

- [ ] **Step 2.3: Wire `trendlineTool.onPointerUp` to call `commitAndRevert`**

In `frontend/src/chart/drawing/tools.ts`, replace the body of `trendlineTool.onPointerUp`:

```ts
  onPointerUp(ctx) {
    const draft = ctx.trendlineDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const data = ctx.pixelToData(ctx.px, ctx.py);
    ctx.trendlineDraft.current = null;
    ctx.releasePointer();
    if (!data) return;
    // Reject zero-length trendlines (click without drag).
    if (data.realMs === draft.a.realMs && data.price === draft.a.price) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'trendline',
      a: draft.a,
      b: data,
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
    });
    ctx.commitAndRevert(id);
  },
```

- [ ] **Step 2.4: Wire `pencilTool.onPointerUp` to call `commitAndRevert`**

In `frontend/src/chart/drawing/tools.ts`, replace the body of `pencilTool.onPointerUp`:

```ts
  onPointerUp(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    ctx.pencilDraft.current = null;
    ctx.releasePointer();
    if (draft.points.length < 2) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'pencil',
      points: draft.points,
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
    });
    ctx.commitAndRevert(id);
  },
```

- [ ] **Step 2.5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`

Expected: all tests pass (full file).

- [ ] **Step 2.6: Commit**

```bash
git add frontend/src/chart/drawing/tools.ts frontend/src/chart/drawing/tools.test.ts
git commit -m "feat(drawing): trendline + pencil auto-revert to select after commit"
```

---

## Task 3: Implement `commitAndRevert` in `DrawingOverlay.buildCtx`

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

There is no direct unit test for `DrawingOverlay`'s buildCtx — it's the glue layer between `ToolCtx` and the Zustand store. Verification is by TypeScript compile (the `ToolCtx` interface now requires `commitAndRevert`, so the omission becomes a build error) plus manual verification at the end of the plan.

- [ ] **Step 3.1: Run `tsc` to verify the missing field is flagged**

Run: `cd frontend && npx tsc --noEmit`

Expected: error TS2741 — `Property 'commitAndRevert' is missing in type '{ ... }' but required in type 'ToolCtx'`. This is the failing-build equivalent of a failing test.

- [ ] **Step 3.2: Add `commitAndRevert` to `buildCtx`**

In `frontend/src/chart/DrawingOverlay.tsx`, locate the `buildCtx` function (currently around line 195). Add the helper alongside the other store actions, between `setSelected` and the closing `};`:

```ts
      add: (d) => useDrawingsStore.getState().add(d),
      update: (id, patch) => useDrawingsStore.getState().update(id, patch),
      remove: (id) => useDrawingsStore.getState().remove(id),
      setSelected: (id) => useDrawingsStore.getState().setSelected(id),
      commitAndRevert: (id) => {
        const s = useDrawingsStore.getState();
        s.setSelected(id);
        s.setActiveTool('select');
      },
    };
  };
```

- [ ] **Step 3.3: Run `tsc` to verify the type error is gone**

Run: `cd frontend && npx tsc --noEmit`

Expected: no errors related to `commitAndRevert` (other pre-existing project warnings, if any, are out of scope).

- [ ] **Step 3.4: Run the full drawing test suite**

Run: `cd frontend && npx vitest run src/chart/drawing/`

Expected: all tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "feat(drawing): wire commitAndRevert in DrawingOverlay.buildCtx"
```

---

## Task 4: Add `shortcut` field on `DrawingToolSpec` + `matchShortcut` helper

**Files:**
- Modify: `frontend/src/chart/drawing/tools.ts`
- Modify: `frontend/src/chart/drawing/tools.test.ts`

- [ ] **Step 4.1: Add failing tests for `matchShortcut`**

In `frontend/src/chart/drawing/tools.test.ts`, change the import line to add `matchShortcut`:

```ts
import {
  TOOLS,
  DRAWABLE_TOOLS_ORDER,
  hlineTool,
  eraserTool,
  pencilTool,
  selectTool,
  trendlineTool,
  matchShortcut,
  type ToolCtx,
} from './tools';
```

Append a new `describe` block at the end of the file:

```ts
describe('matchShortcut', () => {
  function key(opts: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: 'h',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...opts,
    } as KeyboardEvent;
  }

  it('matches Alt+H → hline', () => {
    expect(matchShortcut(key({ key: 'h', altKey: true }))).toBe('hline');
  });

  it('matches Alt+T → trendline', () => {
    expect(matchShortcut(key({ key: 't', altKey: true }))).toBe('trendline');
  });

  it('matches Alt+P → pencil', () => {
    expect(matchShortcut(key({ key: 'p', altKey: true }))).toBe('pencil');
  });

  it('matches Alt+E → eraser', () => {
    expect(matchShortcut(key({ key: 'e', altKey: true }))).toBe('eraser');
  });

  it('matches Alt+V → select', () => {
    expect(matchShortcut(key({ key: 'v', altKey: true }))).toBe('select');
  });

  it('is case-insensitive (Alt+Shift+H still matches)', () => {
    expect(matchShortcut(key({ key: 'H', altKey: true, shiftKey: true }))).toBe('hline');
  });

  it('returns null without Alt modifier', () => {
    expect(matchShortcut(key({ key: 'h', altKey: false }))).toBeNull();
  });

  it('returns null with Ctrl modifier (avoid clobbering browser shortcuts)', () => {
    expect(matchShortcut(key({ key: 'h', altKey: true, ctrlKey: true }))).toBeNull();
  });

  it('returns null with Meta modifier', () => {
    expect(matchShortcut(key({ key: 'h', altKey: true, metaKey: true }))).toBeNull();
  });

  it('returns null for unbound keys', () => {
    expect(matchShortcut(key({ key: 'q', altKey: true }))).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`

Expected: import error — `Module './tools' has no exported member 'matchShortcut'`.

- [ ] **Step 4.3: Add the `shortcut` field to `DrawingToolSpec` and declare per-tool shortcuts**

In `frontend/src/chart/drawing/tools.ts`, modify the `DrawingToolSpec` interface:

```ts
export interface DrawingToolSpec {
  kind: DrawingTool;
  /** Korean menu label rendered in DrawingMenu. */
  label: string;
  /** Single-char glyph rendered in the toolbar button and menu. */
  glyph: string;
  /** CSS cursor when this tool is active. Unused by v1 overlay (the
   *  overlay's pointer-events gating already differentiates), kept on
   *  the spec for future styling. */
  cursor: string;
  /** Optional keyboard shortcut (Alt + key). DrawingOverlay's keydown
   *  effect iterates TOOLS to dispatch. `key` is lowercase ASCII. */
  shortcut?: { alt: true; key: string };
  onPointerDown?(ctx: ToolCtx): void;
  onPointerMove?(ctx: ToolCtx): void;
  onPointerUp?(ctx: ToolCtx): void;
}
```

Add `shortcut` to each of the five tool specs. For each spec, insert the line between `cursor:` and the first `onPointerXxx:`:

```ts
// In selectTool:
  cursor: 'default',
  shortcut: { alt: true, key: 'v' },
  onPointerDown(ctx) {

// In hlineTool:
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'h' },
  onPointerDown(ctx) {

// In trendlineTool:
  cursor: 'crosshair',
  shortcut: { alt: true, key: 't' },
  onPointerDown(ctx) {

// In pencilTool:
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'p' },
  onPointerDown(ctx) {

// In eraserTool:
  cursor: 'not-allowed',
  shortcut: { alt: true, key: 'e' },
  onPointerDown(ctx) {
```

- [ ] **Step 4.4: Add the `matchShortcut` helper at the end of `tools.ts`**

Append at the end of `frontend/src/chart/drawing/tools.ts` (after the `DRAWABLE_TOOLS_ORDER` constant):

```ts
/**
 * Match a keyboard event against the `shortcut` field of every tool in
 * the registry. Returns the tool kind to activate, or null if no spec
 * matches or a non-Alt modifier is also held (Ctrl/Meta combos are
 * reserved for the browser/OS — we don't want to clobber Ctrl+H "history"
 * or Cmd+T "new tab"). Shift is allowed because the user may have
 * Caps-Lock on or hold Shift incidentally; key matching is
 * case-insensitive.
 */
export function matchShortcut(e: KeyboardEvent): DrawingTool | null {
  if (!e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return null;
  const k = e.key.toLowerCase();
  for (const spec of Object.values(TOOLS)) {
    if (spec.shortcut && spec.shortcut.key === k) return spec.kind;
  }
  return null;
}
```

- [ ] **Step 4.5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`

Expected: all `matchShortcut` tests pass (10/10), plus all earlier tests still pass.

- [ ] **Step 4.6: Commit**

```bash
git add frontend/src/chart/drawing/tools.ts frontend/src/chart/drawing/tools.test.ts
git commit -m "feat(drawing): add shortcut field on DrawingToolSpec + matchShortcut helper"
```

---

## Task 5: Wire shortcut dispatch into `DrawingOverlay` keydown effect (with active-gesture guard)

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

The shortcut dispatch lives next to the existing `Esc`/`Delete` handler. The active-gesture guard reads the three draft refs already owned by the overlay (`dragRef`, `trendlineDraft`, `pencilDraft`); if any is non-null, all keyboard shortcuts (including the new `Alt+` ones AND the existing `Esc`/`Delete`) are suppressed to avoid stranding in-flight state.

There is no per-handler unit test in this repo for the overlay's keydown — the wiring is exercised by manual verification (Task 7). The `matchShortcut` helper is the unit-tested seam.

- [ ] **Step 5.1: Update the import block in `DrawingOverlay.tsx`**

In `frontend/src/chart/DrawingOverlay.tsx`, change the existing `import { TOOLS, ... } from './drawing/tools'` line to also pull in `matchShortcut`:

```ts
import {
  TOOLS,
  matchShortcut,
  type DragMode,
  type PencilDraft,
  type ToolCtx,
  type TrendlineDraft,
} from './drawing/tools';
```

- [ ] **Step 5.2: Replace the existing keydown effect with the gesture-guarded version**

In `frontend/src/chart/DrawingOverlay.tsx`, replace the entire existing `// ── keyboard shortcuts ──` effect (the `useEffect(() => { const onKey = ... }, [])` block) with:

```ts
  // ── keyboard shortcuts ─────────────────────────────────────────────────
  // All keyboard shortcuts (tool switch via Alt+letter, Esc revert,
  // Delete/Backspace remove) are suppressed while a pointer gesture is
  // in flight — switching activeTool mid-drag would route the upcoming
  // pointer-up to a different spec, stranding the draft refs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // Active-gesture guard — see ADR-0024 sibling note in the spec.
      if (dragRef.current || trendlineDraft.current || pencilDraft.current) return;

      const shortcutKind = matchShortcut(e);
      if (shortcutKind) {
        useDrawingsStore.getState().setActiveTool(shortcutKind);
        e.preventDefault();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = useDrawingsStore.getState().selectedId;
        if (id) {
          useDrawingsStore.getState().remove(id);
          e.preventDefault();
        }
      } else if (e.key === 'Escape') {
        useDrawingsStore.getState().setSelected(null);
        useDrawingsStore.getState().setActiveTool('select');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
```

- [ ] **Step 5.3: Run the full drawing test suite**

Run: `cd frontend && npx vitest run src/chart/drawing/`

Expected: all tests pass. The overlay change is type-checked but not unit-tested in isolation.

- [ ] **Step 5.4: Run `tsc` to verify no type errors**

Run: `cd frontend && npx tsc --noEmit`

Expected: no new errors.

- [ ] **Step 5.5: Commit**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "feat(drawing): dispatch Alt+ shortcuts with active-gesture guard"
```

---

## Task 6: Render hline price badge on the canvas

**Files:**
- Create: `frontend/src/chart/drawing/render.test.ts`
- Modify: `frontend/src/chart/drawing/render.ts`

- [ ] **Step 6.1: Create the failing test file**

Create `frontend/src/chart/drawing/render.test.ts` with this exact content:

```ts
// frontend/src/chart/drawing/render.test.ts
//
// Direct unit tests for canvas rendering of Drawings. We stub
// CanvasRenderingContext2D as a vi-spy bag so we can assert on the
// shape of the draw calls without running in a browser.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { renderDrawing, type ProjectCtx } from './render';
import type { Hline } from './types';

/** Build a context with all the canvas methods we touch spied. */
function makeCanvasSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '' as CanvasLineCap,
    lineJoin: '' as CanvasLineJoin,
    font: '',
    textBaseline: '' as CanvasTextBaseline,
    textAlign: '' as CanvasTextAlign,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D & {
    fillText: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
  };
}

/** A ProjectCtx whose priceSeries always projects price → y=200. */
function makeProjectCtx(): ProjectCtx {
  return {
    chart: {} as IChartApi,
    axis: {} as ProjectCtx['axis'],
    priceSeries: {
      priceToCoordinate: vi.fn(() => 200),
    } as unknown as ProjectCtx['priceSeries'],
    width: 800,
    height: 400,
  };
}

describe('renderHline price badge', () => {
  it('paints the price formatted as ko-KR with thousand separators', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = {
      id: 'h1',
      kind: 'hline',
      price: 74_500,
      color: '#14B8A6',
      width: 1.5,
    };
    renderDrawing(c, ctx, h, false);
    const calls = (c.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const labels = calls.map((args) => args[0] as string);
    expect(labels).toContain('74,500');
  });

  it('positions the badge near the right edge (within 100px inset)', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5 };
    renderDrawing(c, ctx, h, false);
    const fillRectCalls = (c.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(fillRectCalls.length).toBeGreaterThan(0);
    // Take the last fillRect call (the badge background) and assert its x is
    // close to the right edge.
    const [x] = fillRectCalls[fillRectCalls.length - 1] as [number, number, number, number];
    expect(x).toBeGreaterThan(ctx.width - 100);
    expect(x).toBeLessThan(ctx.width);
  });

  it('does not paint a badge when the price scale is unavailable (y == null)', () => {
    const c = makeCanvasSpy();
    const ctx: ProjectCtx = {
      ...makeProjectCtx(),
      priceSeries: {
        priceToCoordinate: vi.fn(() => null),
      } as unknown as ProjectCtx['priceSeries'],
    };
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5 };
    renderDrawing(c, ctx, h, false);
    expect((c.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 6.2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/chart/drawing/render.test.ts`

Expected: all three tests FAIL — `fillText` is never called by the current `renderHline` (only `stroke`).

- [ ] **Step 6.3: Add the `drawPriceBadge` helper + extend `renderHline`**

In `frontend/src/chart/drawing/render.ts`, modify the file in two places.

First, add the private helper above `renderHline` (so it's hoisted before use):

```ts
const BADGE_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
const BADGE_PAD_X = 4;
const BADGE_PAD_Y = 2;
const BADGE_INSET_RIGHT = 8;

/** W3C relative luminance of an `#RRGGBB` colour, range [0, 1]. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function drawPriceBadge(
  c: CanvasRenderingContext2D,
  canvasWidth: number,
  y: number,
  price: number,
  bgColor: string,
  selected: boolean,
) {
  const text = price.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  c.save();
  c.font = BADGE_FONT;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const textWidth = c.measureText(text).width;
  const w = textWidth + BADGE_PAD_X * 2;
  const h = 11 + BADGE_PAD_Y * 2;
  const x = canvasWidth - BADGE_INSET_RIGHT - w;
  const top = y - h / 2;
  c.fillStyle = bgColor;
  c.fillRect(x, top, w, h);
  if (selected) {
    c.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    c.lineWidth = 1;
    c.beginPath();
    c.rect(x + 0.5, top + 0.5, w - 1, h - 1);
    c.stroke();
  }
  c.fillStyle = luminance(bgColor) < 0.5 ? '#FFFFFF' : '#000000';
  c.fillText(text, x + BADGE_PAD_X, y);
  c.restore();
}
```

Second, extend `renderHline` to call the helper after stroking the line:

```ts
function renderHline(c: CanvasRenderingContext2D, ctx: ProjectCtx, h: Hline, selected: boolean) {
  const y = priceToY(ctx, h.price);
  if (y == null) return;
  drawHaloThenMain(c, h, selected, () => {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(ctx.width, y);
    c.stroke();
  });
  drawPriceBadge(c, ctx.width, y, h.price, h.color, selected);
}
```

- [ ] **Step 6.4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/chart/drawing/render.test.ts`

Expected: all three tests pass.

- [ ] **Step 6.5: Run the full drawing test suite to verify no regressions**

Run: `cd frontend && npx vitest run src/chart/drawing/`

Expected: all tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add frontend/src/chart/drawing/render.ts frontend/src/chart/drawing/render.test.ts
git commit -m "feat(drawing): paint price badge at right edge of hline"
```

---

## Task 7: Manual verification (HMR browser test)

The dev server's HMR reloads the chart in place, so all changes can be verified live without restarting.

- [ ] **Step 7.1: Confirm dev servers are running**

If not already running, start the dev servers (see `CLAUDE.md`):

Backend:
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

Frontend:
```bash
cd frontend && npm run dev
```

Open `http://localhost:5173/replay` in a browser.

- [ ] **Step 7.2: Verify price badge on hline**

1. Open or create a Replay Tab on any **Code**.
2. Click the drawing-menu button in the toolbar; select 수평선 (hline).
3. Click anywhere on the chart at a clear price level.
4. **Expected:** a horizontal line is drawn AND a coloured badge with the price (e.g. `74,500`) sits flush against the right edge of the chart canvas, vertically centred on the line.
5. Pan/zoom the chart; the badge stays glued to the line and stays at the right edge.

- [ ] **Step 7.3: Verify auto-revert to select after commit**

1. With hline still selected as the active tool, draw another line.
2. **Expected:** the drawing-menu toolbar button immediately reverts to the default ✏ glyph (select mode), and the newly-drawn line is in the selected state (thicker / halo'd).
3. Repeat for trendline (drag two points) and pencil (drag a stroke). Each should auto-revert and leave the new drawing selected.
4. Erase mode: pick the eraser, click a drawing — confirm eraser stays active so you can erase another. (No auto-revert for eraser is correct.)

- [ ] **Step 7.4: Verify keyboard shortcuts**

1. From select mode, press `Alt+H`. Expected: toolbar button switches to hline glyph.
2. Press `Alt+T` → trendline. `Alt+P` → pencil. `Alt+E` → eraser. `Alt+V` → back to select.
3. Click into a form input (if any reachable from `/replay`), press `Alt+H` — expected: NO tool switch (input guard).
4. Start dragging a trendline (mouse-down, hold), then press `Alt+H` mid-drag. Expected: tool does NOT switch; releasing the mouse correctly commits the trendline and reverts to select.

- [ ] **Step 7.5: Verify shortcut + auto-revert together**

1. Press `Alt+H`, click to draw an hline. Expected: line drawn with badge, auto-reverts to select, hline selected.
2. Press `Delete`. Expected: hline removed.
3. Press `Esc` from any state. Expected: selection cleared, select mode active.

- [ ] **Step 7.6: If any verification step fails, return to the relevant earlier task and fix**

Common failure modes:
- Badge text colour unreadable on certain backgrounds → re-check luminance threshold or the `BADGE_FONT` rendering.
- Shortcut fires while in input field → re-check INPUT/TEXTAREA/contentEditable guard.
- Auto-revert leaves the wrong drawing selected → re-check `commitAndRevert` is called with the freshly-minted `id`, not a stale value.

- [ ] **Step 7.7: Final commit (if any tweaks were needed in 7.6)**

If no tweaks: this task has no commit. If tweaks: commit them with descriptive message.

---

## Self-Review (run after writing all tasks)

**Spec coverage check** (each spec section → task):
- §A Price label on hline → Task 6
- §B Auto-revert → Tasks 1, 2, 3
- §C Keyboard shortcuts (incl. active-gesture guard) → Tasks 4, 5
- Tests (tools.test.ts + render.test.ts) → covered inline per task
- Touched files list → all four files modified across Tasks 1–6

**Placeholder scan:** no TBDs, no "implement appropriately", every step shows code or exact command + expected output.

**Type consistency:** `commitAndRevert(id: string): void` is the signature in Task 1 (ToolCtx), Task 3 (overlay impl), and the test calls in Tasks 1–2. `matchShortcut(e: KeyboardEvent): DrawingTool | null` matches across Task 4 (impl + tests) and Task 5 (import).

**Spec gap check:** spec §A mentions a 1px outline `#FFFFFF @0.4 alpha` for the selected-state badge — implemented in Task 6 Step 6.3 `if (selected) { ... }` block. No gap.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-24-drawing-ux-improvements.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
