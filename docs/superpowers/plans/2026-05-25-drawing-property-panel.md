# Drawing Property Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a floating per-Drawing property panel (color, stroke width, line style, delete) for the Replay Viewer, with sticky defaults persisted per user. Reverses ADR-0030's "post-commit clears selection" so a freshly-drawn shape becomes the panel's target.

**Architecture:** Add `lineStyle` field to `DrawingBase` (additive, legacy hydration → `'solid'`). Add a `defaults` slice to `useDrawingsStore` synced to a new global localStorage key. Restore `revertToSelectMode(newId)` so post-commit `selectedId = newId`. Render a new sibling component `DrawingPropertyPanel.tsx` in `ChartStage`, gated by `activeTool === 'select' && selectedId != null`, that reads the selected Drawing from the store and writes back via `update + setDefaults`. Tool constructors read defaults instead of hardcoded `accentColor` + `1.5px`.

**Tech Stack:** TypeScript, React, Zustand (`useDrawingsStore`), `lightweight-charts`, Vitest + Testing Library. No new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-25-drawing-property-panel-design.md](../specs/2026-05-25-drawing-property-panel-design.md)
**Supersedes (partial):** [docs/adr/0030-drawing-commit-clears-selection.md](../../adr/0030-drawing-commit-clears-selection.md)
**Glossary:** [CONTEXT.md](../../../CONTEXT.md) — Drawing Property Panel, Drawing Defaults (already added)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/chart/drawing/types.ts` | Modify | Add `LineStyle`, `COLOR_PALETTE`, `STROKE_WIDTHS`, `LINE_STYLES`, `DrawingDefaults`, `INITIAL_DEFAULTS`. Add `lineStyle: LineStyle` to `DrawingBase`. |
| `frontend/src/chart/drawing/persistence.ts` | Modify | Default `lineStyle: 'solid'` in `loadDrawings` for legacy items. New `loadDefaults` / `saveDefaults` for `replay.drawingDefaults.v1`. |
| `frontend/src/chart/drawing/persistence.test.ts` | Modify | Cases for `lineStyle` defaulting, defaults load/save round-trip, absent-key fallback. |
| `frontend/src/state/drawings.ts` | Modify | Add `defaults` slice + `setDefaults` action. Defaults loaded at store init, debounced-persisted on change. `update(id, patch)` auto-syncs `setDefaults`. |
| `frontend/src/state/drawings.test.ts` | Modify | Defaults init from disk, persist on change, `update` syncs defaults. |
| `frontend/src/chart/drawing/tools.ts` | Modify | `ToolCtx` drops `accentColor`, gains `defaults: DrawingDefaults`. `revertToSelectMode(newId: DrawingId)` sets `selectedId = newId` (no longer null). `hlineTool`/`trendlineTool`/`pencilTool` build new drawings from `defaults`. |
| `frontend/src/chart/drawing/tools.test.ts` | Modify | Mock `defaults` instead of `accentColor`; assert new drawings inherit from `defaults`; assert `revertToSelectMode` called with added id. |
| `frontend/src/chart/DrawingOverlay.tsx` | Modify | Drop `accentColor` resolution; pull `defaults` from store; `revertToSelectMode` closure passes added id. |
| `frontend/src/chart/drawing/render.ts` | Modify | `setStroke` adds `setLineDash(dashPattern(d.lineStyle, d.width))` + lineCap switch for `'dotted'`. Export `dashPattern`. |
| `frontend/src/chart/drawing/render.test.ts` | Modify | Cases for solid/dashed/dotted patterns and lineCap. |
| `frontend/src/chart/DrawingPropertyPanel.tsx` | **Create** | New floating panel; gated render; popovers (color/thickness/line-style); drag; delete. |
| `frontend/src/chart/DrawingPropertyPanel.test.tsx` | **Create** | Render gate; each popover open/close (trigger, outside click, Escape); property edits dispatch `update + setDefaults`; delete dispatches `remove`; drag updates local position. |
| `frontend/src/chart/ChartStage.tsx` | Modify | Mount `<DrawingPropertyPanel />` as a sibling of `<DrawingOverlay />`. |
| `docs/adr/0032-drawing-property-panel.md` | **Create** | New ADR — supersedes ADR-0030 (post-commit only); empty-click-deselects preserved. |
| `docs/adr/0030-drawing-commit-clears-selection.md` | Modify | Status header → "superseded in part by ADR-0032 (post-commit revert; empty-click-deselects preserved)". |
| `CONTEXT.md` | Modify | Update **Drawing Tool** entry's post-commit paragraph to cite ADR-0032. (Drawing Property Panel + Drawing Defaults entries already added during grill.) |

---

## Task 1: Add `LineStyle`, palettes, and defaults type to `types.ts`

**Files:**
- Modify: `frontend/src/chart/drawing/types.ts`

The model side of the spec's "Domain model & types" section. No tests — types-only, validated by TypeScript at compile time and used by every subsequent task. Hex strings stay opaque `string` in the model (the UI restriction is enforced by the popover, not the type).

- [ ] **Step 1: Edit `types.ts` — add type aliases, constants, and `INITIAL_DEFAULTS`**

Append to `frontend/src/chart/drawing/types.ts` (after the existing `HIT_THRESHOLD` block):

```ts
export type LineStyle = 'solid' | 'dashed' | 'dotted';

export const STROKE_WIDTHS = [1, 2, 3, 4, 5] as const;
export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;

/**
 * Sixteen-colour palette for user-authored Drawings. A fourth "user
 * annotation layer" category alongside DESIGN.md's three system / status /
 * market-direction categories — distinct because annotations are user
 * content, not system chrome. See ADR-0032.
 */
export const COLOR_PALETTE = [
  '#14B8A6', '#10B981', '#F43F5E', '#F59E0B',
  '#EF4444', '#F97316', '#EAB308', '#84CC16',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899',
  '#FFFFFF', '#9CA3AF', '#4B5563', '#1F2937',
] as const;

export type DrawingDefaults = {
  color: string;
  width: number;
  lineStyle: LineStyle;
};

/** Seed used when no persisted defaults exist. Teal accent, integer-step
 *  2 px, solid. */
export const INITIAL_DEFAULTS: DrawingDefaults = {
  color: '#14B8A6',
  width: 2,
  lineStyle: 'solid',
};
```

- [ ] **Step 2: Add `lineStyle` to `DrawingBase`**

Edit the existing `interface DrawingBase` block in the same file to add a `lineStyle` field:

```ts
interface DrawingBase {
  id: DrawingId;
  color: string;
  width: number;
  lineStyle: LineStyle; // NEW
  paneId: PaneId;
}
```

Update the surrounding JSDoc to drop the "`v1 always references the accent token via util/tokens`" sentence on `color`, and the "`v1 fixed to 1.5`" sentence on `width` — both v1 constraints are gone with ADR-0032.

- [ ] **Step 3: Run typecheck — expect downstream failures**

Run: `cd frontend && npx tsc --noEmit`
Expected: errors in `tools.ts`, `persistence.ts`, `render.ts` test files about missing `lineStyle` on Drawing literals. **Do not fix here** — every downstream task fixes its own surface.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/drawing/types.ts
git commit -m "feat(drawing): add LineStyle, COLOR_PALETTE, STROKE_WIDTHS, DrawingDefaults (spec scaffolding)"
```

---

## Task 2: Persistence — legacy `lineStyle` hydration

**Files:**
- Modify: `frontend/src/chart/drawing/persistence.ts`
- Modify: `frontend/src/chart/drawing/persistence.test.ts`

Legacy items in `localStorage` lack `lineStyle`. The hydration map defaults to `'solid'`. No wrapper version bump — additive field on a `v: 1` payload.

- [ ] **Step 1: Add failing test for legacy hydration**

Edit `frontend/src/chart/drawing/persistence.test.ts`, add inside the existing `describe('loadDrawings', ...)` block:

