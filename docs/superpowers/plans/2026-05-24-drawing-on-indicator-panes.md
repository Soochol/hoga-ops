# Drawings on Indicator Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Drawing Overlay (`/replay`) so users can draw hline, trendline, and pencil shapes on any chart pane — not just the candle pane — by binding every Drawing to a stable `paneId` string and making coordinates, clip, hit-test, and drag pane-aware.

**Architecture:** A single overlay canvas covering the chart, but each Drawing carries a `paneId: PaneId` (`'candle' | 'volume' | 'ratio' | 'quote-totals' | 'fill-strength'`). `ChartStage` owns a `Map<PaneId, ISeriesApi>` registry populated by each `RangeSeriesPane` on mount; coordinate helpers, render, hit-test, and drag clamps all flow through it. Persistence backfills legacy data to `paneId='candle'`. PaneSpec.name becomes a stable persistence identifier (renames break user data — see ADR-0028).

**Tech Stack:** TypeScript, React, lightweight-charts v5, Vitest, zustand. All work is inside `frontend/`.

**Spec:** `docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md`
**ADR:** `docs/adr/0028-drawing-pane-binding.md`

---

## Test commands

- Run a focused vitest file: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts`
- Run a single test by name: `cd frontend && npx vitest run -t 'backfills missing paneId'`
- Run the full frontend test suite: `cd frontend && npm test`
- Type-check (paths run from repo root): `cd frontend && npx tsc --noEmit`

## File map

| File | Action | Purpose |
|---|---|---|
| `frontend/src/chart/drawing/types.ts` | modify | Add `PaneId` literal union, add `paneId: PaneId` to `DrawingBase` |
| `frontend/src/chart/paneSpecs.ts` | modify | Add stability invariant comment at top |
| `frontend/src/chart/drawing/persistence.ts` | modify | Backfill missing `paneId` (and tolerate legacy `paneIndex`) on load |
| `frontend/src/chart/drawing/chartCoordinates.ts` | modify | Replace `PriceSeries` with `PaneSeriesMap`; signatures take `paneId`; export `paneIdToIndex`, `paneIdAtY`, `clampYToPane` |
| `frontend/src/chart/drawing/paneDispatch.test.ts` | create | Unit tests for `paneIdToIndex`, `paneIdAtY`, `clampYToPane` |
| `frontend/src/chart/drawing/render.ts` | modify | `ProjectCtx` swap to `paneSeries: PaneSeriesMap` + `paneId: PaneId` |
| `frontend/src/chart/drawing/translate.ts` | modify | Body-translate clamps Δprice to keep Drawing inside pane |
| `frontend/src/chart/drawing/tools.ts` | modify | `ToolCtx` gains `paneIdAtY` + `clampYToPane`; tools stamp `paneId` on creation; trendline/pencil drafts carry `paneId`; selectTool body-drag clamps via origin `paneId` |
| `frontend/src/chart/RangeSeriesPane.tsx` | modify | Accept `onPrimarySeriesReady` / `onPrimarySeriesGone` callbacks |
| `frontend/src/chart/ChartStage.tsx` | modify | Own `paneSeriesRef: Map<PaneId, ISeriesApi<any>>`; wire callbacks; remove `candleSeries`; pass `paneSeries` to `DrawingOverlay` |
| `frontend/src/chart/DrawingOverlay.tsx` | modify | Drop `priceSeries` prop, take `paneSeries`; per-drawing clip; pane-filtered hit-test; draft preview clipped |
| `frontend/src/chart/drawing/*.test.ts` | modify | Update fixtures to include `paneId: 'candle'`; add pane-aware cases |

---

## Task 1: Add `PaneId` type and `paneId` field

**Files:**
- Modify: `frontend/src/chart/drawing/types.ts`
- Modify: `frontend/src/chart/paneSpecs.ts`
- Modify: existing test files to update fixtures (mechanical)

This task adds the foundational type. All downstream tasks depend on it. We make `paneId` required from day one and update existing test fixtures in the same task so the test suite stays green at every commit.

- [ ] **Step 1.1: Add `PaneId` type and `paneId` field to `types.ts`**

Edit `frontend/src/chart/drawing/types.ts`. Replace the top of the file (everything down through `interface DrawingBase`) with:

```ts
// frontend/src/chart/drawing/types.ts

/**
 * Drawing primitive types. All time coordinates are real Unix-ms (UTC) —
 * NOT virtual-ms from the Virtual Axis — so drawings remain valid across
 * different Stock-Date Range loads of the same Code (see ADR-0024 and
 * the design spec).
 *
 * Every Drawing is bound to one chart pane via `paneId`. The id mirrors
 * `PaneSpec.name` and is the stable persistence key — see ADR-0028.
 */

export type Point = {
  /** Real Unix-ms (UTC), per ADR-0003. */
  realMs: number;
  /** Value on the pane's Y-domain. KRW on candle, share count on volume,
   *  signed −1..1 on ratio, etc. */
  price: number;
};

export type DrawingId = string;

export type DrawingKind = 'hline' | 'trendline' | 'pencil';

export type DrawingTool = 'select' | 'hline' | 'trendline' | 'pencil' | 'eraser';

/** Stable identifier for a chart pane. Mirrors `PaneSpec.name`. Renaming
 *  any literal here is a breaking change — strands every user's saved
 *  drawings bound to that name. See ADR-0028. */
export type PaneId =
  | 'candle'
  | 'volume'
  | 'ratio'
  | 'quote-totals'
  | 'fill-strength';

interface DrawingBase {
  id: DrawingId;
  /** Stroke color. v1 always references the accent token via util/tokens. */
  color: string;
  /** Stroke width in CSS pixels. v1 fixed to 1.5. */
  width: number;
  /** Pane this drawing belongs to. Required. See ADR-0028. */
  paneId: PaneId;
}
```

Leave the `Hline`, `Trendline`, `Pencil`, `Drawing`, `PENCIL_MAX_POINTS`, and `HIT_THRESHOLD` definitions below unchanged.

- [ ] **Step 1.2: Run type-check — expect failures**

Run: `cd frontend && npx tsc --noEmit`
Expected: errors in `persistence.test.ts`, `tools.ts`, `tools.test.ts`, `translate.test.ts`, `render.test.ts`, `hitTest.test.ts`, `DrawingOverlay.tsx` — every Drawing literal now needs `paneId`.

- [ ] **Step 1.3: Backfill `paneId: 'candle'` on every existing Drawing literal in tests**

Update test files so existing Drawing literals carry `paneId: 'candle'`. These literals appear in:

- `frontend/src/chart/drawing/persistence.test.ts` (the `items` array in the round-trip test)
- `frontend/src/chart/drawing/tools.test.ts` (any inline Drawing in selectTool tests)
- `frontend/src/chart/drawing/translate.test.ts` (every Drawing input)
- `frontend/src/chart/drawing/render.test.ts` (every Drawing input)
- `frontend/src/chart/drawing/hitTest.test.ts` (any Drawing fixtures)
- `frontend/src/state/drawings.test.ts` (the `add` payloads)

For each fixture, add `paneId: 'candle'` alongside the other fields. The intent: every legacy test continues to test candle-pane behaviour, just now with the field explicit.

Example — in `persistence.test.ts`, the round-trip fixture becomes:
```ts
const items: Drawing[] = [
  { id: 'a', kind: 'hline', price: 75000, color: '#FFD60A', width: 1.5, paneId: 'candle' },
  {
    id: 'b',
    kind: 'trendline',
    a: { realMs: 1_700_000_000_000, price: 70000 },
    b: { realMs: 1_700_003_600_000, price: 72000 },
    color: '#FFD60A',
    width: 1.5,
    paneId: 'candle',
  },
];
```

- [ ] **Step 1.4: Backfill `paneId: 'candle'` in `tools.ts` runtime creation paths**

Existing `tools.ts` calls `ctx.add({...})` in `hlineTool.onPointerDown`, `trendlineTool.onPointerUp`, and `pencilTool.onPointerUp`. Each needs `paneId: 'candle'` for now — Task 6 will replace this with the real `paneIdAtY` resolution.

In `frontend/src/chart/drawing/tools.ts`:

```ts
// hlineTool.onPointerDown — inside ctx.add({...})
paneId: 'candle',
```

Add the same `paneId: 'candle',` field to the `ctx.add({...})` payload in `trendlineTool.onPointerUp` and `pencilTool.onPointerUp`. Also add it to the synthesized draft pencil drawing inside `DrawingOverlay.tsx` (search for `id: '__draft__'`).

- [ ] **Step 1.5: Add the `paneSpecs.ts` invariant comment**

Edit `frontend/src/chart/paneSpecs.ts`. Replace the existing top-of-file comment block (the `/** ... */` above `export const PANE_SPECS`) with:

```ts
/**
 * Master registry of `PaneSpec`s rendered by ChartStage in paneIndex
 * order. `setStretchFactor(spec.stretch)` is applied after mount.
 *
 * Index = paneIndex. Reordering this array reorders chart panes;
 * lightweight-charts v5 auto-clamps a requested `paneIndex` to the
 * next-available index, so the ordering invariant lives in this
 * array's position, not in JSX.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  STABLE PERSISTENCE IDS — DO NOT RENAME `PaneSpec.name`
 * ──────────────────────────────────────────────────────────────────────
 * Each spec's `name` is the stable persistence key under which user
 * Drawings store their pane binding (see `drawing/types.ts::PaneId` and
 * ADR-0028). Renaming an existing `name` orphans every saved drawing
 * bound to that name. Reordering this array is safe (drawings reference
 * by name, not index). Adding a new pane: append a new literal to
 * `PaneId` in types.ts and use it as the `name` here.
 */