```ts
it('defaults lineStyle to "solid" for legacy items missing the field', () => {
  const legacy = {
    v: 1,
    items: [
      { id: 'a', kind: 'hline', price: 1000, color: '#14B8A6', width: 1.5, paneId: 'candle' },
    ],
  };
  localStorage.setItem(storageKey('005930'), JSON.stringify(legacy));
  const loaded = loadDrawings('005930');
  expect(loaded).toHaveLength(1);
  expect(loaded[0].lineStyle).toBe('solid');
  expect(loaded[0].width).toBe(1.5); // preserved as-is
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts -t "defaults lineStyle"`
Expected: FAIL — `loaded[0].lineStyle` is `undefined`.

- [ ] **Step 3: Implement hydration default in `loadDrawings`**

Edit `frontend/src/chart/drawing/persistence.ts`'s map callback inside `loadDrawings`:

```ts
return (parsed.items as LegacyItem[]).map((item) => {
  const { paneIndex: _ignored, ...rest } = item;
  void _ignored;
  const lineStyle = (item as { lineStyle?: LineStyle }).lineStyle ?? 'solid';
  return { ...rest, paneId: resolvePaneId(item), lineStyle } as Drawing;
});
```

Add the `LineStyle` import at the top of the file alongside the existing `Drawing, PaneId` imports.

- [ ] **Step 4: Update `LegacyItem` type for safety**

Edit the `LegacyItem` declaration block:

```ts
type LegacyItem = Omit<Drawing, 'paneId' | 'lineStyle'> & {
  paneId?: PaneId;
  paneIndex?: number;
  lineStyle?: LineStyle;
};
```

- [ ] **Step 5: Run test — verify it passes**

Run: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/drawing/persistence.ts frontend/src/chart/drawing/persistence.test.ts
git commit -m "feat(drawing): hydrate legacy drawings with lineStyle='solid'"
```

---

## Task 3: Persistence — `loadDefaults` / `saveDefaults` helpers

**Files:**
- Modify: `frontend/src/chart/drawing/persistence.ts`
- Modify: `frontend/src/chart/drawing/persistence.test.ts`

Single-slot store, separate from per-Code drawings, keyed `replay.drawingDefaults.v1`. Symmetric to existing wrapper conventions.

- [ ] **Step 1: Add failing tests for round-trip + fallback**

Edit `frontend/src/chart/drawing/persistence.test.ts`, add a new `describe` block:

```ts
import { loadDefaults, saveDefaults, DEFAULTS_KEY } from './persistence';
import { INITIAL_DEFAULTS } from './types';

describe('drawing defaults persistence', () => {
  beforeEach(() => localStorage.clear());

  it('returns INITIAL_DEFAULTS when no key present', () => {
    expect(loadDefaults()).toEqual(INITIAL_DEFAULTS);
  });

  it('round-trips a written value', () => {
    const written = { color: '#F43F5E', width: 4, lineStyle: 'dashed' as const };
    saveDefaults(written);
    expect(loadDefaults()).toEqual(written);
  });

  it('returns INITIAL_DEFAULTS on JSON corruption', () => {
    localStorage.setItem(DEFAULTS_KEY, '{not valid json');
    expect(loadDefaults()).toEqual(INITIAL_DEFAULTS);
  });

  it('returns INITIAL_DEFAULTS when wrapper version mismatches', () => {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ v: 99, value: { color: '#000' } }));
    expect(loadDefaults()).toEqual(INITIAL_DEFAULTS);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail with import errors**

Run: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts -t "drawing defaults"`
Expected: FAIL — `loadDefaults` and `saveDefaults` not exported.

- [ ] **Step 3: Implement helpers in `persistence.ts`**

Append to `frontend/src/chart/drawing/persistence.ts`:

```ts
import { INITIAL_DEFAULTS, type DrawingDefaults } from './types';

export const DEFAULTS_KEY = 'replay.drawingDefaults.v1';
const DEFAULTS_VERSION = 1;

type DefaultsWrapper = { v: number; value: DrawingDefaults };

export function loadDefaults(): DrawingDefaults {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DEFAULTS_KEY);
  } catch {
    return INITIAL_DEFAULTS;
  }
  if (raw == null) return INITIAL_DEFAULTS;
  let parsed: DefaultsWrapper;
  try {
    parsed = JSON.parse(raw) as DefaultsWrapper;
  } catch {
    return INITIAL_DEFAULTS;
  }
  if (parsed == null || parsed.v !== DEFAULTS_VERSION) return INITIAL_DEFAULTS;
  return { ...INITIAL_DEFAULTS, ...parsed.value };
}

export function saveDefaults(d: DrawingDefaults): void {
  const wrapper: DefaultsWrapper = { v: DEFAULTS_VERSION, value: d };
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(wrapper));
  } catch {
    // Quota / storage unavailable — defaults stay in-memory; user simply
    // loses the cross-session sticky-ness on next reload.
  }
}
```

(Combine the existing `import type { Drawing, PaneId }` with the new `LineStyle` from Task 2; keep imports grouped.)

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts`
Expected: PASS (round-trip, JSON corruption, version mismatch, absent key all return INITIAL_DEFAULTS).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/drawing/persistence.ts frontend/src/chart/drawing/persistence.test.ts
git commit -m "feat(drawing): loadDefaults/saveDefaults for replay.drawingDefaults.v1"
```

---

## Task 4: Store — `defaults` slice + `setDefaults` action + auto-sync from `update`

**Files:**
- Modify: `frontend/src/state/drawings.ts`
- Modify: `frontend/src/state/drawings.test.ts`

The store gains a `defaults` slice loaded once at store creation, persisted on every `setDefaults` (debounced). `update(id, patch)` is amended to forward color/width/lineStyle changes into `setDefaults` so the next new Drawing inherits.

- [ ] **Step 1: Add failing tests**

Edit `frontend/src/state/drawings.test.ts`, add a new `describe` block:

```ts
import { INITIAL_DEFAULTS } from '../chart/drawing/types';
import { DEFAULTS_KEY, saveDefaults } from '../chart/drawing/persistence';