```

- [ ] **Step 1.6: Run type-check + tests — expect green**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS (no errors).

Run: `cd frontend && npm test`
Expected: PASS — every existing test continues to work because all fixtures now include `paneId: 'candle'`.

- [ ] **Step 1.7: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4
git add frontend/src/chart/drawing/types.ts frontend/src/chart/paneSpecs.ts \
        frontend/src/chart/drawing/persistence.test.ts \
        frontend/src/chart/drawing/tools.test.ts \
        frontend/src/chart/drawing/translate.test.ts \
        frontend/src/chart/drawing/render.test.ts \
        frontend/src/chart/drawing/hitTest.test.ts \
        frontend/src/chart/drawing/tools.ts \
        frontend/src/chart/DrawingOverlay.tsx \
        frontend/src/state/drawings.test.ts
git commit -m "feat(drawing): add PaneId + paneId field on DrawingBase

Foundation for pane-aware drawings. Every Drawing now carries paneId,
defaulted to 'candle' across existing code and tests so behaviour is
unchanged. paneSpecs.ts documents the rename-breaks-data invariant.
Follow-up tasks introduce the real pane dispatch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Persistence migration — backfill legacy `paneId`

**Files:**
- Modify: `frontend/src/chart/drawing/persistence.ts`
- Modify: `frontend/src/chart/drawing/persistence.test.ts`

This task makes `loadDrawings` tolerate legacy payloads written before Task 1 (no `paneId`) and the in-flight `paneIndex` schema some dev branches may have written. Schema stays at `v: 1` — superset migration.

- [ ] **Step 2.1: Write a failing test for legacy-no-paneId backfill**

Add this test to `frontend/src/chart/drawing/persistence.test.ts` inside a new `describe('loadDrawings — paneId migration')` block:

```ts
import { PANE_SPECS } from '../paneSpecs';

describe('loadDrawings — paneId migration', () => {
  it("backfills paneId='candle' on items missing paneId", () => {
    const legacy = {
      v: 1,
      items: [
        // No paneId field — pre-Task-1 payload.
        { id: 'a', kind: 'hline', price: 75000, color: '#14B8A6', width: 1.5 },
      ],
    };
    localStorage.setItem(storageKey(CODE), JSON.stringify(legacy));
    const loaded = loadDrawings(CODE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'a', kind: 'hline', paneId: 'candle' });
  });

  it('resolves legacy paneIndex via PANE_SPECS to a paneId', () => {
    const ratioIdx = PANE_SPECS.findIndex((s) => s.name === 'ratio');
    expect(ratioIdx).toBeGreaterThanOrEqual(0);
    const legacy = {
      v: 1,
      items: [
        {
          id: 'b',
          kind: 'hline',
          price: 0.42,
          color: '#14B8A6',
          width: 1.5,
          paneIndex: ratioIdx,
        },
      ],
    };
    localStorage.setItem(storageKey(CODE), JSON.stringify(legacy));
    const loaded = loadDrawings(CODE);
    expect(loaded[0].paneId).toBe('ratio');
    // The paneIndex field is not preserved on the typed Drawing shape.
    expect((loaded[0] as Drawing & { paneIndex?: number }).paneIndex).toBeUndefined();
  });

  it("falls back to paneId='candle' when paneIndex is out of range", () => {
    const legacy = {
      v: 1,
      items: [
        { id: 'c', kind: 'hline', price: 1, color: '#14B8A6', width: 1.5, paneIndex: 999 },
      ],
    };
    localStorage.setItem(storageKey(CODE), JSON.stringify(legacy));
    expect(loadDrawings(CODE)[0].paneId).toBe('candle');
  });
});
```

- [ ] **Step 2.2: Run the new tests — expect them to fail**

Run: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts -t 'paneId migration'`
Expected: 3 failures — current `loadDrawings` returns the items verbatim, so they have no `paneId`.

- [ ] **Step 2.3: Implement the migration in `persistence.ts`**

Replace the body of `loadDrawings` in `frontend/src/chart/drawing/persistence.ts` with:

```ts
import type { Drawing, PaneId } from './types';
import { PANE_SPECS } from '../paneSpecs';

const PREFIX = 'replay.drawings.v1.';
const VERSION = 1;

export function storageKey(code: string): string {
  return `${PREFIX}${code}`;
}

type Wrapper = { v: number; items: unknown };

/** Legacy in-memory shape — readers tolerate items missing paneId or
 *  carrying the never-shipped numeric paneIndex from dev branches. */
type LegacyItem = Omit<Drawing, 'paneId'> & {
  paneId?: PaneId;
  paneIndex?: number;
};

function resolvePaneId(item: LegacyItem): PaneId {
  if (typeof item.paneId === 'string') return item.paneId;
  if (
    typeof item.paneIndex === 'number' &&
    PANE_SPECS[item.paneIndex] != null
  ) {
    return PANE_SPECS[item.paneIndex].name as PaneId;
  }
  return 'candle';
}

export function loadDrawings(code: string): Drawing[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(code));
  } catch {
    return [];
  }
  if (raw == null) return [];
  let parsed: Wrapper;
  try {
    parsed = JSON.parse(raw) as Wrapper;
  } catch {
    return [];
  }
  if (parsed == null || parsed.v !== VERSION) return [];
  if (!Array.isArray(parsed.items)) return [];
  return (parsed.items as LegacyItem[]).map((item) => {
    const { paneIndex: _ignored, ...rest } = item;
    void _ignored;
    return { ...rest, paneId: resolvePaneId(item) } as Drawing;
  });
}

export function saveDrawings(code: string, items: Drawing[]): void {
  const wrapper: Wrapper = { v: VERSION, items };
  try {
    localStorage.setItem(storageKey(code), JSON.stringify(wrapper));
  } catch {
    // Quota exceeded or storage unavailable — ignore. Drawings remain in
    // memory; user simply loses them on reload.
  }
}
```

- [ ] **Step 2.4: Run the migration tests — expect green**

Run: `cd frontend && npx vitest run src/chart/drawing/persistence.test.ts`
Expected: all tests PASS.

- [ ] **Step 2.5: Run full frontend tests — expect green**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 2.6: Commit**

```bash
git add frontend/src/chart/drawing/persistence.ts \
        frontend/src/chart/drawing/persistence.test.ts
git commit -m "feat(drawing): backfill legacy paneId on persistence load

Drawings written before Task 1 (no paneId) and dev-branch writes that
used numeric paneIndex both resolve to a stable PaneId on load. v=1
unchanged (superset migration).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: chartCoordinates — `PaneSeriesMap` + signature change

**Files:**
- Modify: `frontend/src/chart/drawing/chartCoordinates.ts`
- Modify: `frontend/src/chart/drawing/render.ts` (callers)
- Modify: `frontend/src/chart/DrawingOverlay.tsx` (callers)

Coordinate helpers now take a `Map<PaneId, ISeriesApi>` and a `paneId` argument instead of a single `priceSeries`. This task swaps the contract; downstream callers (render, overlay) are updated to compile but their behaviour still matches the old single-pane code because every call passes `paneId: 'candle'` for now. Tasks 5 and 6 fix the callers properly.

- [ ] **Step 3.1: Replace `chartCoordinates.ts` with the pane-aware version**

Replace the entire contents of `frontend/src/chart/drawing/chartCoordinates.ts` with:

```ts
// frontend/src/chart/drawing/chartCoordinates.ts
//
// Chart Coordinates — pixel ↔ (realMs, price) conversions for the Drawing
// Overlay. Every Y-conversion is pane-aware: the caller supplies a paneId
// that identifies which pane's price scale to use. The Y returned by
// lightweight-charts already includes the pane's vertical offset, so the
// canvas Y can be used verbatim.
//
// PaneSeriesMap is owned by ChartStage; each RangeSeriesPane registers
// its first (primary) series on mount and clears it on unmount.

import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import { PANE_SPECS } from '../paneSpecs';
import type { PaneId, Point } from './types';

export type PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>;

/** PANE_SPECS lookup: PaneId → numeric paneIndex (lightweight-charts API).
 *  Built once at module load; PANE_SPECS is a module-level constant so a
 *  static cache is safe. */
const PANE_ID_TO_INDEX: ReadonlyMap<PaneId, number> = (() => {
  const m = new Map<PaneId, number>();
  PANE_SPECS.forEach((spec, idx) => m.set(spec.name as PaneId, idx));
  return m;
})();

export function paneIdToIndex(paneId: PaneId): number {
  const idx = PANE_ID_TO_INDEX.get(paneId);
  if (idx == null) {
    // Should be unreachable — PaneId literals mirror PANE_SPECS exactly.
    // Returning 0 keeps rendering alive (the drawing visually lands on the
    // candle pane) instead of throwing during a redraw frame.
    return 0;
  }
  return idx;
}

/**
 * Real Unix-ms → canvas X. Time axis is shared across panes.
 * Returns null when `realMs` falls outside every Virtual Axis segment.
 */
export function realMsToCanvasX(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
): number | null {
  if (!axis.contains(realMs)) return null;
  const virtualMs = axis.toVirtual(realMs);
  const x = chart.timeScale().timeToCoordinate((virtualMs / 1000) as UTCTimestamp);
  return x == null ? null : (x as number);
}

/**
 * Price → canvas Y for the pane identified by `paneId`. Returns null when
 * that pane's primary series isn't registered (e.g. pane removed from
 * PANE_SPECS) or the price falls outside the series' visible price range.
 */
export function priceToCanvasY(
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  price: number,
): number | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const y = series.priceToCoordinate(price);
  return y == null ? null : Number(y);
}

/**
 * Pixel (px, py) → domain Point (realMs, price) for the pane identified
 * by `paneId`. Returns null when the time or price axis cannot resolve.
 */
export function pixelToData(
  chart: IChartApi,
  axis: VirtualAxis,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  px: number,
  py: number,
): Point | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const timeSec = chart.timeScale().coordinateToTime(px);
  if (timeSec == null) return null;
  const virtualMs = (timeSec as number) * 1000;
  const realMs = axis.toReal(virtualMs);
  const price = series.coordinateToPrice(py);
  if (price == null) return null;
  return { realMs, price: Number(price) };
}

/**
 * Cursor pixel Y → PaneId of the pane the cursor is inside. Falls back to
 * the last pane when py is beyond the chart bottom; falls back to the
 * first pane when py < 0 (matches lightweight-charts' top-down stacking).
 */
export function paneIdAtY(chart: IChartApi, py: number): PaneId {
  const panes = chart.panes();
  if (panes.length === 0 || py < 0) {
    return (PANE_SPECS[0].name as PaneId);
  }
  let cursor = 0;
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (py >= cursor && py < cursor + h) {
      return (PANE_SPECS[i]?.name as PaneId) ?? (PANE_SPECS[0].name as PaneId);
    }
    cursor += h;
  }
  return (PANE_SPECS[panes.length - 1]?.name as PaneId)
    ?? (PANE_SPECS[0].name as PaneId);
}

/**
 * Clamp a pixel Y to the vertical span of `paneId`'s pane. Used by tools
 * during creation drag and by body-translate so a Drawing started in one
 * pane never escapes into another.
 */
export function clampYToPane(chart: IChartApi, paneId: PaneId, py: number): number {
  const panes = chart.panes();
  const idx = paneIdToIndex(paneId);
  let top = 0;
  for (let i = 0; i < idx && i < panes.length; i++) top += panes[i].getHeight();
  const h = panes[idx]?.getHeight() ?? 0;
  const bottom = top + h;
  return Math.max(top, Math.min(bottom - 1, py));
}
```

- [ ] **Step 3.2: Update `render.ts` ProjectCtx to compile against the new signatures**

Edit `frontend/src/chart/drawing/render.ts`. Change the import block (top 10 lines) and `ProjectCtx`:

```ts
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { Drawing, Hline, Pencil, Trendline, PaneId } from './types';
import {
  type PaneSeriesMap,
  priceToCanvasY,
  realMsToCanvasX,
} from './chartCoordinates';

export type ProjectCtx = {
  chart: IChartApi;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  paneId: PaneId;
  width: number;
  height: number;
};
```

Then update `priceToY` (currently at line 24):

```ts
function priceToY(ctx: ProjectCtx, price: number): number | null {
  return priceToCanvasY(ctx.paneSeries, ctx.paneId, price);
}
```

`realMsToX`, `setStroke`, `drawHaloThenMain`, badge helpers, and per-kind renderers stay unchanged because they receive the resolved `ctx` and call the helpers indirectly.

- [ ] **Step 3.3: Update `render.test.ts` to build the new `ProjectCtx`**

Edit `frontend/src/chart/drawing/render.test.ts`. Wherever the test builds a `ProjectCtx`, change the `priceSeries` field to a `paneSeries` map + `paneId: 'candle'`:

```ts
const priceSeries = {
  priceToCoordinate: vi.fn((p: number) => 300 - p * 0.01),
  coordinateToPrice: vi.fn(),
} as any;