describe('useDrawingsStore — defaults', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawingsStore.getState().__resetForTests();
  });

  it('exposes INITIAL_DEFAULTS when no persisted defaults exist', () => {
    expect(useDrawingsStore.getState().defaults).toEqual(INITIAL_DEFAULTS);
  });

  it('setDefaults patches and persists', () => {
    useDrawingsStore.getState().setDefaults({ color: '#F43F5E' });
    expect(useDrawingsStore.getState().defaults.color).toBe('#F43F5E');
    useDrawingsStore.getState().flushPending();
    const raw = JSON.parse(localStorage.getItem(DEFAULTS_KEY)!);
    expect(raw.value.color).toBe('#F43F5E');
  });

  it('update(id, patch) syncs color/width/lineStyle into defaults', () => {
    const s = useDrawingsStore.getState();
    s.setActiveCode('005930');
    const d: Drawing = {
      id: 'a', kind: 'hline', price: 1000,
      color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    };
    s.add(d);
    s.update('a', { color: '#10B981', width: 3, lineStyle: 'dashed' });
    expect(useDrawingsStore.getState().defaults).toEqual({
      color: '#10B981', width: 3, lineStyle: 'dashed',
    });
  });

  it('update with no style fields does not touch defaults', () => {
    const s = useDrawingsStore.getState();
    s.setActiveCode('005930');
    s.add({ id: 'a', kind: 'hline', price: 1000,
            color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle' });
    const before = { ...useDrawingsStore.getState().defaults };
    s.update('a', { price: 1500 });
    expect(useDrawingsStore.getState().defaults).toEqual(before);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/state/drawings.test.ts -t "defaults"`
Expected: FAIL — `defaults` and `setDefaults` not on state.

- [ ] **Step 3: Implement defaults slice in store**

Edit `frontend/src/state/drawings.ts`. At the top, import:

```ts
import {
  loadDrawings, saveDrawings,
  loadDefaults, saveDefaults,
} from '../chart/drawing/persistence';
import { INITIAL_DEFAULTS, type DrawingDefaults } from '../chart/drawing/types';
```

Extend `State` and `Actions`:

```ts
type State = {
  // ...existing
  defaults: DrawingDefaults;
};

type Actions = {
  // ...existing
  setDefaults(patch: Partial<DrawingDefaults>): void;
};
```

Add a module-level debounce timer parallel to the existing `pendingTimer`:

```ts
let defaultsTimer: ReturnType<typeof setTimeout> | null = null;
```

Inside the `create` callback, define a helper at the same scope as `queuePersist`:

```ts
const queuePersistDefaults = () => {
  if (defaultsTimer != null) clearTimeout(defaultsTimer);
  defaultsTimer = setTimeout(() => {
    saveDefaults(get().defaults);
    defaultsTimer = null;
  }, PERSIST_DEBOUNCE_MS);
};
```

Initialise `defaults` from disk and wire actions:

```ts
return {
  // ...existing
  defaults: loadDefaults(),

  setDefaults(patch) {
    set({ defaults: { ...get().defaults, ...patch } });
    queuePersistDefaults();
  },
  // ...
};
```

In the existing `update(id, patch)` body, after persisting the per-code drawings, sync defaults:

```ts
update(id, patch) {
  const code = get().activeCode;
  if (code == null) return;
  const current = get().byCode.get(code) ?? [];
  const next = current.map((d) => (d.id === id ? ({ ...d, ...patch } as Drawing) : d));
  const byCode = new Map(get().byCode);
  byCode.set(code, next);
  set({ byCode });
  queuePersist(code);

  // Drawing Defaults sync — only style fields propagate.
  const stylePatch: Partial<DrawingDefaults> = {};
  if ('color' in patch && typeof patch.color === 'string') stylePatch.color = patch.color;
  if ('width' in patch && typeof patch.width === 'number') stylePatch.width = patch.width;
  if ('lineStyle' in patch && patch.lineStyle != null) stylePatch.lineStyle = patch.lineStyle;
  if (Object.keys(stylePatch).length > 0) get().setDefaults(stylePatch);
},
```

In `__resetForTests`, clear the defaults timer and re-seed from `INITIAL_DEFAULTS` so each test starts identical:

```ts
__resetForTests() {
  if (pendingTimer != null) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (defaultsTimer != null) { clearTimeout(defaultsTimer); defaultsTimer = null; }
  pendingCode = null;
  set({
    byCode: new Map(),
    loadedCodes: new Set(),
    activeCode: null,
    activeTool: 'select',
    selectedId: null,
    defaults: INITIAL_DEFAULTS,
  });
},
```

Extend `flushPending` to flush defaults too (so the persistence test can assert without waiting):

```ts
flushPending() {
  if (pendingTimer != null) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (pendingCode != null) saveDrawings(pendingCode, get().byCode.get(pendingCode) ?? []);
  pendingCode = null;
  if (defaultsTimer != null) {
    clearTimeout(defaultsTimer); defaultsTimer = null;
    saveDefaults(get().defaults);
  }
},
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/state/drawings.test.ts`
Expected: PASS (all existing + 4 new defaults cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/drawings.ts frontend/src/state/drawings.test.ts
git commit -m "feat(drawing): Drawing Defaults slice on useDrawingsStore; update() auto-syncs"
```

---

## Task 5: Tools — `revertToSelectMode(newId)`, ToolCtx defaults, constructors

**Files:**
- Modify: `frontend/src/chart/drawing/tools.ts`
- Modify: `frontend/src/chart/drawing/tools.test.ts`

This is the ADR-0030 partial reversal at the tools layer. `revertToSelectMode` regains the `newId` argument; it switches the active tool to `select` and **sets** `selectedId` to the new drawing's id. `ToolCtx` drops `accentColor` and gains `defaults`; the three tool constructors read from `defaults` instead of `accentColor` + the local `DRAWING_WIDTH` const.

- [ ] **Step 1: Update failing tests in `tools.test.ts`**

Edit `frontend/src/chart/drawing/tools.test.ts`'s `makeCtx` helper — replace `accentColor: '#14B8A6'` with:

```ts
defaults: { color: '#14B8A6', width: 2, lineStyle: 'solid' as const },
revertToSelectMode: vi.fn(),
```

Then update the three "calls revertToSelectMode after add" tests (hline, trendline, pencil) to also assert the call carries the new drawing's id:

```ts
// hline
it('calls revertToSelectMode with the new drawing id after add', () => {
  const ctx = makeCtx();
  hlineTool.onPointerDown!(ctx);
  expect(ctx.revertToSelectMode).toHaveBeenCalledOnce();
  const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
  expect(ctx.revertToSelectMode).toHaveBeenCalledWith(addedId);
});
```

Apply the same shape to the trendline and pencil counterparts.

Add a new test that asserts new drawings inherit from `defaults`:

```ts
it('new hline inherits color/width/lineStyle from ctx.defaults', () => {
  const ctx = makeCtx();
  ctx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed' };
  hlineTool.onPointerDown!(ctx);
  const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
  expect(added.color).toBe('#F43F5E');
  expect(added.width).toBe(3);
  expect(added.lineStyle).toBe('dashed');
});
```

Copy that test for trendline (drive a click + drag, then pointer-up — see existing patterns at lines ~140) and pencil (push two points then pointer-up).

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`
Expected: FAIL — `ctx.defaults` doesn't exist on ToolCtx; constructors use `accentColor`.

- [ ] **Step 3: Update `ToolCtx` and constructors**

Edit `frontend/src/chart/drawing/tools.ts`:

Replace the `accentColor: string` field in `ToolCtx` with:

```ts
/** The user's sticky drawing defaults. Tool constructors read these
 *  to seed color / width / lineStyle on new Drawings. See ADR-0032. */
defaults: import('./types').DrawingDefaults;
```

(Or, cleaner: add `DrawingDefaults` to the existing top-level imports and write `defaults: DrawingDefaults` directly.)

Change `revertToSelectMode` signature and JSDoc:

```ts
/** Returns the overlay to select mode with the just-added drawing selected,
 *  so the property panel attaches to the new shape. See ADR-0032 (supersedes
 *  ADR-0030's "clears selection" semantic). */
revertToSelectMode(newId: string): void;
```

Delete the `const DRAWING_WIDTH = 1.5;` line.

Edit the three tool constructors. `hlineTool.onPointerDown`:

```ts
const id = nanoid(8);
ctx.add({
  id,
  kind: 'hline',
  price: data.price,
  color: ctx.defaults.color,
  width: ctx.defaults.width,
  lineStyle: ctx.defaults.lineStyle,
  paneId,
});
ctx.revertToSelectMode(id);
```

`trendlineTool.onPointerUp` (in the commit branch):

```ts
const id = nanoid(8);
ctx.add({
  id,
  kind: 'trendline',
  a: draft.a,
  b: data,
  color: ctx.defaults.color,
  width: ctx.defaults.width,
  lineStyle: ctx.defaults.lineStyle,
  paneId: draft.paneId,
});
ctx.revertToSelectMode(id);
```

`pencilTool.onPointerUp`:

```ts
const id = nanoid(8);
ctx.add({
  id,
  kind: 'pencil',
  points: draft.points,
  color: ctx.defaults.color,
  width: ctx.defaults.width,
  lineStyle: ctx.defaults.lineStyle,
  paneId: draft.paneId,
});
ctx.revertToSelectMode(id);
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`
Expected: PASS — all three tools call `revertToSelectMode(addedId)` and inherit from `ctx.defaults`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/drawing/tools.ts frontend/src/chart/drawing/tools.test.ts
git commit -m "feat(drawing): tools read defaults; revertToSelectMode(newId) restores selection (ADR-0032)"
```

---

## Task 6: DrawingOverlay — wire defaults and new helper signature

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

The overlay was the source of `accentColor` and the `revertToSelectMode` closure. Both change: pull `defaults` from the store, and have `revertToSelectMode(newId)` set `selectedId` to `newId` rather than clear it.

- [ ] **Step 1: Remove accent resolution; add defaults read**

Edit `frontend/src/chart/DrawingOverlay.tsx`. Delete the line resolving `accentColor` (around line 76):

```ts
// REMOVE
const accentColor = useMemo(() => resolveTokens(TOKEN_SPEC).accent, []);
```

If `resolveTokens` / `TOKEN_SPEC` are no longer used in this file after removal, also remove their imports.

Add a defaults subscription right where store hooks are read:

```ts
const defaults = useDrawingsStore((s) => s.defaults);
```

- [ ] **Step 2: Update `revertToSelectMode` closure**

Find the closure that powers `ToolCtx.revertToSelectMode` and the `Escape` handler (around line 164 + 186 + 288 per spec layout). The current implementation clears selection; reverse it:

```ts
const revertToSelectMode = useCallback((newId: string) => {
  useDrawingsStore.getState().setActiveTool('select');
  useDrawingsStore.getState().setSelected(newId);
}, []);
```

Update the `ToolCtx` build site (line ~288) to pass this helper (the call site changes from `revertToSelectMode()` to `revertToSelectMode` — but since the prop name is the function itself, no wiring change needed beyond the signature).

The `Escape` keyboard handler (a separate code path in the same file — search for `'Escape'`) must keep calling the *clear-selection* path explicitly, since Escape's semantics are unchanged:

```ts
if (e.key === 'Escape') {
  useDrawingsStore.getState().setSelected(null);
  useDrawingsStore.getState().setActiveTool('select');
  // ...existing draft-ref cleanup
}
```

- [ ] **Step 3: Pass `defaults` into ToolCtx build**

In the ToolCtx build site (around line 288 per the imports search), replace:

```ts
accentColor,
```

with:

```ts
defaults,
```

Update the effect dependency array at line 186 — drop `accentColor`, add `defaults`.

- [ ] **Step 4: Typecheck + run any DrawingOverlay tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/chart`
Expected: PASS — no TypeScript errors; existing DrawingOverlay tests (if any) still green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "feat(drawing): DrawingOverlay wires defaults + selection-preserving revert"
```

---

## Task 7: Rendering — `dashPattern` and lineStyle in `setStroke`

**Files:**
- Modify: `frontend/src/chart/drawing/render.ts`
- Modify: `frontend/src/chart/drawing/render.test.ts`

Canvas dash + lineCap switch. Dotted is the round-cap + zero-length-dash trick.

- [ ] **Step 1: Add failing tests for dashPattern and setLineDash**

Edit `frontend/src/chart/drawing/render.test.ts`. Add a new `describe` block:

```ts
import { dashPattern } from './render';

describe('dashPattern', () => {
  it('returns [] for solid', () => {
    expect(dashPattern('solid', 2)).toEqual([]);
  });
  it('scales dashed with width', () => {
    expect(dashPattern('dashed', 2)).toEqual([6, 4]);
    expect(dashPattern('dashed', 3)).toEqual([9, 6]);
  });
  it('returns [0, width*2.5] for dotted (round-cap dots)', () => {
    expect(dashPattern('dotted', 2)).toEqual([0, 5]);
  });
});
```

Add a render-level test that verifies the stroke pipeline calls `setLineDash` and switches lineCap. Existing patterns in this file use a mocked `CanvasRenderingContext2D` — extend the spy:

```ts
it('renderHline applies dashPattern + lineCap from lineStyle', () => {
  const ctx = makeMockCtx(); // existing helper
  const drawing: Hline = {
    id: 'x', kind: 'hline', price: 1000,
    color: '#14B8A6', width: 2, lineStyle: 'dotted', paneId: 'candle',
  };
  renderDrawing(ctx.canvas2d, ctx.projectCtx, drawing, false);
  expect(ctx.canvas2d.setLineDash).toHaveBeenCalledWith([0, 5]);
  expect(ctx.canvas2d.lineCap).toBe('round');
});
```

(Adjust to whatever helper name the existing test file uses; the key behaviours are `setLineDash` spy and `lineCap` mutation.)

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/drawing/render.test.ts`
Expected: FAIL — `dashPattern` not exported; `setLineDash` never called.

- [ ] **Step 3: Implement `dashPattern` + update `setStroke`**

Edit `frontend/src/chart/drawing/render.ts`. Add the helper:

```ts
export function dashPattern(style: LineStyle, width: number): number[] {
  switch (style) {
    case 'solid':  return [];
    case 'dashed': return [width * 3, width * 2];
    case 'dotted': return [0, width * 2.5];
  }
}
```

Import `LineStyle` from `./types`.

Update `setStroke`:

```ts
function setStroke(c: CanvasRenderingContext2D, d: Drawing, selected: boolean) {
  c.strokeStyle = d.color;
  c.lineWidth = selected ? d.width * 2 : d.width;
  c.lineCap = d.lineStyle === 'dotted' ? 'round' : 'butt';
  c.lineJoin = 'round';
  c.setLineDash(dashPattern(d.lineStyle, d.width));
}
```

`drawHaloThenMain` paints the halo first with raw `setStroke(c, d, false)` then the main stroke — the halo also picks up the dash. That's correct: a dashed line's halo should also be dashed (otherwise the halo would look like a wider solid bar bleeding through the gaps).

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/drawing/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/drawing/render.ts frontend/src/chart/drawing/render.test.ts
git commit -m "feat(drawing): render lineStyle via setLineDash + lineCap switch"
```

---

## Task 8: Panel skeleton — file, gated render, ChartStage mount

**Files:**
- Create: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Create: `frontend/src/chart/DrawingPropertyPanel.test.tsx`
- Modify: `frontend/src/chart/ChartStage.tsx`

Establish the file with the visibility gate before any controls. Tests assert the gate first.

- [ ] **Step 1: Write failing tests for the visibility gate**

Create `frontend/src/chart/DrawingPropertyPanel.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import DrawingPropertyPanel from './DrawingPropertyPanel';
import { useDrawingsStore } from '../state/drawings';
import type { Drawing } from './drawing/types';

const HLINE: Drawing = {
  id: 'h1', kind: 'hline', price: 1000,
  color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
};

beforeEach(() => {
  useDrawingsStore.getState().__resetForTests();
  useDrawingsStore.getState().setActiveCode('005930');
});

describe('DrawingPropertyPanel — visibility gate', () => {
  it('does not render when selectedId is null', () => {
    const { container } = render(<DrawingPropertyPanel />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('does not render when activeTool is not select', () => {
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    useDrawingsStore.getState().setActiveTool('hline');
    const { container } = render(<DrawingPropertyPanel />);
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });

  it('renders when activeTool=select AND a drawing is selected', () => {
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    // activeTool defaults to 'select'
    const { container } = render(<DrawingPropertyPanel />);
    expect(container.querySelector('[data-drawing-property-panel]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create the panel skeleton**

Create `frontend/src/chart/DrawingPropertyPanel.tsx`:

```tsx
// frontend/src/chart/DrawingPropertyPanel.tsx
//
// Drawing Property Panel — the floating DOM affordance that lets the user
// edit the selected Drawing's color, stroke width, and line style, and
// delete it. See CONTEXT.md "Drawing Property Panel" and ADR-0032.

import { useDrawingsStore } from '../state/drawings';

export default function DrawingPropertyPanel() {
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const selectedId = useDrawingsStore((s) => s.selectedId);
  const activeCode = useDrawingsStore((s) => s.activeCode);
  const drawing = useDrawingsStore((s) => {
    if (s.activeCode == null || s.selectedId == null) return null;
    return s.byCode.get(s.activeCode)?.find((d) => d.id === s.selectedId) ?? null;
  });

  // Visibility gate — both clauses required.
  if (activeTool !== 'select' || selectedId == null || drawing == null) return null;
  void activeCode; // reserved for future per-code panel position memo

  return (
    <div
      data-drawing-property-panel
      className="absolute z-30 inline-flex items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 shadow-lg"
      style={{ top: 20, left: 14 }}
    >
      {/* controls land in subsequent tasks */}
    </div>
  );
}
```

- [ ] **Step 4: Mount in ChartStage**

Edit `frontend/src/chart/ChartStage.tsx`. After the `<DrawingOverlay ... />` line (around 445), add a sibling import + element:

```tsx
import DrawingPropertyPanel from './DrawingPropertyPanel';
// ...
<DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeries} />
<DrawingPropertyPanel />
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx`
Expected: PASS — all three gate cases green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx frontend/src/chart/ChartStage.tsx
git commit -m "feat(drawing): scaffold DrawingPropertyPanel with visibility gate"
```

---

## Task 9: Panel — ColorTrigger + ColorPopover

**Files:**
- Modify: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Modify: `frontend/src/chart/DrawingPropertyPanel.test.tsx`

First control: the color trigger (✎ glyph + 3px coloured bar) and its 4×4 swatch popover. Clicking a swatch dispatches `update + setDefaults`.

- [ ] **Step 1: Add failing test cases**

Append to `DrawingPropertyPanel.test.tsx`:

```tsx
import { fireEvent, screen } from '@testing-library/react';
import { COLOR_PALETTE } from './drawing/types';

describe('DrawingPropertyPanel — color', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('color trigger renders the drawing colour as the bar fill', () => {
    render(<DrawingPropertyPanel />);
    const bar = screen.getByTestId('drawing-color-bar');
    expect(bar.style.background).toBe('rgb(20, 184, 166)'); // #14B8A6 normalized
  });

  it('clicking the color trigger opens a 16-swatch popover', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    const swatches = screen.getAllByTestId(/^drawing-color-swatch-/);
    expect(swatches).toHaveLength(16);
  });

  it('clicking a swatch updates the drawing and defaults, closes popover', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.click(screen.getByTestId(`drawing-color-swatch-${COLOR_PALETTE[2]}`));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.color).toBe(COLOR_PALETTE[2]);
    expect(useDrawingsStore.getState().defaults.color).toBe(COLOR_PALETTE[2]);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on Escape', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });

  it('popover closes on outside mousedown', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "color"`
Expected: FAIL — controls not yet implemented.

- [ ] **Step 3: Implement ColorTrigger + ColorPopover**

Edit `DrawingPropertyPanel.tsx`. Add state and the trigger/popover as a child of the root:

```tsx
import { useState, useEffect, useRef } from 'react';
import { useDrawingsStore } from '../state/drawings';
import { COLOR_PALETTE } from './drawing/types';

type OpenPopover = 'color' | 'thickness' | 'lineStyle' | null;

export default function DrawingPropertyPanel() {
  // ...existing gate logic
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openPopover == null) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpenPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPopover(null);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openPopover]);

  const pickColor = (color: string) => {
    useDrawingsStore.getState().update(selectedId!, { color });
    setOpenPopover(null);
  };

  return (
    <div ref={rootRef} data-drawing-property-panel className="absolute z-30 ..."
         style={{ top: 20, left: 14 }}>
      <button
        type="button"
        data-testid="drawing-color-trigger"
        aria-label="색상"
        onClick={() => setOpenPopover(openPopover === 'color' ? null : 'color')}
        className="h-7 px-2 inline-flex flex-col items-center justify-center rounded gap-0.5 hover:bg-bg-input-hover"
      >
        <span className="text-sm leading-none">✎</span>
        <span data-testid="drawing-color-bar" className="block h-[3px] w-4 rounded-sm"
              style={{ background: drawing.color }} />
      </button>

      {openPopover === 'color' && (
        <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-2 shadow-xl">
          <div className="grid grid-cols-4 gap-1.5">
            {COLOR_PALETTE.map((hex) => {
              const isSelected = hex === drawing.color;
              return (
                <button
                  key={hex}
                  type="button"
                  data-testid={`drawing-color-swatch-${hex}`}
                  onClick={() => pickColor(hex)}
                  className={
                    'w-6 h-6 rounded border-2 ' +
                    (isSelected ? 'border-white' : 'border-transparent')
                  }
                  style={{ background: hex }}
                  aria-label={hex}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
```

`update` already syncs `setDefaults` (Task 4) for any style patch, so the test assertion on `defaults.color` will pass without an explicit `setDefaults` call here.

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "color"`
Expected: PASS — all 5 color cases green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx
git commit -m "feat(drawing): color trigger + 4x4 swatch popover on property panel"
```

---

## Task 10: Panel — ThicknessTrigger + ThicknessList

**Files:**
- Modify: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Modify: `frontend/src/chart/DrawingPropertyPanel.test.tsx`

The thickness control: a button showing `— Npx` that opens a list of 5 items. Clicking an item updates the drawing.

- [ ] **Step 1: Add failing tests**

Append to `DrawingPropertyPanel.test.tsx`:

```tsx
import { STROKE_WIDTHS } from './drawing/types';

describe('DrawingPropertyPanel — thickness', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('thickness trigger shows current width', () => {
    render(<DrawingPropertyPanel />);
    expect(screen.getByTestId('drawing-thickness-trigger').textContent).toContain('2px');
  });

  it('clicking the thickness trigger opens a 5-item list', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    const items = screen.getAllByTestId(/^drawing-thickness-item-/);
    expect(items).toHaveLength(STROKE_WIDTHS.length);
  });

  it('clicking an item updates drawing.width and defaults.width', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    fireEvent.click(screen.getByTestId('drawing-thickness-item-4'));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.width).toBe(4);
    expect(useDrawingsStore.getState().defaults.width).toBe(4);
  });

  it('only one popover open at a time — opening thickness closes color', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-color-trigger'));
    expect(screen.getAllByTestId(/^drawing-color-swatch-/)).toHaveLength(16);
    fireEvent.click(screen.getByTestId('drawing-thickness-trigger'));
    expect(screen.queryAllByTestId(/^drawing-color-swatch-/)).toHaveLength(0);
    expect(screen.getAllByTestId(/^drawing-thickness-item-/)).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "thickness"`
Expected: FAIL.

- [ ] **Step 3: Implement ThicknessTrigger + ThicknessList**

Add to `DrawingPropertyPanel.tsx` after the color block:

```tsx
import { STROKE_WIDTHS } from './drawing/types';
// ...
const pickWidth = (width: number) => {
  useDrawingsStore.getState().update(selectedId!, { width });
  setOpenPopover(null);
};

// Inside the panel root, after color trigger:
<button
  type="button"
  data-testid="drawing-thickness-trigger"
  aria-label="두께"
  onClick={() => setOpenPopover(openPopover === 'thickness' ? null : 'thickness')}
  className="h-7 px-2 inline-flex items-center gap-1.5 rounded hover:bg-bg-input-hover text-xs"
>
  <span className="inline-block w-4 border-t border-fg" style={{ borderTopWidth: drawing.width }} />
  <span className="tabular-nums">{drawing.width}px</span>
</button>

{openPopover === 'thickness' && (
  <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-1 shadow-xl min-w-[7rem]">
    {STROKE_WIDTHS.map((w) => {
      const isSelected = w === drawing.width;
      return (
        <button
          key={w}
          type="button"
          data-testid={`drawing-thickness-item-${w}`}
          onClick={() => pickWidth(w)}
          className={
            'w-full px-2 py-1 flex items-center gap-2 rounded text-xs ' +
            (isSelected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
          }
        >
          <span className="inline-block w-6 border-t border-current" style={{ borderTopWidth: w }} />
          <span className="tabular-nums">{w}px</span>
        </button>
      );
    })}
  </div>
)}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx`
Expected: PASS (color + thickness tests all green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx
git commit -m "feat(drawing): thickness trigger + 5-item list on property panel"
```

---

## Task 11: Panel — LineStyleTrigger + LineStylePopover

**Files:**
- Modify: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Modify: `frontend/src/chart/DrawingPropertyPanel.test.tsx`

Three-item popover: 실선 / 대시 / 도트, each with a small line preview using the matching border-style.

- [ ] **Step 1: Add failing tests**

Append to `DrawingPropertyPanel.test.tsx`:

```tsx
import { LINE_STYLES } from './drawing/types';

describe('DrawingPropertyPanel — line style', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('line-style trigger renders a preview of current style', () => {
    render(<DrawingPropertyPanel />);
    const trigger = screen.getByTestId('drawing-line-style-trigger');
    expect(trigger.getAttribute('data-current-style')).toBe('solid');
  });

  it('clicking the trigger opens a 3-item popover', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    const items = screen.getAllByTestId(/^drawing-line-style-item-/);
    expect(items).toHaveLength(LINE_STYLES.length);
  });

  it('selecting "dashed" updates drawing and defaults', () => {
    render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-line-style-trigger'));
    fireEvent.click(screen.getByTestId('drawing-line-style-item-dashed'));
    const drawn = useDrawingsStore.getState().byCode.get('005930')!.find((d) => d.id === 'h1')!;
    expect(drawn.lineStyle).toBe('dashed');
    expect(useDrawingsStore.getState().defaults.lineStyle).toBe('dashed');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "line style"`
Expected: FAIL.

- [ ] **Step 3: Implement LineStyleTrigger + LineStylePopover**

Add to `DrawingPropertyPanel.tsx`:

```tsx
import { LINE_STYLES, type LineStyle } from './drawing/types';

const LINE_STYLE_LABELS: Record<LineStyle, string> = {
  solid: '실선',
  dashed: '대시',
  dotted: '도트',
};

const previewBorderStyle = (style: LineStyle): string =>
  style === 'solid' ? 'solid' : style === 'dashed' ? 'dashed' : 'dotted';

const pickLineStyle = (lineStyle: LineStyle) => {
  useDrawingsStore.getState().update(selectedId!, { lineStyle });
  setOpenPopover(null);
};

// Inside the panel root, after thickness:
<button
  type="button"
  data-testid="drawing-line-style-trigger"
  data-current-style={drawing.lineStyle}
  aria-label="선 스타일"
  onClick={() => setOpenPopover(openPopover === 'lineStyle' ? null : 'lineStyle')}
  className="h-7 px-2 inline-flex items-center rounded hover:bg-bg-input-hover"
>
  <span
    className="inline-block w-4 border-t border-fg"
    style={{ borderTopStyle: previewBorderStyle(drawing.lineStyle), borderTopWidth: 1.5 }}
  />
</button>

{openPopover === 'lineStyle' && (
  <div className="absolute top-full left-0 mt-1 bg-bg-card border border-border rounded-md p-1 shadow-xl min-w-[7rem]">
    {LINE_STYLES.map((style) => {
      const isSelected = style === drawing.lineStyle;
      return (
        <button
          key={style}
          type="button"
          data-testid={`drawing-line-style-item-${style}`}
          onClick={() => pickLineStyle(style)}
          className={
            'w-full px-2 py-1 flex items-center gap-2 rounded text-xs ' +
            (isSelected ? 'bg-bg-input-hover text-accent' : 'text-fg hover:bg-bg-input-hover')
          }
        >
          <span
            className="inline-block w-6 border-t border-current"
            style={{ borderTopStyle: previewBorderStyle(style), borderTopWidth: 1.5 }}
          />
          {LINE_STYLE_LABELS[style]}
        </button>
      );
    })}
  </div>
)}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "line style"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx
git commit -m "feat(drawing): line-style trigger + 3-item popover on property panel"
```

---

## Task 12: Panel — DeleteButton

**Files:**
- Modify: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Modify: `frontend/src/chart/DrawingPropertyPanel.test.tsx`

A small trash button that dispatches `remove(selectedId)`. After remove, `selectedId` becomes `null` (the store's `remove` already nulls it when it matches), so the panel disappears automatically.

- [ ] **Step 1: Add failing test**

Append:

```tsx
describe('DrawingPropertyPanel — delete', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('clicking delete removes the drawing and hides the panel', () => {
    const { container } = render(<DrawingPropertyPanel />);
    fireEvent.click(screen.getByTestId('drawing-delete'));
    expect(useDrawingsStore.getState().byCode.get('005930')).toEqual([]);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
    expect(container.querySelector('[data-drawing-property-panel]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "delete"`
Expected: FAIL.

- [ ] **Step 3: Implement delete button + divider**

Add to the panel root, after the line-style block:

```tsx
<div className="w-px h-4 bg-border mx-0.5" />
<button
  type="button"
  data-testid="drawing-delete"
  aria-label="삭제"
  onClick={() => useDrawingsStore.getState().remove(selectedId!)}
  className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-bg-input-hover text-danger"
>
  🗑
</button>
```

(Replace `text-danger` with whatever the codebase's danger-text utility is — if none exists, `text-[#F43F5E]`.)

- [ ] **Step 4: Run test — verify it passes**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "delete"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx
git commit -m "feat(drawing): delete button on property panel"
```

---

## Task 13: Panel — drag (grip + window mouse listeners)

**Files:**
- Modify: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Modify: `frontend/src/chart/DrawingPropertyPanel.test.tsx`

A ⋮⋮ grip on the left lets the user drag the panel. State is component-local — session-scoped, no persistence. Panel position state is `{x, y}`; the panel renders at `position: absolute; left/top` from that state.

- [ ] **Step 1: Add failing tests**

Append:

```tsx
describe('DrawingPropertyPanel — drag', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
  });

  it('dragging the grip translates the panel', () => {
    render(<DrawingPropertyPanel />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    const grip = screen.getByTestId('drawing-panel-grip');
    const startLeft = parseFloat(panel.style.left);
    const startTop = parseFloat(panel.style.top);

    fireEvent.mouseDown(grip, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 130 });
    fireEvent.mouseUp(window);

    expect(parseFloat(panel.style.left)).toBeCloseTo(startLeft + 50);
    expect(parseFloat(panel.style.top)).toBeCloseTo(startTop + 30);
  });
});
```

Add `data-testid="drawing-property-panel"` to the root if not already.

- [ ] **Step 2: Run test — verify it fails**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "drag"`
Expected: FAIL.

- [ ] **Step 3: Implement drag**

Add state + grip + window listeners:

```tsx
const INITIAL_POSITION = { x: 14, y: 20 };
const [position, setPosition] = useState<{ x: number; y: number }>(INITIAL_POSITION);
const dragRef = useRef<{ startMouseX: number; startMouseY: number;
                        startPanelX: number; startPanelY: number } | null>(null);

useEffect(() => {
  const onMove = (e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPosition({
      x: d.startPanelX + (e.clientX - d.startMouseX),
      y: d.startPanelY + (e.clientY - d.startMouseY),
    });
  };
  const onUp = () => { dragRef.current = null; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  return () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
}, []);

const startDrag = (e: React.MouseEvent) => {
  dragRef.current = {
    startMouseX: e.clientX,
    startMouseY: e.clientY,
    startPanelX: position.x,
    startPanelY: position.y,
  };
};
```

Replace the static `style={{ top: 20, left: 14 }}` with `style={{ top: position.y, left: position.x }}`.

Prepend the root with the grip:

```tsx
<span
  data-testid="drawing-panel-grip"
  onMouseDown={startDrag}
  className="px-1 h-7 inline-flex items-center text-fg-dim cursor-grab select-none"
>
  ⋮⋮
</span>
```

- [ ] **Step 4: Run test — verify it passes**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "drag"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx
git commit -m "feat(drawing): drag the property panel via grip handle (session-only)"
```

---

## Task 14: Panel — initial position computation per drawing kind

**Files:**
- Modify: `frontend/src/chart/DrawingPropertyPanel.tsx`
- Modify: `frontend/src/chart/DrawingPropertyPanel.test.tsx`

When `selectedId` changes, the panel re-positions near the just-selected Drawing. The mapping needs the chart container's coordinate system (pane offsets + canvas projections). The cleanest seam is to pass a helper from `ChartStage` that already knows pane geometry — but to keep ChartStage's API simple, we expose a `useDrawingScreenAnchor(drawing)` hook backed by the same `paneSeries` registry the overlay uses. For v1 the panel can read it through the shared `useDrawingsStore`-adjacent `useDrawingAnchor` hook that returns `{ x, y } | null` per drawing id.

Pragmatic shortcut: do the position computation **inside ChartStage** (which has `chart`, `axis`, `paneSeries` in scope) and pass it as a prop callback into `DrawingPropertyPanel`. This keeps `DrawingPropertyPanel` free of chart imports.

- [ ] **Step 1: Add failing test**

Append:

```tsx
describe('DrawingPropertyPanel — initial position per selection', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
    useDrawingsStore.getState().setActiveCode('005930');
  });

  it('calls computeAnchor(drawing) when selectedId changes and applies its result', () => {
    const computeAnchor = vi.fn().mockReturnValue({ x: 120, y: 80 });
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel computeAnchor={computeAnchor} />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(computeAnchor).toHaveBeenCalledWith(HLINE);
    expect(panel.style.left).toBe('120px');
    expect(panel.style.top).toBe('80px');
  });

  it('null anchor (off-axis) falls back to INITIAL_POSITION', () => {
    const computeAnchor = vi.fn().mockReturnValue(null);
    useDrawingsStore.getState().add(HLINE);
    useDrawingsStore.getState().setSelected('h1');
    render(<DrawingPropertyPanel computeAnchor={computeAnchor} />);
    const panel = screen.getByTestId('drawing-property-panel') as HTMLElement;
    expect(panel.style.left).toBe('14px');
    expect(panel.style.top).toBe('20px');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "initial position"`
Expected: FAIL.

- [ ] **Step 3: Add `computeAnchor` prop and selection effect**

Edit `DrawingPropertyPanel.tsx`:

```tsx
export type DrawingAnchor = { x: number; y: number };
export type ComputeAnchorFn = (d: Drawing) => DrawingAnchor | null;

type Props = {
  computeAnchor?: ComputeAnchorFn;
};

export default function DrawingPropertyPanel({ computeAnchor }: Props = {}) {
  // ...existing
  useEffect(() => {
    if (drawing == null) return;
    const anchor = computeAnchor?.(drawing) ?? null;
    setPosition(anchor ?? INITIAL_POSITION);
  // Re-anchor only on selection identity change, not on every drawing edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing?.id]);
  // ...
}
```

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx -t "initial position"`
Expected: PASS.

- [ ] **Step 4: Wire `computeAnchor` in ChartStage**

Edit `ChartStage.tsx`. Add a `useCallback` that maps a Drawing → screen coords using the existing `paneSeries`, `chart`, and `axis` in scope:

```tsx
import type { Drawing } from './drawing/types';
import {
  priceToCanvasY,
  realMsToCanvasX,
} from './drawing/chartCoordinates';

const PANEL_Y_OFFSET = -38;
const PANEL_X_OFFSET_HLINE = 14;
const PANEL_X_OFFSET_PENCIL = 0;
const PANEL_X_OFFSET_TRENDLINE = -8;

const computeAnchor = useCallback((d: Drawing) => {
  if (!chart || !axis || !paneSeries) return null;

  if (d.kind === 'hline') {
    const y = priceToCanvasY(chart, paneSeries, d.paneId, d.price);
    if (y == null) return null;
    // pane-left is 0 in chart-container coords because the chart fills it.
    return { x: PANEL_X_OFFSET_HLINE, y: y + PANEL_Y_OFFSET };
  }

  if (d.kind === 'trendline') {
    const xa = realMsToCanvasX(chart, axis, d.a.realMs);
    const xb = realMsToCanvasX(chart, axis, d.b.realMs);
    const ya = priceToCanvasY(chart, paneSeries, d.paneId, d.a.price);
    const yb = priceToCanvasY(chart, paneSeries, d.paneId, d.b.price);
    if (xa == null || xb == null || ya == null || yb == null) return null;
    return {
      x: (xa + xb) / 2 + PANEL_X_OFFSET_TRENDLINE,
      y: (ya + yb) / 2 + PANEL_Y_OFFSET,
    };
  }

  // pencil
  let minX = Infinity, minY = Infinity;
  for (const p of d.points) {
    const x = realMsToCanvasX(chart, axis, p.realMs);
    const y = priceToCanvasY(chart, paneSeries, d.paneId, p.price);
    if (x != null && y != null) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
  }
  if (!isFinite(minX) || !isFinite(minY)) return null;
  return { x: minX + PANEL_X_OFFSET_PENCIL, y: minY + PANEL_Y_OFFSET };
}, [chart, axis, paneSeries]);

// In JSX:
<DrawingPropertyPanel computeAnchor={computeAnchor} />
```

- [ ] **Step 5: Run all panel tests + typecheck**

Run: `cd frontend && npx vitest run src/chart/DrawingPropertyPanel.test.tsx && npx tsc --noEmit`
Expected: PASS, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/DrawingPropertyPanel.tsx frontend/src/chart/DrawingPropertyPanel.test.tsx frontend/src/chart/ChartStage.tsx
git commit -m "feat(drawing): panel re-anchors near selected drawing (hline/trendline/pencil)"
```

---

## Task 15: ADR-0032 + ADR-0030 status + CONTEXT.md Drawing Tool entry

**Files:**
- Create: `docs/adr/0032-drawing-property-panel.md`
- Modify: `docs/adr/0030-drawing-commit-clears-selection.md`
- Modify: `CONTEXT.md`

Docs catch up with the code change.

- [ ] **Step 1: Create ADR-0032**

Create `docs/adr/0032-drawing-property-panel.md`:

```markdown
# 0032 — Drawing property panel (supersedes ADR-0030 in part)

**Status:** accepted (2026-05-25)
**Supersedes (in part):** ADR-0030 (post-commit clears selection) — only the post-commit clause; the empty-click-deselects companion is preserved.

## Decision

The **Replay Viewer** ships a **Drawing Property Panel** that floats over the chart whenever a **Drawing** is selected in `select` mode. The panel lets the user edit color (16-entry palette), stroke width ({1,2,3,4,5} px), and line style (solid / dashed / dotted), and delete the drawing. The user's last-picked style values are persisted globally to `localStorage["replay.drawingDefaults.v1"]` as **Drawing Defaults** and seed the next new drawing of any kind.

To make the panel always point at a clear target, after a drawing tool commits a new shape the active tool reverts to `select` **and `selectedId` is set to the new drawing's id** — restoring halo + 2× stroke on the freshly-committed shape. This reverses the post-commit clause of ADR-0030.

The empty-click-deselects companion from ADR-0030 is **kept**: clicking on empty chart space in `select` mode clears `selectedId`, hiding the panel.

## Why this supersedes ADR-0030

ADR-0030 argued that a halo on a shape the user had not clicked read as visual noise — *"select mode = nothing selected"* was the user's mental model and a fresh halo broke it. That argument depended on there being **no DOM affordance** that pointed at the freshly-drawn shape: the halo had nothing to anchor.

Once a property panel exists, the halo *is* the visual anchor for the panel. Removing it would make the panel float over the chart with no indication of which drawing it controls. The 2026-05-25 brainstorm session re-examined the trade-off with the panel feature in scope and re-decided the post-commit clause.

The empty-click-deselects clause from ADR-0030 stands because it is independent of the panel: it solves the orthogonal problem of stale selection lingering after unrelated chart interactions.

## Why the palette is fixed

Free-form colour entry would (a) break `DESIGN.md`'s colour-token discipline by introducing arbitrary hex values, (b) add a non-trivial input surface (hex parsing, eyedropper, contrast accessibility), and (c) tempt users into per-drawing colour tweaking that produces noisy charts. Sixteen palette entries cover the practical needs (system / market / strong / muted / grayscale) while keeping the colour vocabulary disciplined.

The palette is registered in `DESIGN.md` as a fourth "user annotation layer" category alongside the existing three (system / status / market direction), because annotations are user-authored content rather than UI chrome — distinct in intent and provenance.

## Why session-only panel position

Persistent panel position would be feature creep — the panel's role is "edit this drawing now," not "remember where I parked the panel for this line." Two questions would also have to be answered (per-drawing? per-stock? what about pan/zoom?) for a feature whose return is "the panel reopens 30 pixels to the left of where it would otherwise." We chose to skip the question and accept that the panel re-anchors per selection.

## Consequences

- `Drawing.lineStyle` field added; legacy hydration defaults to `'solid'`.
- `useDrawingsStore` gains a `defaults` slice; `update(id, patch)` syncs style fields into defaults.
- `ToolCtx` loses `accentColor` and gains `defaults: DrawingDefaults`.
- `revertToSelectMode(newId)` regains its `newId` argument and selects the just-added shape; the Escape handler in `DrawingOverlay.tsx` still clears explicitly (Escape's "return to neutral" semantic is unchanged).
- `setStroke` writes `setLineDash(dashPattern(lineStyle, width))` and switches `lineCap` to `'round'` for dotted (round-cap zero-length-dash dot trick).
- A new component `DrawingPropertyPanel.tsx` mounts as a sibling of `DrawingOverlay` in `ChartStage`.
- ADR-0030's status header is updated to "superseded in part by ADR-0032."
- CONTEXT.md's `Drawing Tool` entry is rewritten to cite ADR-0032 for the post-commit description; the `Drawing Property Panel` and `Drawing Defaults` glossary entries were added during the brainstorm grill and remain accurate.

## Alternatives considered

- **Keep ADR-0030 verbatim; show the panel without restoring selection.** Rejected — the panel would point at a drawing rendered in the same style as every other drawing; the user could not tell which one is being edited.
- **Free-form hex input.** Rejected — colour-token discipline + accessibility cost (see "Why the palette is fixed").
- **Persistent panel position.** Rejected — feature creep with low return.
- **Locked drawings.** Out of scope for v1. The model doesn't need a `locked` field yet; if added later, the panel grows a lock toggle.
```

- [ ] **Step 2: Update ADR-0030 status**

Edit `docs/adr/0030-drawing-commit-clears-selection.md` — change the status line:

```markdown
**Status:** superseded in part by [ADR-0032](0032-drawing-property-panel.md) (2026-05-25) — the post-commit "clears selection" decision is reversed; the empty-click-deselects companion in this ADR is preserved.
```

Add a `## Update — superseded in part (2026-05-25)` section at the bottom briefly summarising why and pointing at 0032.

- [ ] **Step 3: Update CONTEXT.md `Drawing Tool` post-commit paragraph**

Edit `CONTEXT.md`. Find the paragraph in the `Drawing Tool` entry that begins *"After a drawing tool commits a new Drawing, the active tool auto-reverts to select and no Drawing is left selected..."*. Replace it with:

```
After a drawing tool commits a new **Drawing**, the active tool auto-reverts to `select` **and the just-added Drawing becomes the selected one** — the **Drawing Property Panel** attaches to it and the canvas renders the new shape with selection emphasis (halo + 2× stroke). The companion behaviour from ADR-0030 — clicking on empty chart space in `select` mode clears the current selection — is preserved, so a stale halo cannot linger across an unrelated chart interaction. Chart pan/zoom on that empty-space click is preserved. See ADR-0032 for the rationale and ADR-0030 for the prior, partially-superseded decision. `eraser` is intentionally excluded from auto-revert because continuous erasure of multiple drawings is the common flow.
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0032-drawing-property-panel.md docs/adr/0030-drawing-commit-clears-selection.md CONTEXT.md
git commit -m "docs(adr): ADR-0032 drawing property panel; supersedes ADR-0030 in part"
```

---

## Task 16: Full-suite smoke + dev-server eyeball

**Files:** none

Final guardrail — run the whole frontend test suite plus a manual dev-server check on a real drawing.

- [ ] **Step 1: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: all tests pass. If any pre-existing test now fails, investigate — Task 5 / Task 6 changed `ToolCtx` shape and any test that constructs a context manually needs the `defaults` field.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Start dev server and exercise the feature**

Per `CLAUDE.md`:

Backend (separate terminal):
```
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

Frontend (separate terminal):
```
cd frontend && npm run dev
```

In the browser at `http://localhost:5173`, open a Replay Tab on any captured Stock-Date and:

- Draw an hline — confirm the property panel appears next to it, halo + 2× stroke render on the new line.
- Change colour, thickness, and line style — observe the line update live.
- Draw a second hline (with hline tool) — confirm the panel hides while drafting, the second line inherits the picked colour/width/style.
- Click the second hline — panel re-appears, panel position re-anchors.
- Click on empty chart space — panel disappears.
- Reload the page — confirm the sticky defaults survived.
- Test on candle, volume, ratio, quote-totals, and fill-strength panes for the hline tool — confirm the panel positions correctly on each.
- Test trendline and pencil — confirm same UX.

If anything visual is wrong, file a follow-up issue rather than patching ad hoc — the spec governs.

- [ ] **Step 4: Commit no code (this task is verify-only) — proceed to PR**

---

## Self-review

- **Spec coverage:**
  - §Domain model & types → Task 1
  - §State (defaults slice) → Task 4
  - §Persistence (legacy + defaults) → Tasks 2, 3
  - §Rendering (dashPattern + setStroke) → Task 7
  - §Tool commit flow (revertToSelectMode + tools.ts) → Task 5
  - §DrawingOverlay → Task 6
  - §Components (panel + popovers + drag + position) → Tasks 8–14
  - §ADR-0032, §domain doc updates → Task 15
  - §Migration → covered by Task 2 (`lineStyle ?? 'solid'`) and absent-key handling in Task 3
  - §Testing table → distributed across each task's test step; covers all rows
  - §Out of scope → no implementation; mentioned in ADR-0032 alternatives

- **Placeholder scan:** No "TBD" / "implement later" / "similar to Task N". Every code step has real code. Every test step has the assertion. Every command has its expected output.

- **Type consistency:** `revertToSelectMode(newId: string)` consistent across Tasks 5, 6, 15. `DrawingDefaults` type used identically in Tasks 1, 3, 4, 5. `COLOR_PALETTE` / `STROKE_WIDTHS` / `LINE_STYLES` exported once (Task 1), imported by name elsewhere. Panel `computeAnchor` prop name consistent across Tasks 14 and the ChartStage wiring.

- **Risk notes:**
  - Task 14's `computeAnchor` reads `chart`, `axis`, `paneSeries` from `ChartStage` scope — confirm these names match by reading `ChartStage.tsx` before edit (search `paneSeries`).
  - Task 7's halo-also-dashed observation is intentional; if a user dislikes it, the change is in `drawHaloThenMain` not in any data shape.
  - Task 6 leaves `accentColor` removal silent — if `resolveTokens` is used elsewhere in the file (for tokens other than `accent`), keep the import; verify before deleting.

---

## Execution handoff

Next step (per the user's chain): `/superpowers:subagent-driven-development` on this plan. Dispatch one fresh subagent per task; review between tasks. Tasks are size-balanced so each subagent run stays under typical context budgets.