const ctx: ProjectCtx = {
  chart: {} as IChartApi,
  axis: { contains: () => true, toVirtual: (ms: number) => ms } as any,
  paneSeries: new Map([['candle', priceSeries]]),
  paneId: 'candle',
  width: 800,
  height: 400,
};
```

Apply this transformation in every test in the file that constructs a `ProjectCtx`.

- [ ] **Step 3.4: Update `DrawingOverlay.tsx` to compile against the new signatures**

`DrawingOverlay.tsx` currently calls `projPixelToData(chart, axis, priceSeries, px, py)` etc. This task is a temporary shim — we hard-code `'candle'` as the `paneId` everywhere so the file compiles. Task 7 will replace these with the real pane-aware logic.

Edit `frontend/src/chart/DrawingOverlay.tsx`:

1. Change the imports at the top:
   ```ts
   import { useDrawingsStore } from '../state/drawings';
   import { renderDrawing, type ProjectCtx } from './drawing/render';
   import type { Drawing, PaneId } from './drawing/types';
   import { HIT_THRESHOLD } from './drawing/types';
   import {
     pixelToData as projPixelToData,
     priceToCanvasY as projPriceToCanvasY,
     realMsToCanvasX as projRealMsToCanvasX,
     type PaneSeriesMap,
   } from './drawing/chartCoordinates';
   ```

2. Change the Props type:
   ```ts
   type Props = {
     chart: IChartApi;
     axis: VirtualAxis;
     /** PaneId → primary series. Empty until the first pane registers. */
     paneSeries: PaneSeriesMap;
   };

   export default function DrawingOverlay({ chart, axis, paneSeries }: Props) {
   ```

3. Update the draw loop's `projCtx`:
   ```ts
   const projCtx: ProjectCtx = {
     chart, axis, paneSeries, paneId: 'candle', width: w, height: h,
   };
   ```

4. Update the coordinate helper closures (search for `projPixelToData`, `projRealMsToCanvasX`, `projPriceToCanvasY`):
   ```ts
   const pixelToData = (px: number, py: number) =>
     projPixelToData(chart, axis, paneSeries, 'candle', px, py);
   const realMsToCanvasX = (realMs: number) => projRealMsToCanvasX(chart, axis, realMs);
   const priceToCanvasY = (price: number) => projPriceToCanvasY(paneSeries, 'candle', price);
   ```

These hard-coded `'candle'` references are eliminated in Task 7.

- [ ] **Step 3.5: Update `ChartStage.tsx` to pass an empty PaneSeriesMap (temporary)**

Edit `frontend/src/chart/ChartStage.tsx`. At the line near 307 where `candleSeries` is declared, leave it for now (Task 5 removes it) but **also** add an empty paneSeries map and pass it to `DrawingOverlay`:

Find:
```ts
<DrawingOverlay chart={chart} axis={axis} priceSeries={candleSeries} />
```

Replace with:
```ts
{/* Task 5 populates this map; for now the overlay falls back to no-series
    behaviour identical to the empty-priceSeries state in main. */}
<DrawingOverlay chart={chart} axis={axis} paneSeries={EMPTY_PANE_SERIES} />
```

And add at top of `ChartStage.tsx`:
```ts
import type { PaneSeriesMap } from './drawing/chartCoordinates';

const EMPTY_PANE_SERIES: PaneSeriesMap = new Map();
```

If `candleSeries` is declared but the only consumer (DrawingOverlay) no longer uses it, suppress the unused-var lint by replacing the destructure target with `setCandleSeries` only where needed. (Task 5 deletes it cleanly — for now leave it, the lint may warn, this is intentional.)

- [ ] **Step 3.6: Run type-check + tests**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

Run: `cd frontend && npm test`
Expected: PASS — render tests now drive the pane-aware ProjectCtx; persistence tests unchanged; tools/translate tests unchanged.

- [ ] **Step 3.7: Commit**

```bash
git add frontend/src/chart/drawing/chartCoordinates.ts \
        frontend/src/chart/drawing/render.ts \
        frontend/src/chart/drawing/render.test.ts \
        frontend/src/chart/DrawingOverlay.tsx \
        frontend/src/chart/ChartStage.tsx
git commit -m "refactor(drawing): chartCoordinates takes PaneSeriesMap + paneId

Y-conversion helpers now route through a PaneId-keyed series registry;
callers temporarily pass paneId='candle' to keep behaviour identical to
main. Task 7 will dispatch on real cursor pane. Adds paneIdToIndex /
paneIdAtY / clampYToPane helpers ready for Task 4 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: paneDispatch unit tests

**Files:**
- Create: `frontend/src/chart/drawing/paneDispatch.test.ts`

Dedicated tests for the three pane-dispatch helpers added in Task 3.

- [ ] **Step 4.1: Write the failing test file**

Create `frontend/src/chart/drawing/paneDispatch.test.ts`:

```ts
// frontend/src/chart/drawing/paneDispatch.test.ts
//
// Unit tests for paneIdToIndex / paneIdAtY / clampYToPane. The first is
// a static PANE_SPECS lookup; the latter two depend on a live
// chart.panes() call so we stub IChartApi.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import {
  paneIdToIndex,
  paneIdAtY,
  clampYToPane,
} from './chartCoordinates';
import { PANE_SPECS } from '../paneSpecs';
import type { PaneId } from './types';

/** Build a stub IChartApi whose panes() returns objects with the given
 *  heights, in PANE_SPECS order. */
function chartWithHeights(heights: number[]): IChartApi {
  return {
    panes: vi.fn(() => heights.map((h) => ({ getHeight: () => h }))),
  } as unknown as IChartApi;
}

describe('paneIdToIndex', () => {
  it('resolves every PaneId literal back to its PANE_SPECS index', () => {
    for (let i = 0; i < PANE_SPECS.length; i++) {
      const id = PANE_SPECS[i].name as PaneId;
      expect(paneIdToIndex(id)).toBe(i);
    }
  });
});

describe('paneIdAtY', () => {
  // Realistic layout: candle 400, volume 80, ratio 80, quote-totals 80, fill-strength 80
  const heights = [400, 80, 80, 80, 80];

  it('returns candle for py inside pane 0', () => {
    expect(paneIdAtY(chartWithHeights(heights), 0)).toBe('candle');
    expect(paneIdAtY(chartWithHeights(heights), 200)).toBe('candle');
    expect(paneIdAtY(chartWithHeights(heights), 399)).toBe('candle');
  });

  it('returns volume for py inside pane 1', () => {
    expect(paneIdAtY(chartWithHeights(heights), 400)).toBe('volume');
    expect(paneIdAtY(chartWithHeights(heights), 479)).toBe('volume');
  });

  it('returns ratio for py inside pane 2', () => {
    expect(paneIdAtY(chartWithHeights(heights), 480)).toBe('ratio');
  });

  it('clamps to last pane when py is past the chart bottom', () => {
    expect(paneIdAtY(chartWithHeights(heights), 9999)).toBe('fill-strength');
  });

  it('clamps to first pane when py is negative', () => {
    expect(paneIdAtY(chartWithHeights(heights), -10)).toBe('candle');
  });
});

describe('clampYToPane', () => {
  const heights = [400, 80, 80, 80, 80];
  const chart = chartWithHeights(heights);

  it('passes through a py inside the candle pane unchanged', () => {
    expect(clampYToPane(chart, 'candle', 250)).toBe(250);
  });

  it('clamps a py above the volume pane to the volume top', () => {
    expect(clampYToPane(chart, 'volume', 100)).toBe(400);
  });

  it('clamps a py below the volume pane to volume bottom - 1', () => {
    // volume occupies [400, 480); the clamp returns 479 at the lower edge.
    expect(clampYToPane(chart, 'volume', 600)).toBe(479);
  });

  it('clamps a py inside ratio that strays into quote-totals', () => {
    // ratio occupies [480, 560); a py at 600 is in quote-totals -> clamp to 559.
    expect(clampYToPane(chart, 'ratio', 600)).toBe(559);
  });

  it('passes a py exactly at pane top through', () => {
    expect(clampYToPane(chart, 'volume', 400)).toBe(400);
  });
});
```

- [ ] **Step 4.2: Run the tests — expect green (helpers already exist from Task 3)**

Run: `cd frontend && npx vitest run src/chart/drawing/paneDispatch.test.ts`
Expected: PASS — all helpers were already defined in Task 3.

- [ ] **Step 4.3: Commit**

```bash
git add frontend/src/chart/drawing/paneDispatch.test.ts
git commit -m "test(drawing): unit tests for paneIdToIndex / paneIdAtY / clampYToPane

Direct coverage of the pane-dispatch helpers introduced in Task 3.
Stubs IChartApi.panes() to drive the cumulative-height arithmetic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: ChartStage primary-series registry

**Files:**
- Modify: `frontend/src/chart/RangeSeriesPane.tsx`
- Modify: `frontend/src/chart/ChartStage.tsx`

Each `RangeSeriesPane` reports its first (primary) series to a parent-owned registry. ChartStage maintains a `Map<PaneId, ISeriesApi>` and passes it to `DrawingOverlay`. The legacy `candleSeries` `useState` is removed because its sole consumer (DrawingOverlay) now reads from the registry.

- [ ] **Step 5.1: Add primary-series callbacks to `RangeSeriesPane.tsx`**

Edit `frontend/src/chart/RangeSeriesPane.tsx`. Update the `Props` type and the lifecycle effect:

Find the `Props` type (around line 37) and replace with:
```ts
type Props<Ctx> = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex: number;
  spec: PaneSpec<Ctx>;
  /** Fired after the primary series (spec.series[0]) is added to the chart.
   *  ChartStage uses this to populate its PaneId→ISeriesApi registry that
   *  DrawingOverlay consumes for pane-aware coordinate conversion. */
  onPrimarySeriesReady?: (series: ISeriesApi<any>) => void;
  /** Fired right before the primary series is removed from the chart
   *  (component unmount or spec change). */
  onPrimarySeriesGone?: () => void;
};
```

Find the lifecycle `useEffect` (the one calling `chart.addSeries`) and update it:
```ts
useEffect(() => {
  const seriesList: ISeriesApi<any>[] = spec.series.map((s) => {
    const series = chart.addSeries(s.type, s.options, paneIndex);
    s.afterAdd?.(series);
    return series;
  });
  seriesRef.current = seriesList;
  if (seriesList.length > 0) onPrimarySeriesReady?.(seriesList[0]);
  return () => {
    if (seriesList.length > 0) onPrimarySeriesGone?.();
    for (const series of seriesList) {
      try {
        chart.removeSeries(series);
      } catch {
        // chart already torn down
      }
    }
    seriesRef.current = [];
  };
  // onPrimarySeriesReady / onPrimarySeriesGone identities are stable on
  // the parent (ChartStage uses `useCallback`); intentionally excluded
  // from deps so the effect doesn't churn series on callback re-creation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [chart, paneIndex, spec]);
```

Pull `onPrimarySeriesReady` / `onPrimarySeriesGone` out of the destructured `Props` at the top of the function:
```ts
export default function RangeSeriesPane<Ctx>({
  chart,
  bundle,
  axis,
  paneIndex,
  spec,
  onPrimarySeriesReady,
  onPrimarySeriesGone,
}: Props<Ctx>) {
```

- [ ] **Step 5.2: Build the registry in `ChartStage.tsx` and wire each pane**

Edit `frontend/src/chart/ChartStage.tsx`. Replace the `EMPTY_PANE_SERIES` stub (added in Task 3) with a real `useRef` + `useState` pair so React re-renders the overlay when the map changes:

Add near the top of the component body (right after `const [chart, setChart] = useState<IChartApi | null>(null);` or similar):

```ts
import { useCallback } from 'react';  // ensure useCallback is imported
import type { PaneId } from './drawing/types';

// inside the component:
const [paneSeries, setPaneSeries] = useState<Map<PaneId, ISeriesApi<any>>>(
  () => new Map(),
);

const registerPaneSeries = useCallback((paneId: PaneId, series: ISeriesApi<any>) => {
  setPaneSeries((prev) => {
    const next = new Map(prev);
    next.set(paneId, series);
    return next;
  });
}, []);

const unregisterPaneSeries = useCallback((paneId: PaneId) => {
  setPaneSeries((prev) => {
    if (!prev.has(paneId)) return prev;
    const next = new Map(prev);
    next.delete(paneId);
    return next;
  });
}, []);
```

Then update the `PANE_SPECS.map` JSX block (around line 368):

```tsx
{PANE_SPECS.map((spec, paneIndex) => (
  <div key={spec.name} data-pane={spec.name} className="hidden">
    <RangeSeriesPane
      chart={chart}
      bundle={bundle}
      axis={axis}
      paneIndex={paneIndex}
      spec={spec}
      onPrimarySeriesReady={(s) => registerPaneSeries(spec.name as PaneId, s)}
      onPrimarySeriesGone={() => unregisterPaneSeries(spec.name as PaneId)}
    />
  </div>
))}
```

Update the `DrawingOverlay` JSX line — replace the `EMPTY_PANE_SERIES` reference with `paneSeries`:
```tsx
<DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeries} />
```

Delete the `candleSeries` `useState` (line ~307) and the `setCandleSeries` callback used by the candle pane's `RangeSeriesPane`. The candle pane's primary-series registration now flows through the same `registerPaneSeries` path. Remove the `EMPTY_PANE_SERIES` constant added in Step 3.5.

If `candleSeries` is referenced anywhere outside that file, grep first and update those call sites:
```bash
grep -rn 'candleSeries' frontend/src
```
Expected to be empty after deletion.

- [ ] **Step 5.3: Run type-check + tests**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS.

Run: `cd frontend && npm test`
Expected: PASS — no test exercises the ChartStage wiring directly; downstream tests use `priceSeries` stubs in the map.

- [ ] **Step 5.4: Manual smoke test — backend + frontend running**

Per `CLAUDE.md` Dev Servers section, start backend and frontend in the background:

```bash
# Terminal 1
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga &

# Terminal 2
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4/frontend
npm run dev &
```

Open `http://localhost:5173/replay`. Draw an hline on the candle pane. Expected: hline appears and persists across reload (same behaviour as `main`). The registry is silent in the UI; the smoke test verifies it doesn't break the candle path.

- [ ] **Step 5.5: Commit**

```bash
git add frontend/src/chart/RangeSeriesPane.tsx frontend/src/chart/ChartStage.tsx
git commit -m "feat(chart): primary-series registry keyed by PaneId

Each RangeSeriesPane reports its first series to ChartStage on mount.
ChartStage owns a Map<PaneId, ISeriesApi> and passes it to
DrawingOverlay. Removes the candleSeries useState — the registry now
holds the candle series under paneId='candle' too. Drawing behaviour
on the candle pane is unchanged for this commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: tools.ts — paneId stamping + creation clamp + draft.paneId

**Files:**
- Modify: `frontend/src/chart/drawing/tools.ts`
- Modify: `frontend/src/chart/drawing/tools.test.ts`

Tools now resolve a `paneId` from the pointer-down Y, stamp it on the new Drawing, and clamp Y to that pane for the rest of the gesture. Drafts carry the resolved `paneId` so the overlay can clip the preview correctly (Task 7 uses it).

- [ ] **Step 6.1: Extend `ToolCtx` and drafts in `tools.ts`**

Edit `frontend/src/chart/drawing/tools.ts`. Update imports at top:
```ts
import {
  type Drawing,
  type DrawingTool,
  type PaneId,
  type Point,
  PENCIL_MAX_POINTS,
  HIT_THRESHOLD,
} from './types';
import { translateDrawing } from './translate';
```

Update the draft types to carry `paneId`:
```ts
export type TrendlineDraft = { a: Point; pointerId: number; paneId: PaneId };

export type PencilDraft = {
  points: Point[];
  pointerId: number;
  lastFrame: number;
  paneId: PaneId;
};

export type DragMode =
  | {
      kind: 'body';
      id: string;
      lastRealMs: number;
      lastPrice: number;
      pointerId: number;
      paneId: PaneId;
    }
  | { kind: 'handle'; id: string; endpoint: 'a' | 'b'; pointerId: number; paneId: PaneId };
```

Update `ToolCtx` — add two new helpers and change `pixelToData` / `priceToCanvasY` to accept an optional `paneId` override (defaults to candle for backwards-compat with select-mode handle drag which already finds the drawing's paneId via the target):
```ts
export type ToolCtx = {
  px: number;
  py: number;
  pointerId: number;
  capturePointer(): void;
  releasePointer(): void;

  /** Convert (px, py) → (realMs, price) using `paneId`'s price scale. */
  pixelToData(px: number, py: number, paneId: PaneId): Point | null;
  realMsToCanvasX(realMs: number): number | null;
  /** Convert a stored price to a canvas Y using `paneId`'s price scale. */
  priceToCanvasY(price: number, paneId: PaneId): number | null;
  hitTestAt(px: number, py: number): Drawing | null;

  /** PaneId of the pane the cursor is currently in. */
  paneIdAtY(py: number): PaneId;
  /** Clamp a pixel Y to the vertical span of the given pane. */
  clampYToPane(paneId: PaneId, py: number): number;

  drawings: readonly Drawing[];
  selectedId: string | null;
  accentColor: string;

  trendlineDraft: Ref<TrendlineDraft | null>;
  pencilDraft: Ref<PencilDraft | null>;
  dragRef: Ref<DragMode | null>;

  requestRedraw(): void;
  add(d: Drawing): void;
  update(id: string, patch: Partial<Drawing>): void;
  remove(id: string): void;
  setSelected(id: string | null): void;
  commitAndRevert(id: string): void;
};
```

- [ ] **Step 6.2: Update each tool to use `paneId` and clamp**

In `selectTool`:
```ts
export const selectTool: DrawingToolSpec = {
  kind: 'select',
  label: '선택',
  glyph: '↶',
  cursor: 'default',
  shortcut: { alt: true, key: 'v' },
  onPointerDown(ctx) {
    const selected = ctx.selectedId
      ? ctx.drawings.find((d) => d.id === ctx.selectedId)
      : null;
    if (selected && selected.kind === 'trendline') {
      const xa = ctx.realMsToCanvasX(selected.a.realMs);
      const ya = ctx.priceToCanvasY(selected.a.price, selected.paneId);
      const xb = ctx.realMsToCanvasX(selected.b.realMs);
      const yb = ctx.priceToCanvasY(selected.b.price, selected.paneId);
      if (xa != null && ya != null && Math.hypot(ctx.px - xa, ctx.py - ya) <= HIT_THRESHOLD.trendlineHandle) {
        ctx.dragRef.current = {
          kind: 'handle',
          id: selected.id,
          endpoint: 'a',
          pointerId: ctx.pointerId,
          paneId: selected.paneId,
        };
        ctx.capturePointer();
        return;
      }
      if (xb != null && yb != null && Math.hypot(ctx.px - xb, ctx.py - yb) <= HIT_THRESHOLD.trendlineHandle) {
        ctx.dragRef.current = {
          kind: 'handle',
          id: selected.id,
          endpoint: 'b',
          pointerId: ctx.pointerId,
          paneId: selected.paneId,
        };
        ctx.capturePointer();
        return;
      }
    }
    const hit = ctx.hitTestAt(ctx.px, ctx.py);
    ctx.setSelected(hit?.id ?? null);
    if (hit) {
      const data = ctx.pixelToData(ctx.px, ctx.py, hit.paneId);
      if (!data) return;
      ctx.dragRef.current = {
        kind: 'body',
        id: hit.id,
        lastRealMs: data.realMs,
        lastPrice: data.price,
        pointerId: ctx.pointerId,
        paneId: hit.paneId,
      };
      ctx.capturePointer();
    }
  },
  onPointerMove(ctx) {
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(drag.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, drag.paneId);
    if (!data) return;
    const target = ctx.drawings.find((d) => d.id === drag.id);
    if (!target) return;
    if (drag.kind === 'handle' && target.kind === 'trendline') {
      const patch = drag.endpoint === 'a' ? { a: data } : { b: data };
      ctx.update(target.id, patch as Partial<Drawing>);
      return;
    }
    if (drag.kind === 'body') {
      const dMs = data.realMs - drag.lastRealMs;
      const dPrice = data.price - drag.lastPrice;
      ctx.update(target.id, translateDrawing(target, dMs, dPrice));
      drag.lastRealMs = data.realMs;
      drag.lastPrice = data.price;
    }
  },
  onPointerUp(ctx) {
    const drag = ctx.dragRef.current;
    if (!drag || drag.pointerId !== ctx.pointerId) return;
    ctx.dragRef.current = null;
    ctx.releasePointer();
  },
};
```

In `hlineTool`:
```ts
export const hlineTool: DrawingToolSpec = {
  kind: 'hline',
  label: '수평선',
  glyph: '━',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'h' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'hline',
      price: data.price,
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
      paneId,
    });
    ctx.commitAndRevert(id);
  },
};
```

In `trendlineTool`:
```ts
export const trendlineTool: DrawingToolSpec = {
  kind: 'trendline',
  label: '추세선',
  glyph: '╱',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 't' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.trendlineDraft.current = { a: data, pointerId: ctx.pointerId, paneId };
    ctx.capturePointer();
  },
  onPointerUp(ctx) {
    const draft = ctx.trendlineDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    ctx.trendlineDraft.current = null;
    ctx.releasePointer();
    if (!data) return;
    if (data.realMs === draft.a.realMs && data.price === draft.a.price) return;
    const id = nanoid(8);
    ctx.add({
      id,
      kind: 'trendline',
      a: draft.a,
      b: data,
      color: ctx.accentColor,
      width: DRAWING_WIDTH,
      paneId: draft.paneId,
    });
    ctx.commitAndRevert(id);
  },
};
```

In `pencilTool`:
```ts
export const pencilTool: DrawingToolSpec = {
  kind: 'pencil',
  label: '연필',
  glyph: '✎',
  cursor: 'crosshair',
  shortcut: { alt: true, key: 'p' },
  onPointerDown(ctx) {
    const paneId = ctx.paneIdAtY(ctx.py);
    const data = ctx.pixelToData(ctx.px, ctx.py, paneId);
    if (!data) return;
    ctx.pencilDraft.current = {
      points: [data],
      pointerId: ctx.pointerId,
      lastFrame: 0,
      paneId,
    };
    ctx.capturePointer();
  },
  onPointerMove(ctx) {
    const draft = ctx.pencilDraft.current;
    if (!draft || draft.pointerId !== ctx.pointerId) return;
    const now = performance.now();
    if (now - draft.lastFrame < 16) return;
    draft.lastFrame = now;
    const clampedY = ctx.clampYToPane(draft.paneId, ctx.py);
    const data = ctx.pixelToData(ctx.px, clampedY, draft.paneId);
    if (!data) return;
    if (draft.points.length >= PENCIL_MAX_POINTS) return;
    draft.points.push(data);
    ctx.requestRedraw();
  },
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
      paneId: draft.paneId,
    });
    ctx.commitAndRevert(id);
  },
};
```

`eraserTool` is unchanged — it already calls `hitTestAt` + `remove`.

- [ ] **Step 6.3: Update `tools.test.ts` ctx builder and add pane-aware tests**

Edit `frontend/src/chart/drawing/tools.test.ts`. Update `makeCtx` to provide the new helpers:

```ts
function makeCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const defaultPoint: Point = { realMs: 1_700_000_000_000, price: 70_000 };
  const base: ToolCtx = {
    px: 100,
    py: 200,
    pointerId: 1,
    capturePointer: vi.fn(),
    commitAndRevert: vi.fn(),
    releasePointer: vi.fn(),
    pixelToData: vi.fn((_px: number, _py: number, _paneId: 'candle' | 'volume' | 'ratio' | 'quote-totals' | 'fill-strength') => defaultPoint),
    realMsToCanvasX: vi.fn(() => 100),
    priceToCanvasY: vi.fn(() => 200),
    hitTestAt: vi.fn(() => null),
    paneIdAtY: vi.fn(() => 'candle' as const),
    clampYToPane: vi.fn((_id, py) => py),
    drawings: [],
    selectedId: null,
    accentColor: '#14B8A6',
    trendlineDraft: { current: null },
    pencilDraft: { current: null },
    dragRef: { current: null },
    requestRedraw: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setSelected: vi.fn(),
  };
  return { ...base, ...overrides };
}
```

Existing tests that call `ctx.priceToCanvasY(p)` or `ctx.pixelToData(px, py)` will fail to compile — update each call to pass the appropriate `paneId` (typically `'candle'` in legacy tests).

Add new tests at the end of the file:

```ts
describe('pane stamping', () => {
  it('hlineTool stamps the paneId resolved from cursor Y', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'ratio' as const),
    });
    hlineTool.onPointerDown!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.paneId).toBe('ratio');
  });

  it('trendlineTool stamps the paneId of pointer-down on both endpoints (by draft.paneId)', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'volume' as const),
      pixelToData: vi.fn(() => ({ realMs: 1_700_000_000_000, price: 1000 })),
    });
    trendlineTool.onPointerDown!(ctx);
    // Simulate move-then-up; pixelToData returns the same fixed point but
    // realMs differs so the zero-length guard doesn't fire — bump it.
    (ctx.pixelToData as ReturnType<typeof vi.fn>).mockReturnValue({
      realMs: 1_700_000_001_000,
      price: 2000,
    });
    trendlineTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.paneId).toBe('volume');
  });

  it('pencilTool stamps the paneId of pointer-down on the new drawing', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'fill-strength' as const),
    });
    pencilTool.onPointerDown!(ctx);
    (ctx.pixelToData as ReturnType<typeof vi.fn>).mockReturnValue({
      realMs: 1_700_000_001_000,
      price: 0.5,
    });
    // Force at least 2 points so the commit branch fires.
    pencilTool.onPointerMove!({
      ...ctx,
      // Bypass the 16ms throttle by stubbing performance.now indirectly
      // via the draft.lastFrame already at 0.
    });
    pencilTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.paneId).toBe('fill-strength');
  });
});

describe('cross-pane drag clamp', () => {
  it('trendline drag clamps Y to the start pane before resolving b.price', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'volume' as const),
      clampYToPane: vi.fn((_id, _py) => 470), // simulate clamp to volume bottom-1
      pixelToData: vi.fn((px, py, paneId) => ({
        realMs: 1_700_000_000_000,
        price: paneId === 'volume' && py === 470 ? 100 : -999,
      })),
    });
    trendlineTool.onPointerDown!(ctx);
    // Cursor leaves volume pane on move; the up-handler should clamp.
    ctx.py = 9999;
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.clampYToPane).toHaveBeenCalledWith('volume', 9999);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Drawing | undefined;
    // The trendline either committed with the clamped price OR was rejected
    // by the zero-length guard (a===b). Both states satisfy "cursor leaving
    // the pane never produces a wrong-pane drawing".
    if (added && added.kind === 'trendline') {
      expect(added.b.price).toBe(100);
      expect(added.paneId).toBe('volume');
    }
  });
});
```

- [ ] **Step 6.4: Run tests — expect green**

Run: `cd frontend && npx vitest run src/chart/drawing/tools.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add frontend/src/chart/drawing/tools.ts frontend/src/chart/drawing/tools.test.ts \
        frontend/src/chart/drawing/types.ts
git commit -m "feat(drawing): tools stamp paneId on creation and clamp drag

hline / trendline / pencil resolve a paneId via ctx.paneIdAtY at
pointer-down and stamp it on the new Drawing. Subsequent move/up
clamps Y to the start pane so a drag never escapes into another
pane's Y domain. Drafts carry paneId so Task 7 can clip the preview.
selectTool's drag (body + handle) also carries paneId for consistency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: translate.ts — body-translate clamp

**Files:**
- Modify: `frontend/src/chart/drawing/translate.ts`
- Modify: `frontend/src/chart/drawing/translate.test.ts`
- Modify: `frontend/src/chart/drawing/tools.ts` (selectTool body branch)

When the select tool body-drags a drawing, the Δprice must be limited so the drawing's bounding box stays inside its origin pane. The drag is already clamped in *pixel* space (Task 6), but pixel clamping doesn't survive the round-trip through `pixelToData` because lightweight-charts maps the clamped Y back to a price near the pane edge — which after `translateDrawing` could still push the drawing across the boundary if the original drawing already touched the edge. To guarantee the invariant we also clamp at the price-domain layer.

For this v1 we keep the geometry simple: translate as today, then if the result would push the drawing's min/max price outside the pane's current visible range we drop the dy past that bound. We expose a `clampTranslate` helper that the selectTool body branch consumes.

- [ ] **Step 7.1: Write failing test for body-drag clamp**

Add to `frontend/src/chart/drawing/translate.test.ts`:

```ts
import { clampHlinePriceWithinPane } from './translate';

describe('clampHlinePriceWithinPane', () => {
  it('passes a price inside [paneTopPrice, paneBottomPrice] through unchanged', () => {
    expect(clampHlinePriceWithinPane(1000, { top: 2000, bottom: 0 })).toBe(1000);
  });

  it('clamps a price above the pane top to the top', () => {
    expect(clampHlinePriceWithinPane(3000, { top: 2000, bottom: 0 })).toBe(2000);
  });

  it('clamps a price below the pane bottom to the bottom', () => {
    expect(clampHlinePriceWithinPane(-50, { top: 2000, bottom: 0 })).toBe(0);
  });

  it('tolerates inverted bounds (Y-axis flipped) by sorting internally', () => {
    expect(clampHlinePriceWithinPane(1000, { top: 0, bottom: 2000 })).toBe(1000);
    expect(clampHlinePriceWithinPane(3000, { top: 0, bottom: 2000 })).toBe(2000);
  });
});
```

- [ ] **Step 7.2: Run the test — expect failure**

Run: `cd frontend && npx vitest run src/chart/drawing/translate.test.ts -t 'clampHlinePriceWithinPane'`
Expected: FAIL — `clampHlinePriceWithinPane` not exported.

- [ ] **Step 7.3: Add `clampHlinePriceWithinPane` to `translate.ts`**

Append to `frontend/src/chart/drawing/translate.ts`:

```ts
/**
 * Clamp a target price to the inclusive range bounded by the two
 * "edge prices" of a pane. The pane's price scale may run top-down
 * (top > bottom; standard for prices) or bottom-up (rare); we sort
 * internally so callers can pass either.
 *
 * Used by selectTool's body-drag branch to keep an Hline / Trendline
 * vertex from leaving the origin pane after a drag. Translation
 * remains a pure (Δprice) math; the caller composes this clamp
 * around the result.
 */
export function clampHlinePriceWithinPane(
  price: number,
  bounds: { top: number; bottom: number },
): number {
  const lo = Math.min(bounds.top, bounds.bottom);
  const hi = Math.max(bounds.top, bounds.bottom);
  return Math.max(lo, Math.min(hi, price));
}
```

- [ ] **Step 7.4: Run the test — expect green**

Run: `cd frontend && npx vitest run src/chart/drawing/translate.test.ts`
Expected: all PASS.

- [ ] **Step 7.5: Use the clamp inside selectTool's body-drag branch**

Edit `frontend/src/chart/drawing/tools.ts`. Import the new helper and the per-kind type narrowers used in the body-clamp switch below:
```ts
import { translateDrawing, clampHlinePriceWithinPane } from './translate';
```

If the existing imports don't already pull `Hline`, `Trendline`, `Pencil` from `./types`, extend the imports block:
```ts
import {
  type Drawing,
  type DrawingTool,
  type Hline,
  type Pencil,
  type Trendline,
  type PaneId,
  type Point,
  PENCIL_MAX_POINTS,
  HIT_THRESHOLD,
} from './types';
```

Update the body-drag branch in `selectTool.onPointerMove`:

```ts
if (drag.kind === 'body') {
  const dMs = data.realMs - drag.lastRealMs;
  const dPrice = data.price - drag.lastPrice;
  const rawPatch = translateDrawing(target, dMs, dPrice);

  // Post-clamp each price-bearing vertex so the drawing cannot leave its
  // origin pane. priceBoundsForPane returns the prices at the pane's top
  // and bottom pixels (lightweight-charts' coordinateToPrice on the
  // registered series).
  const paneBounds = ctx.priceBoundsForPane(drag.paneId);
  const patch: Partial<Drawing> = (() => {
    if (!paneBounds) return rawPatch;
    if (target.kind === 'hline') {
      const p = rawPatch as Partial<Hline>;
      return typeof p.price === 'number'
        ? { price: clampHlinePriceWithinPane(p.price, paneBounds) }
        : rawPatch;
    }
    if (target.kind === 'trendline') {
      const p = rawPatch as Partial<Trendline>;
      if (!p.a || !p.b) return rawPatch;
      return {
        a: { ...p.a, price: clampHlinePriceWithinPane(p.a.price, paneBounds) },
        b: { ...p.b, price: clampHlinePriceWithinPane(p.b.price, paneBounds) },
      };
    }
    if (target.kind === 'pencil') {
      const p = rawPatch as Partial<Pencil>;
      if (!p.points) return rawPatch;
      return {
        points: p.points.map((pt) => ({
          ...pt,
          price: clampHlinePriceWithinPane(pt.price, paneBounds),
        })),
      };
    }
    return rawPatch;
  })();

  ctx.update(target.id, patch);
  drag.lastRealMs = data.realMs;
  drag.lastPrice = data.price;
}
```

- [ ] **Step 7.6: Add `priceBoundsForPane` to `ToolCtx`**

In `tools.ts`, extend `ToolCtx`:
```ts
/** Domain price values at the top and bottom of `paneId`'s pane, derived
 *  from the registered series' coordinateToPrice at the pane's top/bottom
 *  pixels. Returns null if the pane or its series isn't mounted. */
priceBoundsForPane(paneId: PaneId): { top: number; bottom: number } | null;
```

Update the test `makeCtx`:
```ts
priceBoundsForPane: vi.fn(() => ({ top: 100_000, bottom: 0 })),
```

- [ ] **Step 7.7: Run all tests — expect green**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 7.8: Commit**

```bash
git add frontend/src/chart/drawing/translate.ts \
        frontend/src/chart/drawing/translate.test.ts \
        frontend/src/chart/drawing/tools.ts \
        frontend/src/chart/drawing/tools.test.ts
git commit -m "feat(drawing): body-drag clamps Drawing inside its origin pane

selectTool's body-drag now post-clamps each price-bearing vertex in
the patch via clampHlinePriceWithinPane, sourcing pane bounds from a
new ToolCtx.priceBoundsForPane helper. A drag toward another pane
stops at the origin pane's edge instead of warping price to a
nonsense value or letting the Drawing visually escape the clip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: DrawingOverlay — per-drawing clip, hit-test filter, draft clip, real ctx

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

The overlay is the integration point. Replaces the hard-coded `'candle'` placeholders from Task 3 with real per-drawing pane awareness, implements per-drawing clip in the draw loop, filters hit-test by cursor pane, and provides the new ToolCtx helpers (`paneIdAtY`, `clampYToPane`, `priceBoundsForPane`).

- [ ] **Step 8.1: Rewrite `DrawingOverlay.tsx`**

Replace the entire contents of `frontend/src/chart/DrawingOverlay.tsx` with the version below. The redraw effect's per-drawing clip, the hit-test pane filter, the new context fields, and the draft preview clip are all in this single file.

```tsx
// frontend/src/chart/DrawingOverlay.tsx
//
// Pane-aware Drawing Overlay. See:
//   - docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md
//   - docs/adr/0028-drawing-pane-binding.md

import { useEffect, useMemo, useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, type ProjectCtx } from './drawing/render';
import type { Drawing, PaneId } from './drawing/types';
import { HIT_THRESHOLD } from './drawing/types';
import { distanceToHline, distanceToPolyline, distanceToSegment } from './drawing/hitTest';
import {
  TOOLS,
  matchShortcut,
  type DragMode,
  type PencilDraft,
  type ToolCtx,
  type TrendlineDraft,
} from './drawing/tools';
import {
  pixelToData as projPixelToData,
  priceToCanvasY as projPriceToCanvasY,
  realMsToCanvasX as projRealMsToCanvasX,
  paneIdToIndex,
  paneIdAtY as projPaneIdAtY,
  clampYToPane as projClampYToPane,
  type PaneSeriesMap,
} from './drawing/chartCoordinates';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = { accent: ['--accent', '#14B8A6'] } as const;

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
};

export default function DrawingOverlay({ chart, axis, paneSeries }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeTool = useDrawingsStore((s) => s.activeTool);
  const activeCode = useDrawingsStore((s) => s.activeCode);
  const drawings = useDrawingsStore((s) =>
    s.activeCode == null ? [] : (s.byCode.get(s.activeCode) ?? []),
  );
  const selectedId = useDrawingsStore((s) => s.selectedId);

  const accentColor = useMemo(() => resolveTokens(TOKEN_SPEC).accent, []);

  const trendlineDraft = useRef<TrendlineDraft | null>(null);
  const pencilDraft = useRef<PencilDraft | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  const scheduleRef = useRef<() => void>(() => {});

  // ── redraw loop ────────────────────────────────────────────────────────
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const c = canvas.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      const panes = chart.panes();
      const paneTops: number[] = [];
      {
        let acc = 0;
        for (const p of panes) {
          paneTops.push(acc);
          acc += p.getHeight();
        }
      }

      const clipAndRender = (paneId: PaneId, body: (ctx: ProjectCtx) => void) => {
        const idx = paneIdToIndex(paneId);
        if (idx >= panes.length) return;
        const top = paneTops[idx];
        const paneH = panes[idx].getHeight();
        c.save();
        c.beginPath();
        c.rect(0, top, w, paneH);
        c.clip();
        const projCtx: ProjectCtx = {
          chart, axis, paneSeries, paneId, width: w, height: h,
        };
        body(projCtx);
        c.restore();
      };

      for (const d of drawings) {
        if (!paneSeries.has(d.paneId)) continue;  // pane absent → silent skip
        clipAndRender(d.paneId, (projCtx) => {
          renderDrawing(c, projCtx, d, d.id === selectedId);
        });
      }

      // Live pencil draft preview — clipped to its origin pane.
      const draft = pencilDraft.current;
      if (draft && draft.points.length >= 2) {
        clipAndRender(draft.paneId, (projCtx) => {
          renderDrawing(
            c,
            projCtx,
            {
              id: '__draft__',
              kind: 'pencil',
              points: draft.points,
              color: accentColor,
              width: 1.5,
              paneId: draft.paneId,
            },
            false,
          );
        });
      }
    };

    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, axis, paneSeries, drawings, selectedId, activeCode, accentColor]);

  // ── keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
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

  // Coordinate helpers — pane-aware closures.
  const pixelToData = (px: number, py: number, paneId: PaneId) =>
    projPixelToData(chart, axis, paneSeries, paneId, px, py);
  const realMsToCanvasX = (realMs: number) => projRealMsToCanvasX(chart, axis, realMs);
  const priceToCanvasY = (price: number, paneId: PaneId) =>
    projPriceToCanvasY(paneSeries, paneId, price);
  const paneIdAtY = (py: number) => projPaneIdAtY(chart, py);
  const clampYToPane = (paneId: PaneId, py: number) =>
    projClampYToPane(chart, paneId, py);

  const priceBoundsForPane = (paneId: PaneId) => {
    const series = paneSeries.get(paneId);
    if (!series) return null;
    const idx = paneIdToIndex(paneId);
    const panes = chart.panes();
    if (idx >= panes.length) return null;
    let top = 0;
    for (let i = 0; i < idx; i++) top += panes[i].getHeight();
    const bottom = top + panes[idx].getHeight();
    const topPrice = series.coordinateToPrice(top);
    const bottomPrice = series.coordinateToPrice(bottom);
    if (topPrice == null || bottomPrice == null) return null;
    return { top: Number(topPrice), bottom: Number(bottomPrice) };
  };

  const hitTestAt = (px: number, py: number): Drawing | null => {
    const cursorPaneId = projPaneIdAtY(chart, py);
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.paneId !== cursorPaneId) continue;
      if (d.kind === 'hline') {
        const y = priceToCanvasY(d.price, d.paneId);
        if (y != null && distanceToHline({ x: px, y: py }, y) <= HIT_THRESHOLD.hline) return d;
      } else if (d.kind === 'trendline') {
        const xa = realMsToCanvasX(d.a.realMs);
        const ya = priceToCanvasY(d.a.price, d.paneId);
        const xb = realMsToCanvasX(d.b.realMs);
        const yb = priceToCanvasY(d.b.price, d.paneId);
        if (xa != null && ya != null && xb != null && yb != null &&
            distanceToSegment({ x: px, y: py }, { x: xa, y: ya }, { x: xb, y: yb }) <= HIT_THRESHOLD.trendlineBody) {
          return d;
        }
      } else if (d.kind === 'pencil') {
        const poly: { x: number; y: number }[] = [];
        for (const pt of d.points) {
          const x = realMsToCanvasX(pt.realMs);
          const y = priceToCanvasY(pt.price, d.paneId);
          if (x != null && y != null) poly.push({ x, y });
        }
        if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) return d;
      }
    }
    return null;
  };

  const buildCtx = (e: React.PointerEvent<HTMLDivElement>): ToolCtx => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const target = e.currentTarget as HTMLDivElement;
    return {
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
      pointerId: e.pointerId,
      capturePointer: () => target.setPointerCapture(e.pointerId),
      releasePointer: () => target.releasePointerCapture(e.pointerId),
      pixelToData,
      realMsToCanvasX,
      priceToCanvasY,
      hitTestAt,
      paneIdAtY,
      clampYToPane,
      priceBoundsForPane,
      drawings,
      selectedId,
      accentColor,
      trendlineDraft,
      pencilDraft,
      dragRef,
      requestRedraw: () => scheduleRef.current(),
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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerDown?.(buildCtx(e));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerMove?.(buildCtx(e));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    TOOLS[activeTool].onPointerUp?.(buildCtx(e));
  };

  // ── pointer-events gating ──────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (activeTool !== 'select') {
      container.style.pointerEvents = 'auto';
      return;
    }
    container.style.pointerEvents = 'none';
    const onHover = (e: MouseEvent) => {
      if (dragRef.current) return;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const hit =
        px >= 0 && py >= 0 && px <= rect.width && py <= rect.height
          ? hitTestAt(px, py)
          : null;
      container.style.pointerEvents = hit ? 'auto' : 'none';
    };
    window.addEventListener('mousemove', onHover);
    return () => {
      window.removeEventListener('mousemove', onHover);
    };
    // hitTestAt closes over drawings / paneSeries; re-bind on change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, drawings, paneSeries, axis]);

  return (
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
```

- [ ] **Step 8.2: Run type-check + tests**

Run: `cd frontend && npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 8.3: Commit**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "feat(drawing): per-drawing clip + pane-filtered hit-test + draft clip

DrawingOverlay now clips each Drawing to its own paneId's pane rect
and renders the pencil/trendline draft preview into the start pane's
clip. Hit-test filters by cursor paneId so no Drawing on pane X is
reachable from pane Y. Wires the new ToolCtx fields (paneIdAtY,
clampYToPane, priceBoundsForPane).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Manual verification in the browser

**Files:** none — this is interactive validation.

Confirms every spec-listed manual scenario works end-to-end.

- [ ] **Step 9.1: Start backend + frontend hot-reload servers**

Per `CLAUDE.md` Dev Servers section:

```bash
# Backend (Terminal 1)
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga

# Frontend (Terminal 2)
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4/frontend
[ -d node_modules ] || npm install
npm run dev
```

Wait for backend "Application startup complete." and frontend "ready in" log lines.

- [ ] **Step 9.2: Legacy drawings survive checkout**

If you have an active candle-pane hline saved on `main` for some `code`:
- Switch to `main`, open `/replay`, draw an hline, reload to confirm it persists.
- Switch back to this worktree branch, hard-reload `/replay`, same `code`.
- Expected: the hline still renders on the candle pane (paneId backfilled to `'candle'`).

If no such drawing exists, simulate by injecting one into `localStorage` from the browser devtools:
```js
localStorage.setItem('replay.drawings.v1.005930', JSON.stringify({
  v: 1,
  items: [{ id: 'legacy', kind: 'hline', price: 75000, color: '#14B8A6', width: 1.5 }],
}));
```
Reload `/replay` for code `005930`. Expected: the hline renders on the candle pane.

- [ ] **Step 9.3: Indicator-pane hline**

- Press `Alt+H` to activate hline tool.
- Click inside the volume pane.
- Expected: a horizontal line appears inside the volume pane, with a price badge showing the share-count value at the cursor. Active tool reverts to `select`, line is selected.
- Reload `/replay`. Expected: the hline reappears on the volume pane.

- [ ] **Step 9.4: Ratio-pane trendline with cross-pane drag**

- Press `Alt+T` to activate trendline tool.
- Mouse-down inside the ratio pane.
- Drag the cursor down through quote-totals and fill-strength panes.
- Release pointer.
- Expected: a trendline with both endpoints inside the ratio pane appears. The endpoint nearest the cursor stops at the ratio pane's bottom edge regardless of how far the cursor moved.

- [ ] **Step 9.5: Cross-pane tool-switch flow**

- `Alt+H`, click candle pane → hline lands on candle.
- `Alt+H`, click volume pane → hline lands on volume.
- `Alt+H`, click ratio pane → hline lands on ratio.
- Expected: each `paneId` is correct after reload (verify via devtools `localStorage.getItem('replay.drawings.v1.<code>')`).

- [ ] **Step 9.6: Select + delete on an indicator-pane drawing**

- Press `Alt+V` (select tool).
- Click an indicator-pane hline → it becomes selected (highlighted halo).
- Press `Delete`.
- Expected: the hline disappears. Reload — it stays gone.

- [ ] **Step 9.7: Body-translate clamp**

- Draw an hline near the bottom of the volume pane.
- Switch to select tool (auto-reverted on commit).
- Drag the hline downward, past the volume pane's bottom edge into ratio.
- Expected: the hline stops at the volume pane's bottom edge — never crosses into ratio.

- [ ] **Step 9.8: Resize chart container**

- Drag the browser window edges to shrink/grow the chart.
- Expected: all pane drawings re-render at the correct positions on their respective panes; no clipping artifacts.

- [ ] **Step 9.9: lightweight-charts pane Y assumption (spike from spec's Open Risks)**

In devtools console while `/replay` is open:
```js
const chart = document.querySelector('[data-pane="volume"]') /* ...find the chart instance via React devtools; or expose a window.__chart in dev mode */;
// Alternative: pause at a breakpoint inside DrawingOverlay's draw loop.
// Verify that priceToCoordinate on the volume series returns a Y inside
// [paneTops[1], paneTops[1] + panes[1].getHeight()] — i.e. chart-global Y.
```
If the assumption fails, this is the moment to escalate — open an issue and pause Task 9 sign-off until the projection is corrected (the fallback is to add `paneTops[idx]` to every Y in `priceToCanvasY`).

- [ ] **Step 9.10: Commit any minor fixes from manual testing**

If steps 9.1-9.9 surfaced small adjustments, commit them with messages prefixed `fix(drawing):` referencing the scenario that broke. If nothing broke, this step is a no-op.

---

## Self-review notes (for the executing agent)

After completing all tasks, before declaring done:

- [ ] Confirm every spec section is implemented. Scan
  `docs/superpowers/specs/2026-05-24-drawing-on-indicator-panes-design.md`
  section by section.
- [ ] Confirm no test was deleted (only modified to add `paneId`).
- [ ] Run `cd frontend && npm test` one final time. Expected: PASS.
- [ ] Run `cd frontend && npx tsc --noEmit`. Expected: PASS.
- [ ] `git log --oneline` should show one commit per Task (9 total),
  each green at the time of commit.
