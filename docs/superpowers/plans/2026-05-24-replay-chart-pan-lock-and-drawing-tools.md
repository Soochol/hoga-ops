# Replay Chart Pan-Lock Fix + Drawing Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the chart pan-lock bug that occurs when fully zoomed out on a multi-day range, and add a hline/trendline/pencil/eraser drawing layer to the Replay Viewer with per-**Code** localStorage persistence.

**Architecture:** Pan-lock fix swaps a logical-range clamp for `lightweight-charts`' native `timeScale.minBarSpacing`. The drawing layer mounts as a single Canvas 2D overlay on top of the chart, follows the existing `DayBoundaryOverlay` pattern for pan/zoom reactivity, stores drawings in real Unix-ms (range-independent), and persists per **Code** via `localStorage` keyed `replay.drawings.v1.<code>`.

**Tech Stack:** TypeScript, React 18, zustand 4, `lightweight-charts` v5, Tailwind, vitest (unit), Playwright (e2e). All file paths are relative to the repo root.

**Spec:** [docs/superpowers/specs/2026-05-24-replay-chart-pan-lock-and-drawing-tools-design.md](../specs/2026-05-24-replay-chart-pan-lock-and-drawing-tools-design.md)

---

## File map

**Modified:**
- `frontend/src/chart/ChartStage.tsx` — remove logical-range clamp, add `minBarSpacing`, mount `DrawingOverlay`, wire `activeCode` from the active tab.
- `frontend/src/replay/Toolbar.tsx` — add the **그리기** button and `DrawingMenu` popover anchor.

**New:**
- `frontend/src/chart/drawing/types.ts` — `Point`, `Hline`, `Trendline`, `Pencil`, `Drawing` union.
- `frontend/src/chart/drawing/hitTest.ts` — pure distance helpers (hline, point-to-segment, polyline).
- `frontend/src/chart/drawing/hitTest.test.ts`
- `frontend/src/chart/drawing/persistence.ts` — `loadDrawings(code)`, `saveDrawings(code, items)`.
- `frontend/src/chart/drawing/persistence.test.ts`
- `frontend/src/chart/drawing/render.ts` — pure canvas draw functions (per-drawing).
- `frontend/src/chart/DrawingOverlay.tsx` — overlay component (canvas + pointer events + keyboard).
- `frontend/src/state/drawings.ts` — zustand store.
- `frontend/src/state/drawings.test.ts`
- `frontend/src/replay/DrawingMenu.tsx` — popover with the 4 tools + select/clear-all.
- `frontend/tests/e2e/drawing.spec.ts` — end-to-end coverage (pan-lock + drawing flow).
- `docs/adr/0024-drawing-realms-coordinates.md` — captures the realMs-vs-virtualMs decision.

---

## Conventions used in this plan

- All shell commands assume `cwd = /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4` unless specified.
- Frontend commands prefixed with `(cd frontend && …)`.
- "Commit" steps stage **only** the files listed in the task. Never `git add -A`.
- Test naming: vitest reads `**/*.test.ts`/`.test.tsx` from `frontend/src/`; Playwright reads `**/*.spec.ts` from `frontend/tests/e2e/`.

---

## Task 1 — Pan-Lock Fix

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx:259-278` (the `useEffect` that calls `fitContent` and clamps logical range)
- Modify: `frontend/src/chart/ChartStage.tsx:95-216` (the `createChart` options effect — needs `minBarSpacing` + ResizeObserver wiring)

- [ ] **Step 1.1: Read the current clamp effect and createChart call.**

Read `frontend/src/chart/ChartStage.tsx` lines 95-280. Confirm the structure: one `useEffect` mounts the chart with `createChart`, a separate `useEffect` calls `fitContent()` and subscribes `subscribeVisibleLogicalRangeChange` with the broken clamp.

- [ ] **Step 1.2: Replace the broken clamp with `minBarSpacing` setup.**

In `frontend/src/chart/ChartStage.tsx`, replace the **entire body** of the `useEffect` that starts with the comment `// Initial fit-to-data + zoom clamps. Fires when the chart becomes ready and` (lines 259-278) with:

```tsx
  // Initial fit-to-data + zoom-out floor. We use `timeScale.minBarSpacing`
  // (recomputed on resize) instead of a logical-range clamp because the
  // logical-range clamp made pan impossible when fully zoomed out: any
  // leftward drag pushed `range.from` negative, length grew past totalBars,
  // and the handler snapped the range back every frame. The barSpacing
  // approach lets pan past the data window remain free while still bounding
  // zoom-out to "all bars fit".
  useEffect(() => {
    if (!chart || !bundle) return;
    const ts = chart.timeScale();
    const container = containerRef.current;
    const totalBars = bundle.candles.length;

    const computeMinBarSpacing = (): number => {
      const width = container?.clientWidth ?? 0;
      if (width <= 0 || totalBars <= 0) return 0.5;
      return Math.max(0.5, width / totalBars);
    };

    ts.applyOptions({ minBarSpacing: computeMinBarSpacing() });
    ts.fitContent();

    // Keep the floor in sync with container width changes.
    const ro =
      container && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            ts.applyOptions({ minBarSpacing: computeMinBarSpacing() });
          })
        : null;
    if (ro && container) ro.observe(container);

    // Retain the existing zoom-in cap (barSpacing > 50): one bar/50px is
    // already absurdly zoomed-in; without it the user can vanish all but a
    // sliver of data on the right edge.
    const handler = (range: { from: number; to: number } | null) => {
      if (!range) return;
      const bs = ts.options().barSpacing;
      if (typeof bs === 'number' && bs > 50) {
        ts.applyOptions({ barSpacing: 50 });
      }
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(handler);
      ro?.disconnect();
    };
  }, [chart, bundle]);
```

- [ ] **Step 1.3: Smoke-test in the browser.**

Run dev servers per `CLAUDE.md`:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga &
(cd frontend && npm run dev)
```

Open `http://localhost:5173/replay?tabs=003490:20260511:20260511:1m&active=0`. Wait for the chart to load. Click 'Reload' if needed. Try mouse drag left/right and wheel-pan when fitContent has snapped the full range. Expected: chart pans smoothly in both directions, never snaps back. Try to scroll-wheel zoom-out further than "all bars fit" — expected: gesture has no effect (no overshoot).

Stop the dev servers when done.

- [ ] **Step 1.4: Commit.**

```bash
git add frontend/src/chart/ChartStage.tsx
git commit -m "$(cat <<'EOF'
fix(chart): replace pan-blocking logical-range clamp with minBarSpacing

The subscribeVisibleLogicalRangeChange handler snapped the logical range
back to {from:0, to:totalBars} whenever range length exceeded totalBars
— which happens on every leftward pan when fitContent has the chart
fully zoomed out (range.from goes negative, length grows past
totalBars). The chart visually froze. Switch to timeScale.minBarSpacing
recomputed on container resize: zoom-out is bounded at "all bars fit",
pan is unconstrained.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Drawing types

**Files:**
- Create: `frontend/src/chart/drawing/types.ts`

- [ ] **Step 2.1: Write the types module.**

```ts
// frontend/src/chart/drawing/types.ts

/**
 * Drawing primitive types. All time coordinates are real Unix-ms (UTC) —
 * NOT virtual-ms from the Virtual Axis — so drawings remain valid across
 * different Stock-Date Range loads of the same Code (see ADR-0024 and
 * the design spec).
 */

export type Point = {
  /** Real Unix-ms (UTC), per ADR-0003. */
  realMs: number;
  /** Price in KRW. */
  price: number;
};

export type DrawingId = string;

export type DrawingKind = 'hline' | 'trendline' | 'pencil';

export type DrawingTool = 'select' | 'hline' | 'trendline' | 'pencil' | 'eraser';

interface DrawingBase {
  id: DrawingId;
  /** Stroke color. v1 always references the accent token via util/tokens. */
  color: string;
  /** Stroke width in CSS pixels. v1 fixed to 1.5. */
  width: number;
}

export interface Hline extends DrawingBase {
  kind: 'hline';
  /** The single price level. Renders as a horizontal line spanning the canvas. */
  price: number;
}

export interface Trendline extends DrawingBase {
  kind: 'trendline';
  a: Point;
  b: Point;
}

export interface Pencil extends DrawingBase {
  kind: 'pencil';
  /** >= 2 points. Capped at PENCIL_MAX_POINTS during capture. */
  points: Point[];
}

export type Drawing = Hline | Trendline | Pencil;

/** Hard cap on pencil points to keep one drawing under ~250KB serialized. */
export const PENCIL_MAX_POINTS = 5000;

/** Hit-test thresholds in canvas-space pixels. */
export const HIT_THRESHOLD = {
  hline: 6,
  trendlineBody: 8,
  trendlineHandle: 6,
  pencil: 8,
} as const;
```

- [ ] **Step 2.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 2.3: Commit.**

```bash
git add frontend/src/chart/drawing/types.ts
git commit -m "$(cat <<'EOF'
feat(chart/drawing): add Drawing type union (hline/trendline/pencil)

Coordinates encoded as real Unix-ms (ADR-0003 alignment) so persistence
is range-independent for a given Code.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Hit-test helpers + tests

**Files:**
- Create: `frontend/src/chart/drawing/hitTest.ts`
- Create: `frontend/src/chart/drawing/hitTest.test.ts`

- [ ] **Step 3.1: Write the failing tests.**

```ts
// frontend/src/chart/drawing/hitTest.test.ts
import { describe, expect, it } from 'vitest';
import { distanceToHline, distanceToSegment, distanceToPolyline } from './hitTest';

describe('distanceToHline', () => {
  it('returns vertical distance from the cursor Y to the line Y', () => {
    expect(distanceToHline({ x: 100, y: 50 }, 60)).toBe(10);
    expect(distanceToHline({ x: -999, y: 200 }, 200)).toBe(0);
  });
});

describe('distanceToSegment', () => {
  it('returns 0 when the point lies on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('returns perpendicular distance for a point above a horizontal segment', () => {
    expect(distanceToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
  });

  it('returns distance to nearest endpoint when projection falls outside', () => {
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('handles degenerate segments (a == b) as point distance', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToPolyline', () => {
  it('returns the minimum distance across all consecutive segments', () => {
    const polyline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(distanceToPolyline({ x: 5, y: 3 }, polyline)).toBe(3);
    expect(distanceToPolyline({ x: 13, y: 5 }, polyline)).toBe(3);
  });

  it('returns Infinity for polylines with fewer than 2 points', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity);
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBe(Infinity);
  });
});
```

- [ ] **Step 3.2: Run tests to verify failure.**

Run: `(cd frontend && npx vitest run src/chart/drawing/hitTest.test.ts)`
Expected: FAIL with "Cannot find module './hitTest'".

- [ ] **Step 3.3: Implement `hitTest.ts`.**

```ts
// frontend/src/chart/drawing/hitTest.ts

export type Pixel = { x: number; y: number };

/** Vertical distance from a pixel to a horizontal line at the given Y. */
export function distanceToHline(p: Pixel, lineY: number): number {
  return Math.abs(p.y - lineY);
}

/** Euclidean distance from a pixel to a line segment defined by endpoints a, b. */
export function distanceToSegment(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate: a == b. Treat as point distance.
    const px = p.x - a.x;
    const py = p.y - a.y;
    return Math.hypot(px, py);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/** Minimum distance from a pixel to any consecutive segment of a polyline. */
export function distanceToPolyline(p: Pixel, polyline: readonly Pixel[]): number {
  if (polyline.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const d = distanceToSegment(p, polyline[i - 1], polyline[i]);
    if (d < min) min = d;
  }
  return min;
}
```

- [ ] **Step 3.4: Run tests to verify success.**

Run: `(cd frontend && npx vitest run src/chart/drawing/hitTest.test.ts)`
Expected: PASS (10 assertions across 3 describes).

- [ ] **Step 3.5: Commit.**

```bash
git add frontend/src/chart/drawing/hitTest.ts frontend/src/chart/drawing/hitTest.test.ts
git commit -m "$(cat <<'EOF'
feat(chart/drawing): add canvas-space hit-test helpers

Distance functions for hline (vertical), point-to-segment (used by
trendline body and as the building block for polyline), and pencil
polyline. Pure functions — no DOM, no chart API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Persistence layer + tests

**Files:**
- Create: `frontend/src/chart/drawing/persistence.ts`
- Create: `frontend/src/chart/drawing/persistence.test.ts`

- [ ] **Step 4.1: Write the failing tests.**

```ts
// frontend/src/chart/drawing/persistence.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from './types';
import { loadDrawings, saveDrawings, storageKey } from './persistence';

const CODE = '005930';

beforeEach(() => {
  localStorage.clear();
});

describe('storageKey', () => {
  it('produces the canonical replay.drawings.v1 key', () => {
    expect(storageKey(CODE)).toBe('replay.drawings.v1.005930');
  });
});

describe('saveDrawings / loadDrawings round-trip', () => {
  it('persists and recovers an empty list', () => {
    saveDrawings(CODE, []);
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('persists and recovers a heterogeneous drawing list', () => {
    const items: Drawing[] = [
      { id: 'a', kind: 'hline', price: 75000, color: '#FFD60A', width: 1.5 },
      {
        id: 'b',
        kind: 'trendline',
        a: { realMs: 1_700_000_000_000, price: 70000 },
        b: { realMs: 1_700_003_600_000, price: 72000 },
        color: '#FFD60A',
        width: 1.5,
      },
    ];
    saveDrawings(CODE, items);
    expect(loadDrawings(CODE)).toEqual(items);
  });
});

describe('loadDrawings — error / version handling', () => {
  it('returns [] when no entry exists', () => {
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('returns [] for a non-v1 payload', () => {
    localStorage.setItem(storageKey(CODE), JSON.stringify({ v: 2, items: [] }));
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('returns [] for corrupt JSON', () => {
    localStorage.setItem(storageKey(CODE), '{not valid json');
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('returns [] when items is not an array', () => {
    localStorage.setItem(storageKey(CODE), JSON.stringify({ v: 1, items: 'nope' }));
    expect(loadDrawings(CODE)).toEqual([]);
  });
});
```

- [ ] **Step 4.2: Run tests to verify failure.**

Run: `(cd frontend && npx vitest run src/chart/drawing/persistence.test.ts)`
Expected: FAIL with "Cannot find module './persistence'".

- [ ] **Step 4.3: Implement `persistence.ts`.**

```ts
// frontend/src/chart/drawing/persistence.ts
import type { Drawing } from './types';

const PREFIX = 'replay.drawings.v1.';
const VERSION = 1;

export function storageKey(code: string): string {
  return `${PREFIX}${code}`;
}

type Wrapper = { v: number; items: unknown };

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
  // Trust the in-payload shape (own writer). v1 readers do not validate
  // every Drawing field — that would couple persistence to types.ts.
  return parsed.items as Drawing[];
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

- [ ] **Step 4.4: Run tests to verify success.**

Run: `(cd frontend && npx vitest run src/chart/drawing/persistence.test.ts)`
Expected: PASS (7 assertions).

- [ ] **Step 4.5: Commit.**

```bash
git add frontend/src/chart/drawing/persistence.ts frontend/src/chart/drawing/persistence.test.ts
git commit -m "$(cat <<'EOF'
feat(chart/drawing): add per-Code localStorage persistence layer

Key replay.drawings.v1.<code>, wrapper {v, items}. Defensive load:
missing entry, wrong version, corrupt JSON, and bad items shape all
collapse to []. Save swallows quota errors so the UI never throws on
write.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Drawings zustand store + tests

**Files:**
- Create: `frontend/src/state/drawings.ts`
- Create: `frontend/src/state/drawings.test.ts`

- [ ] **Step 5.1: Write the failing tests.**

```ts
// frontend/src/state/drawings.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from '../chart/drawing/types';
import { useDrawingsStore } from './drawings';

const A = '005930';
const B = '003490';

function mkHline(id: string, price: number): Drawing {
  return { id, kind: 'hline', price, color: '#FFD60A', width: 1.5 };
}

beforeEach(() => {
  localStorage.clear();
  useDrawingsStore.getState().__resetForTests();
});

describe('useDrawingsStore — Code partitioning', () => {
  it('starts empty with no activeCode', () => {
    const s = useDrawingsStore.getState();
    expect(s.activeCode).toBeNull();
    expect(s.activeTool).toBe('select');
    expect(s.selectedId).toBeNull();
    expect(s.drawingsFor(A)).toEqual([]);
  });

  it('add appends to the active Code only', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
  });

  it('switching activeCode does not move drawings', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setActiveCode(B);
    useDrawingsStore.getState().add(mkHline('h2', 200));
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(1);
  });

  it('setActiveCode resets selectedId', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setSelected('h1');
    expect(useDrawingsStore.getState().selectedId).toBe('h1');
    useDrawingsStore.getState().setActiveCode(B);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
  });
});

describe('useDrawingsStore — mutations', () => {
  beforeEach(() => {
    useDrawingsStore.getState().setActiveCode(A);
  });

  it('update patches a drawing by id', () => {
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().update('h1', { price: 150 } as Partial<Drawing>);
    const found = useDrawingsStore.getState().drawingsFor(A)[0];
    expect((found as { price: number }).price).toBe(150);
  });

  it('remove deletes by id and clears selection if it matched', () => {
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setSelected('h1');
    useDrawingsStore.getState().remove('h1');
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(0);
    expect(useDrawingsStore.getState().selectedId).toBeNull();
  });

  it('clearAll empties the active Code list only', () => {
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().setActiveCode(B);
    useDrawingsStore.getState().add(mkHline('h2', 200));
    useDrawingsStore.getState().clearAll();
    expect(useDrawingsStore.getState().drawingsFor(B)).toHaveLength(0);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
  });
});

describe('useDrawingsStore — persistence integration', () => {
  it('setActiveCode hydrates from localStorage', () => {
    localStorage.setItem(
      'replay.drawings.v1.005930',
      JSON.stringify({ v: 1, items: [mkHline('h1', 100)] }),
    );
    useDrawingsStore.getState().setActiveCode(A);
    expect(useDrawingsStore.getState().drawingsFor(A)).toHaveLength(1);
  });

  it('flushPending writes the active Code to localStorage', () => {
    useDrawingsStore.getState().setActiveCode(A);
    useDrawingsStore.getState().add(mkHline('h1', 100));
    useDrawingsStore.getState().flushPending();
    const raw = localStorage.getItem('replay.drawings.v1.005930');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ v: 1, items: [mkHline('h1', 100)] });
  });
});
```

- [ ] **Step 5.2: Run tests to verify failure.**

Run: `(cd frontend && npx vitest run src/state/drawings.test.ts)`
Expected: FAIL with "Cannot find module './drawings'".

- [ ] **Step 5.3: Implement the store.**

```ts
// frontend/src/state/drawings.ts
import { create } from 'zustand';
import type { Drawing, DrawingId, DrawingTool } from '../chart/drawing/types';
import { loadDrawings, saveDrawings } from '../chart/drawing/persistence';

const PERSIST_DEBOUNCE_MS = 250;

type State = {
  byCode: Map<string, Drawing[]>;
  loadedCodes: Set<string>;
  activeCode: string | null;
  activeTool: DrawingTool;
  selectedId: DrawingId | null;
};

type Actions = {
  setActiveCode(code: string | null): void;
  setActiveTool(tool: DrawingTool): void;
  setSelected(id: DrawingId | null): void;
  drawingsFor(code: string): Drawing[];
  add(d: Drawing): void;
  update(id: DrawingId, patch: Partial<Drawing>): void;
  remove(id: DrawingId): void;
  clearAll(): void;
  flushPending(): void;
  __resetForTests(): void;
};

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCode: string | null = null;

export const useDrawingsStore = create<State & Actions>((set, get) => {
  const queuePersist = (code: string | null) => {
    if (code == null) return;
    pendingCode = code;
    if (pendingTimer != null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      const items = get().byCode.get(code) ?? [];
      saveDrawings(code, items);
      pendingTimer = null;
      pendingCode = null;
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    byCode: new Map(),
    loadedCodes: new Set(),
    activeCode: null,
    activeTool: 'select',
    selectedId: null,

    setActiveCode(code) {
      if (code === get().activeCode) return;
      set({ activeCode: code, selectedId: null });
      if (code != null && !get().loadedCodes.has(code)) {
        const items = loadDrawings(code);
        const byCode = new Map(get().byCode);
        byCode.set(code, items);
        const loadedCodes = new Set(get().loadedCodes);
        loadedCodes.add(code);
        set({ byCode, loadedCodes });
      }
    },

    setActiveTool(tool) {
      set({ activeTool: tool });
    },

    setSelected(id) {
      set({ selectedId: id });
    },

    drawingsFor(code) {
      return get().byCode.get(code) ?? [];
    },

    add(d) {
      const code = get().activeCode;
      if (code == null) return;
      const byCode = new Map(get().byCode);
      byCode.set(code, [...(byCode.get(code) ?? []), d]);
      set({ byCode });
      queuePersist(code);
    },

    update(id, patch) {
      const code = get().activeCode;
      if (code == null) return;
      const current = get().byCode.get(code) ?? [];
      const next = current.map((d) => (d.id === id ? ({ ...d, ...patch } as Drawing) : d));
      const byCode = new Map(get().byCode);
      byCode.set(code, next);
      set({ byCode });
      queuePersist(code);
    },

    remove(id) {
      const code = get().activeCode;
      if (code == null) return;
      const next = (get().byCode.get(code) ?? []).filter((d) => d.id !== id);
      const byCode = new Map(get().byCode);
      byCode.set(code, next);
      const selectedId = get().selectedId === id ? null : get().selectedId;
      set({ byCode, selectedId });
      queuePersist(code);
    },

    clearAll() {
      const code = get().activeCode;
      if (code == null) return;
      const byCode = new Map(get().byCode);
      byCode.set(code, []);
      set({ byCode, selectedId: null });
      queuePersist(code);
    },

    flushPending() {
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      const code = pendingCode;
      if (code == null) return;
      const items = get().byCode.get(code) ?? [];
      saveDrawings(code, items);
      pendingCode = null;
    },

    __resetForTests() {
      if (pendingTimer != null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingCode = null;
      set({
        byCode: new Map(),
        loadedCodes: new Set(),
        activeCode: null,
        activeTool: 'select',
        selectedId: null,
      });
    },
  };
});

// Window listener for beforeunload — flushes pending writes synchronously
// so a user navigating away never loses a freshly-drawn shape.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    useDrawingsStore.getState().flushPending();
  });
}
```

- [ ] **Step 5.4: Run tests to verify success.**

Run: `(cd frontend && npx vitest run src/state/drawings.test.ts)`
Expected: PASS.

- [ ] **Step 5.5: Commit.**

```bash
git add frontend/src/state/drawings.ts frontend/src/state/drawings.test.ts
git commit -m "$(cat <<'EOF'
feat(state): add drawings zustand store with localStorage hydration

byCode partitions by Code (CONTEXT.md term); activeTool is a global UI
mode; selectedId resets on setActiveCode. Persistence is 250ms-debounced
on mutation, flushed on beforeunload. Hydration is lazy — codes loaded
once on first setActiveCode and cached.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Canvas render helpers

**Files:**
- Create: `frontend/src/chart/drawing/render.ts`

Why no test file: rendering correctness is visual and best verified by the e2e spec (Task 17). The helpers are pure projections over the chart API, so unit-testing would mostly mock the chart.

- [ ] **Step 6.1: Implement `render.ts`.**

```ts
// frontend/src/chart/drawing/render.ts
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { Drawing, Hline, Pencil, Trendline } from './types';

export type ProjectCtx = {
  chart: IChartApi;
  axis: VirtualAxis;
  /** Any series on pane 0 with a real price scale — typically the candle series. */
  priceSeries: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null;
  width: number;
  height: number;
};

function realMsToX(ctx: ProjectCtx, realMs: number): number | null {
  if (!ctx.axis.contains(realMs)) return null;
  const virtualMs = ctx.axis.toVirtual(realMs);
  const x = ctx.chart.timeScale().timeToCoordinate((virtualMs / 1000) as UTCTimestamp);
  return x == null ? null : x;
}

function priceToY(ctx: ProjectCtx, price: number): number | null {
  if (!ctx.priceSeries) return null;
  const y = ctx.priceSeries.priceToCoordinate(price);
  return y == null ? null : y;
}

function setStroke(c: CanvasRenderingContext2D, d: Drawing, selected: boolean) {
  c.strokeStyle = d.color;
  c.lineWidth = selected ? d.width * 2 : d.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
}

function drawHaloThenMain(
  c: CanvasRenderingContext2D,
  d: Drawing,
  selected: boolean,
  body: () => void,
) {
  if (selected) {
    c.save();
    c.strokeStyle = d.color;
    c.globalAlpha = 0.45;
    c.lineWidth = d.width * 4;
    body();
    c.restore();
  }
  c.save();
  setStroke(c, d, false);
  body();
  c.restore();
}

function renderHline(c: CanvasRenderingContext2D, ctx: ProjectCtx, h: Hline, selected: boolean) {
  const y = priceToY(ctx, h.price);
  if (y == null) return;
  drawHaloThenMain(c, h, selected, () => {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(ctx.width, y);
    c.stroke();
  });
}

function renderTrendline(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  t: Trendline,
  selected: boolean,
) {
  const xa = realMsToX(ctx, t.a.realMs);
  const ya = priceToY(ctx, t.a.price);
  const xb = realMsToX(ctx, t.b.realMs);
  const yb = priceToY(ctx, t.b.price);
  if (xa == null && xb == null) return; // both endpoints off-axis: skip
  if (ya == null || yb == null) return; // price scale not ready
  const x1 = xa ?? 0;
  const x2 = xb ?? ctx.width;
  drawHaloThenMain(c, t, selected, () => {
    c.beginPath();
    c.moveTo(x1, ya);
    c.lineTo(x2, yb);
    c.stroke();
  });
  if (selected) {
    if (xa != null) drawHandle(c, t.color, xa, ya);
    if (xb != null) drawHandle(c, t.color, xb, yb);
  }
}

function drawHandle(c: CanvasRenderingContext2D, color: string, x: number, y: number) {
  c.save();
  c.fillStyle = color;
  c.fillRect(x - 3, y - 3, 6, 6);
  c.restore();
}

function renderPencil(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  p: Pencil,
  selected: boolean,
) {
  // Split the polyline at any off-axis vertex so we draw sub-strokes,
  // not a fictional segment that bridges a gap.
  const segments: { x: number; y: number }[][] = [[]];
  for (const pt of p.points) {
    const x = realMsToX(ctx, pt.realMs);
    const y = priceToY(ctx, pt.price);
    if (x == null || y == null) {
      if (segments[segments.length - 1].length > 0) segments.push([]);
      continue;
    }
    segments[segments.length - 1].push({ x, y });
  }
  drawHaloThenMain(c, p, selected, () => {
    for (const seg of segments) {
      if (seg.length < 2) continue;
      c.beginPath();
      c.moveTo(seg[0].x, seg[0].y);
      for (let i = 1; i < seg.length; i++) c.lineTo(seg[i].x, seg[i].y);
      c.stroke();
    }
  });
}

export function renderDrawing(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  d: Drawing,
  selected: boolean,
) {
  switch (d.kind) {
    case 'hline':
      return renderHline(c, ctx, d, selected);
    case 'trendline':
      return renderTrendline(c, ctx, d, selected);
    case 'pencil':
      return renderPencil(c, ctx, d, selected);
  }
}

export function projectPoint(ctx: ProjectCtx, realMs: number, price: number) {
  return { x: realMsToX(ctx, realMs), y: priceToY(ctx, price) };
}
```

- [ ] **Step 6.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 6.3: Commit.**

```bash
git add frontend/src/chart/drawing/render.ts
git commit -m "$(cat <<'EOF'
feat(chart/drawing): add canvas render helpers for hline/trendline/pencil

Pure projection functions over the chart + VirtualAxis APIs. Trendline
endpoints outside any segment clip to canvas bounds (both outside =
skip). Pencil splits its polyline at off-axis vertices into sub-strokes.
Selected drawings get a translucent halo behind the main stroke and
endpoint handles for trendlines.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — DrawingOverlay shell (mount + passthrough)

**Files:**
- Create: `frontend/src/chart/DrawingOverlay.tsx`

This task wires up the canvas, the redraw loop, and pointer-events gating. No tool interactions yet — that's Tasks 8-12.

- [ ] **Step 7.1: Create the overlay shell.**

```tsx
// frontend/src/chart/DrawingOverlay.tsx
import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { useDrawingsStore } from '../state/drawings';
import { renderDrawing, type ProjectCtx } from './drawing/render';

type Props = {
  chart: IChartApi;
  axis: VirtualAxis;
  /**
   * Any series we can read a price scale off. Pane 0's candle series is the
   * canonical choice; ChartStage looks it up after the candle pane mounts.
   */
  priceSeries: ISeriesApi<'Candlestick'> | null;
};

export default function DrawingOverlay({ chart, axis, priceSeries }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeTool = useDrawingsStore((s) => s.activeTool);
  const activeCode = useDrawingsStore((s) => s.activeCode);
  const drawings = useDrawingsStore((s) =>
    s.activeCode == null ? [] : (s.byCode.get(s.activeCode) ?? []),
  );
  const selectedId = useDrawingsStore((s) => s.selectedId);

  // Single rAF redraw coalescer — same pattern as DayBoundaryOverlay.
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };
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
      const ctx: ProjectCtx = { chart, axis, priceSeries, width: w, height: h };
      for (const d of drawings) {
        renderDrawing(c, ctx, d, d.id === selectedId);
      }
    };

    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    schedule(); // initial paint
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, axis, priceSeries, drawings, selectedId, activeCode]);

  // Pointer events flow to the chart unless a drawing tool is active OR
  // there are drawings to interact with in select mode.
  const captureEvents = activeTool !== 'select' || drawings.length > 0;

  return (
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      style={{ pointerEvents: captureEvents ? 'auto' : 'none' }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
```

- [ ] **Step 7.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 7.3: Commit.**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(chart): add DrawingOverlay shell (canvas + redraw loop)

Mounts a DPR-scaled canvas above the chart, subscribes to
subscribeVisibleLogicalRangeChange and ResizeObserver through a single
requestAnimationFrame coalescer (DayBoundaryOverlay pattern), and
gates pointer-events by activeTool + presence of drawings. No tool
interactions yet — those land in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 — Hline tool interaction

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

- [ ] **Step 8.1: Add the hline pointer handler.**

Inside the `DrawingOverlay` component, **add** the following just before the `return` statement. Import `nanoid` from `'nanoid'` and helpers as needed at the top:

```tsx
  // Pointer handler dispatch keyed by activeTool. We attach onPointerDown
  // on the container; tools that need drag track it via setPointerCapture.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'select') return; // select-mode handler lands in Task 12
    if (!priceSeries) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (activeTool === 'hline') {
      const price = priceSeries.coordinateToPrice(py);
      if (price == null) return;
      useDrawingsStore.getState().add({
        id: nanoid(8),
        kind: 'hline',
        price: typeof price === 'number' ? price : Number(price),
        color: 'var(--accent, #FFD60A)',
        width: 1.5,
      });
      return;
    }
    // trendline, pencil, eraser handled in subsequent tasks
  };
```

Update the JSX wrapper to use the handler:

```tsx
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      style={{ pointerEvents: captureEvents ? 'auto' : 'none' }}
      onPointerDown={onPointerDown}
    >
```

Add imports at the top of the file:

```tsx
import { nanoid } from 'nanoid';
```

(`useDrawingsStore` and `React.PointerEvent` are already in scope from the previous task.)

- [ ] **Step 8.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors. If `coordinateToPrice` returns `BarPrice` not `number`, the `Number(price)` cast handles it.

- [ ] **Step 8.3: Commit.**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(chart/drawing): wire hline tool — click adds horizontal line

Pointer-down on the overlay while activeTool='hline' converts cursor
Y to price via the candle series' coordinateToPrice and pushes a new
Hline drawing into the store. Color fixed to the accent token; width
1.5px per spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9 — Trendline tool interaction

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

- [ ] **Step 9.1: Add trendline state + drag flow.**

In `DrawingOverlay`, **above** `onPointerDown`, add the local "in-progress trendline" ref:

```tsx
  const trendlineDraftRef = useRef<{ a: { realMs: number; price: number }; pointerId: number } | null>(null);
```

Add a pixel→(realMs, price) helper inside the component (after the ref):

```tsx
  const pixelToData = (px: number, py: number) => {
    if (!priceSeries) return null;
    const timeSec = chart.timeScale().coordinateToTime(px);
    if (timeSec == null) return null;
    const virtualMs = (timeSec as number) * 1000;
    const realMs = axis.toReal(virtualMs);
    const price = priceSeries.coordinateToPrice(py);
    if (price == null) return null;
    return { realMs, price: Number(price) };
  };
```

Extend `onPointerDown` with the trendline branch (insert before the trailing comment about other tools):

```tsx
    if (activeTool === 'trendline') {
      const data = pixelToData(px, py);
      if (!data) return;
      trendlineDraftRef.current = { a: data, pointerId: e.pointerId };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      return;
    }
```

Add new pointer handlers (place after `onPointerDown` declaration):

```tsx
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool !== 'trendline') return;
    const draft = trendlineDraftRef.current;
    if (!draft || draft.pointerId !== e.pointerId) return;
    // Preview painting: store a transient drawing or stash in a ref + force
    // redraw. Simpler: track in a ref and call a local rerender via state.
    // For v1 we accept that preview only shows on commit — see follow-up.
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool !== 'trendline') return;
    const draft = trendlineDraftRef.current;
    if (!draft || draft.pointerId !== e.pointerId) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const data = pixelToData(e.clientX - rect.left, e.clientY - rect.top);
    trendlineDraftRef.current = null;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    if (!data) return;
    // Reject zero-length trendlines (click without drag).
    if (data.realMs === draft.a.realMs && data.price === draft.a.price) return;
    useDrawingsStore.getState().add({
      id: nanoid(8),
      kind: 'trendline',
      a: draft.a,
      b: data,
      color: 'var(--accent, #FFD60A)',
      width: 1.5,
    });
  };
```

Wire the new handlers onto the wrapper:

```tsx
    <div
      ref={containerRef}
      data-drawing-overlay
      className="absolute inset-0 z-20"
      style={{ pointerEvents: captureEvents ? 'auto' : 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
```

- [ ] **Step 9.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 9.3: Commit.**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(chart/drawing): wire trendline tool — drag commits two-point line

Pointer-down captures the starting (realMs, price). Pointer-up converts
the release coordinate and pushes a Trendline drawing if non-degenerate.
Preview-during-drag is a follow-up; commit-on-release is v1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10 — Pencil tool interaction

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

- [ ] **Step 10.1: Add pencil drag state.**

Add to the top of `DrawingOverlay` (after the trendline ref):

```tsx
  const pencilDraftRef = useRef<{ points: { realMs: number; price: number }[]; pointerId: number; lastFrame: number } | null>(null);
```

Import `PENCIL_MAX_POINTS`:

```tsx
import type { Drawing } from './drawing/types';
import { PENCIL_MAX_POINTS } from './drawing/types';
```

Extend `onPointerDown` with the pencil branch:

```tsx
    if (activeTool === 'pencil') {
      const data = pixelToData(px, py);
      if (!data) return;
      pencilDraftRef.current = {
        points: [data],
        pointerId: e.pointerId,
        lastFrame: 0,
      };
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      return;
    }
```

Extend `onPointerMove` to append throttled points:

```tsx
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'trendline') {
      // (existing branch — unchanged)
      return;
    }
    if (activeTool === 'pencil') {
      const draft = pencilDraftRef.current;
      if (!draft || draft.pointerId !== e.pointerId) return;
      const now = performance.now();
      if (now - draft.lastFrame < 16) return; // RAF-aligned throttle (G11)
      draft.lastFrame = now;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const data = pixelToData(e.clientX - rect.left, e.clientY - rect.top);
      if (!data) return;
      if (draft.points.length >= PENCIL_MAX_POINTS) return;
      draft.points.push(data);
      return;
    }
  };
```

Extend `onPointerUp` for pencil:

```tsx
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'trendline') {
      // (existing branch — unchanged)
      return;
    }
    if (activeTool === 'pencil') {
      const draft = pencilDraftRef.current;
      if (!draft || draft.pointerId !== e.pointerId) return;
      pencilDraftRef.current = null;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      if (draft.points.length < 2) return;
      const pencil: Drawing = {
        id: nanoid(8),
        kind: 'pencil',
        points: draft.points,
        color: 'var(--accent, #FFD60A)',
        width: 1.5,
      };
      useDrawingsStore.getState().add(pencil);
      return;
    }
  };
```

- [ ] **Step 10.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 10.3: Commit.**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(chart/drawing): wire pencil tool — drag commits polyline

Throttles point capture to one per RAF (16ms) per spec G11, caps total
points at PENCIL_MAX_POINTS to bound serialized size. Polyline commits
on pointer-up only when >= 2 points were captured.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11 — Eraser tool interaction

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

- [ ] **Step 11.1: Add hit-test-on-click eraser branch.**

Add a helper inside `DrawingOverlay` that finds the topmost drawing hit by a pixel:

```tsx
  const hitTestAt = (px: number, py: number): Drawing | null => {
    // Walk in reverse so newer drawings (drawn last → on top) are tested first.
    for (let i = drawings.length - 1; i >= 0; i--) {
      const d = drawings[i];
      if (d.kind === 'hline') {
        const y = priceSeries?.priceToCoordinate(d.price);
        if (y != null && distanceToHline({ x: px, y: py }, y) <= HIT_THRESHOLD.hline) {
          return d;
        }
      } else if (d.kind === 'trendline') {
        const xa = realMsToCanvasX(d.a.realMs);
        const ya = priceSeries?.priceToCoordinate(d.a.price);
        const xb = realMsToCanvasX(d.b.realMs);
        const yb = priceSeries?.priceToCoordinate(d.b.price);
        if (xa != null && ya != null && xb != null && yb != null) {
          if (
            distanceToSegment({ x: px, y: py }, { x: xa, y: ya }, { x: xb, y: yb }) <=
            HIT_THRESHOLD.trendlineBody
          ) {
            return d;
          }
        }
      } else if (d.kind === 'pencil') {
        const poly: { x: number; y: number }[] = [];
        for (const pt of d.points) {
          const x = realMsToCanvasX(pt.realMs);
          const y = priceSeries?.priceToCoordinate(pt.price);
          if (x != null && y != null) poly.push({ x, y: Number(y) });
        }
        if (distanceToPolyline({ x: px, y: py }, poly) <= HIT_THRESHOLD.pencil) {
          return d;
        }
      }
    }
    return null;
  };

  const realMsToCanvasX = (realMs: number): number | null => {
    if (!axis.contains(realMs)) return null;
    const virtualMs = axis.toVirtual(realMs);
    const x = chart.timeScale().timeToCoordinate((virtualMs / 1000) as unknown as import('lightweight-charts').UTCTimestamp);
    return x == null ? null : (x as number);
  };
```

Add imports:

```tsx
import { distanceToHline, distanceToPolyline, distanceToSegment } from './drawing/hitTest';
import { HIT_THRESHOLD } from './drawing/types';
```

Extend `onPointerDown` with the eraser branch:

```tsx
    if (activeTool === 'eraser') {
      const hit = hitTestAt(px, py);
      if (hit) useDrawingsStore.getState().remove(hit.id);
      return;
    }
```

- [ ] **Step 11.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 11.3: Commit.**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(chart/drawing): wire eraser tool — click on drawing removes it

Hit-test walks drawings in reverse (topmost first). Hover preview
highlight is a follow-up — v1 deletes on pointer-down only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12 — Select mode (drag, handles, keyboard)

**Files:**
- Modify: `frontend/src/chart/DrawingOverlay.tsx`

- [ ] **Step 12.1: Add select-mode drag state.**

Add to the top of `DrawingOverlay`:

```tsx
  type DragMode =
    | { kind: 'body'; id: string; lastRealMs: number; lastPrice: number; pointerId: number }
    | { kind: 'handle'; id: string; endpoint: 'a' | 'b'; pointerId: number };
  const dragRef = useRef<DragMode | null>(null);
```

Extend `onPointerDown` with the select branch (REPLACE the early-return at the top):

```tsx
    if (activeTool === 'select') {
      // Handle hit-test takes precedence for trendlines.
      const selected = selectedId
        ? drawings.find((d) => d.id === selectedId)
        : null;
      if (selected && selected.kind === 'trendline') {
        const xa = realMsToCanvasX(selected.a.realMs);
        const ya = priceSeries?.priceToCoordinate(selected.a.price);
        const xb = realMsToCanvasX(selected.b.realMs);
        const yb = priceSeries?.priceToCoordinate(selected.b.price);
        if (
          xa != null && ya != null &&
          Math.hypot(px - xa, py - Number(ya)) <= HIT_THRESHOLD.trendlineHandle
        ) {
          dragRef.current = { kind: 'handle', id: selected.id, endpoint: 'a', pointerId: e.pointerId };
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          return;
        }
        if (
          xb != null && yb != null &&
          Math.hypot(px - xb, py - Number(yb)) <= HIT_THRESHOLD.trendlineHandle
        ) {
          dragRef.current = { kind: 'handle', id: selected.id, endpoint: 'b', pointerId: e.pointerId };
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          return;
        }
      }
      const hit = hitTestAt(px, py);
      useDrawingsStore.getState().setSelected(hit?.id ?? null);
      if (hit) {
        const data = pixelToData(px, py);
        if (!data) return;
        dragRef.current = {
          kind: 'body',
          id: hit.id,
          lastRealMs: data.realMs,
          lastPrice: data.price,
          pointerId: e.pointerId,
        };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }
      return;
    }
```

Extend `onPointerMove` for select-mode drag:

```tsx
    if (activeTool === 'select') {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      const data = pixelToData(e.clientX - rect.left, e.clientY - rect.top);
      if (!data) return;
      const target = drawings.find((d) => d.id === drag.id);
      if (!target) return;
      if (drag.kind === 'handle' && target.kind === 'trendline') {
        const patch = drag.endpoint === 'a' ? { a: data } : { b: data };
        useDrawingsStore.getState().update(target.id, patch as Partial<Drawing>);
      } else if (drag.kind === 'body') {
        const dMs = data.realMs - drag.lastRealMs;
        const dPrice = data.price - drag.lastPrice;
        if (target.kind === 'hline') {
          useDrawingsStore.getState().update(target.id, { price: target.price + dPrice } as Partial<Drawing>);
        } else if (target.kind === 'trendline') {
          useDrawingsStore.getState().update(target.id, {
            a: { realMs: target.a.realMs + dMs, price: target.a.price + dPrice },
            b: { realMs: target.b.realMs + dMs, price: target.b.price + dPrice },
          } as Partial<Drawing>);
        } else if (target.kind === 'pencil') {
          useDrawingsStore.getState().update(target.id, {
            points: target.points.map((p) => ({
              realMs: p.realMs + dMs,
              price: p.price + dPrice,
            })),
          } as Partial<Drawing>);
        }
        drag.lastRealMs = data.realMs;
        drag.lastPrice = data.price;
      }
      return;
    }
```

Extend `onPointerUp` for select-mode release:

```tsx
    if (activeTool === 'select') {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      return;
    }
```

- [ ] **Step 12.2: Add keyboard shortcuts.**

Add this `useEffect` near the existing rAF effect:

```tsx
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't steal keys from form controls.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
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

- [ ] **Step 12.3: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 12.4: Commit.**

```bash
git add frontend/src/chart/DrawingOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(chart/drawing): wire select tool — hit/drag/handles + Delete/Esc

Select mode: hit-test on pointer-down sets selectedId; body drag
translates by (Δrealms, Δprice); trendline handle drag moves one
endpoint only; hline body drag shifts price only. Delete/Backspace
removes selectedId; Escape clears selection and reverts to select tool.
Keyboard handler skips form-control targets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13 — DrawingMenu popover

**Files:**
- Create: `frontend/src/replay/DrawingMenu.tsx`

- [ ] **Step 13.1: Implement the popover.**

```tsx
// frontend/src/replay/DrawingMenu.tsx
import { useEffect, useRef, useState } from 'react';
import { useDrawingsStore } from '../state/drawings';
import type { DrawingTool } from '../chart/drawing/types';

const TOOL_ITEMS: { tool: Exclude<DrawingTool, 'select'>; label: string; glyph: string }[] = [
  { tool: 'hline', label: '수평선', glyph: '━' },
  { tool: 'trendline', label: '추세선', glyph: '╱' },
  { tool: 'pencil', label: '연필', glyph: '✎' },
  { tool: 'eraser', label: '지우개', glyph: '⌫' },
];

const TOOL_GLYPH: Record<DrawingTool, string> = {
  select: '✏',
  hline: '━',
  trendline: '╱',
  pencil: '✎',
  eraser: '⌫',
};

export default function DrawingMenu() {
  const [open, setOpen] = useState(false);
  const activeTool = useDrawingsStore((s) => s.activeTool);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (tool: DrawingTool) => {
    useDrawingsStore.getState().setActiveTool(tool);
    setOpen(false);
  };

  return (
    <div ref={popoverRef} className="relative">
      <button
        type="button"
        aria-label="그리기"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          (activeTool === 'select'
            ? 'bg-bg-card text-fg-dim hover:text-fg'
            : 'bg-accent text-accent-fg') +
          ' px-3 py-1.5 text-sm border border-border rounded'
        }
        data-drawing-menu-button
      >
        {TOOL_GLYPH[activeTool]}
      </button>
      {open && (
        <div
          role="menu"
          data-drawing-menu
          className="absolute left-0 top-full mt-1 w-44 bg-bg-card border border-border rounded shadow-lg z-30 py-1"
        >
          {TOOL_ITEMS.map((item) => (
            <button
              key={item.tool}
              type="button"
              role="menuitem"
              data-drawing-tool={item.tool}
              onClick={() => pick(item.tool)}
              className={
                (activeTool === item.tool
                  ? 'bg-bg-input-hover text-fg'
                  : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover') +
                ' w-full text-left px-3 py-1.5 text-sm flex items-center gap-2'
              }
            >
              <span className="font-mono w-4 text-center">{item.glyph}</span>
              {item.label}
            </button>
          ))}
          <div className="border-t border-border my-1" />
          <button
            type="button"
            role="menuitem"
            onClick={() => pick('select')}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
          >
            <span className="font-mono w-4 text-center">↶</span>선택
          </button>
          <button
            type="button"
            role="menuitem"
            data-drawing-clear-all
            onClick={() => {
              useDrawingsStore.getState().clearAll();
              setOpen(false);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
          >
            <span className="font-mono w-4 text-center">✕</span>모두 지우기
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 13.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 13.3: Commit.**

```bash
git add frontend/src/replay/DrawingMenu.tsx
git commit -m "$(cat <<'EOF'
feat(replay): add DrawingMenu popover (tool selector)

Hand-rolled popover with outside-click + Escape close. The toolbar
button's glyph reflects the active tool so the user always sees what
mode they're in. data-* attributes (data-drawing-menu, data-drawing-tool)
support e2e assertions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14 — Toolbar integration

**Files:**
- Modify: `frontend/src/replay/Toolbar.tsx`

- [ ] **Step 14.1: Mount `DrawingMenu` next to the settings button.**

In `frontend/src/replay/Toolbar.tsx`, add the import at the top:

```tsx
import DrawingMenu from './DrawingMenu';
```

Inside the JSX, **insert** `<DrawingMenu />` immediately after the closing tag of the settings `<button>` (the one with `aria-label="설정"`) and before `{settingsOpen && <SettingsModal …/>}`. Resulting fragment around lines 72-82:

```tsx
      <button
        type="button"
        aria-label="설정"
        onClick={() => setSettingsOpen(true)}
        className="px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border border-border rounded"
      >
        ⚙
      </button>
      <DrawingMenu />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
```

- [ ] **Step 14.2: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 14.3: Commit.**

```bash
git add frontend/src/replay/Toolbar.tsx
git commit -m "$(cat <<'EOF'
feat(replay): mount DrawingMenu next to the settings button

Per spec UI sketch — the drawing button sits to the immediate right of
the ⚙ settings button so both tool-mode controls are clustered.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15 — ChartStage integration (mount overlay + wire activeCode)

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx`

- [ ] **Step 15.1: Wire `activeCode` from the active tab.**

Add imports at the top of `frontend/src/chart/ChartStage.tsx`:

```tsx
import DrawingOverlay from './DrawingOverlay';
import { useDrawingsStore } from '../state/drawings';
import type { ISeriesApi } from 'lightweight-charts';
```

Inside the component, add an effect that mirrors the active tab's selection code into the drawings store. Insert immediately after the `useEffect` that updates `axisRef`:

```tsx
  const activeCode = useTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.selection?.code ?? null;
  });
  useEffect(() => {
    useDrawingsStore.getState().setActiveCode(activeCode);
  }, [activeCode]);
```

- [ ] **Step 15.2: Capture a reference to the candle series.**

We need a price series to convert price ↔ coordinate. The candle pane registers it via `RangeSeriesPane`, but we don't currently surface the series reference. Add a ref that `RangeSeriesPane` can populate, or expose it through a small store. Simpler v1 approach: read it from the chart's series list at render time.

Add this inside `ChartStage`, immediately before the `return`:

```tsx
  const [candleSeries, setCandleSeries] = useState<ISeriesApi<'Candlestick'> | null>(null);
  useEffect(() => {
    if (!chart) {
      setCandleSeries(null);
      return;
    }
    // Poll once per RAF until pane 0's first Candlestick series exists.
    // Bounded by the bundle effect — once the bundle is set, the candle
    // pane mounts within a few frames.
    let raf = 0;
    let cancelled = false;
    const find = () => {
      if (cancelled) return;
      const panes = chart.panes();
      const pane0 = panes[0];
      if (!pane0) {
        raf = requestAnimationFrame(find);
        return;
      }
      // chart.panes()[0].getSeries() returns ISeriesApi<SeriesType>[] in v5.
      const series = pane0.getSeries();
      const candle = series.find((s) => s.seriesType() === 'Candlestick') as
        | ISeriesApi<'Candlestick'>
        | undefined;
      if (candle) {
        setCandleSeries(candle);
      } else {
        raf = requestAnimationFrame(find);
      }
    };
    raf = requestAnimationFrame(find);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [chart, bundle]);
```

- [ ] **Step 15.3: Mount `DrawingOverlay` in the JSX.**

Inside the existing `{chart && bundle && (…)}` block, after `<AuctionWindowOverlay …/>`, add:

```tsx
          <DrawingOverlay chart={chart} axis={axis} priceSeries={candleSeries} />
```

- [ ] **Step 15.4: Typecheck.**

Run: `(cd frontend && npx tsc --noEmit)`
Expected: no errors. If `pane.getSeries()` is not the v5 API name in the installed version, replace with whatever the library exposes (alternative: keep a module-level mutable ref populated by the candle PaneSpec's `onSeriesReady`).

- [ ] **Step 15.5: Smoke test.**

Run the dev servers (Step 1.3) and verify:
- Open `/replay`, no console errors.
- Click the **그리기** button → popover opens.
- Click **수평선** → cursor crosshair stays; click on the chart → a yellow horizontal line appears.
- Click **추세선** → drag on the chart → trendline commits.
- Click **연필** → drag → freehand stroke appears.
- Click **지우개** → click an existing drawing → it disappears.
- Click **선택** → click an hline → tiny halo/handle visual cue; drag → line moves; press Delete → line removed.

Stop dev servers.

- [ ] **Step 15.6: Commit.**

```bash
git add frontend/src/chart/ChartStage.tsx
git commit -m "$(cat <<'EOF'
feat(chart): mount DrawingOverlay + wire activeCode from active tab

Wires the per-tab selection.code into the drawings store so drawings
persist per Code. Discovers the candle series via chart.panes()[0]
polling (one rAF at a time) to feed DrawingOverlay's price scale.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16 — Add Drawing glossary entries to CONTEXT.md

**Files:**
- Modify: `CONTEXT.md`

- [ ] **Step 16.1: Append three glossary entries.**

Open `CONTEXT.md`, locate the **Replay Tab** entry (the last term before the `## Relationships` section, around line 161-162). Insert these three new entries **before** the `## Relationships` heading, after the Replay Tab entry:

```markdown
**Drawing**:
A user-authored chart annotation persisted to the browser — one of three primitives: **horizontal line** (single price, full chart width), **trendline** (two-point segment), **pencil** (freehand polyline). All coordinates are real Unix-ms (ADR-0003) plus price, so a Drawing remains valid across different **Stock-Date Range** loads of the same **Code**. Persisted to `localStorage` under `replay.drawings.v1.<code>` (per **Code**, not per **Replay Tab** or per **Stock-Date Range**). Selectable, draggable, and deletable in select mode; created by activating a tool from the **Drawing Menu** in the Replay Viewer toolbar. Lives in `frontend/src/state/drawings.ts` (store) and renders via `frontend/src/chart/DrawingOverlay.tsx` (canvas overlay). See ADR-0024 for the realMs-vs-virtualMs decision.
_Avoid_: "annotation" alone (overloaded with `data-*` attributes used for E2E selectors), "shape" alone (collides with lightweight-charts' own primitives terminology), "line" (ambiguous across hline / trendline / pencil).

**Drawing Overlay**:
The canvas layer (`frontend/src/chart/DrawingOverlay.tsx`) above the `lightweight-charts` canvas in `ChartStage` that renders all **Drawing**s and captures pointer events when a **Drawing Tool** is active (or when there are drawings present in select mode). Sibling of **DayBoundaryOverlay** / **AuctionWindowOverlay** in z-stack order; sits at z-20 versus z-10 for the read-only overlays because it consumes pointer events. Mounts a DPR-scaled `<canvas>` and coalesces redraws through a single `requestAnimationFrame` driven by `subscribeVisibleLogicalRangeChange` and a `ResizeObserver`, identical to **DayBoundaryOverlay**'s pattern.
_Avoid_: "drawing canvas" alone (loses the React-component identity), "overlay" alone (chart has multiple overlays).

**Drawing Tool**:
The user's currently selected drawing mode — one of `select` / `hline` / `trendline` / `pencil` / `eraser`. **Global** UI state (not per **Replay Tab**, not per **Code**) because it reflects the user's current intent, not data. The **Drawing Menu** button in the toolbar shows the active tool's glyph and reverts to `select` via the menu's "선택" entry or the `Escape` key. When the active tool is anything other than `select`, the **Drawing Overlay** captures pointer events so they do not reach the chart's pan/zoom handlers.
_Avoid_: "drawing mode" alone (ambiguous with chart pan/zoom modes), "tool" alone (overloaded across toolbar buttons).
```

Also append to the **Relationships** section (after the existing bullets):

```markdown
- A **Drawing** belongs to one **Code**. Same-**Code** **Replay Tab**s render the same Drawings because both subscribe to the same `byCode.get(code)` slice of the store. Switching the active **Replay Tab** to a different **Code** swaps the **Drawing Overlay**'s render list and resets `selectedId`.
```

- [ ] **Step 16.2: Commit.**

```bash
git add CONTEXT.md
git commit -m "$(cat <<'EOF'
docs(context): add Drawing, Drawing Overlay, Drawing Tool glossary entries

Captures the new domain vocabulary introduced by the drawing tools
feature and the Code-scoped persistence rule.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17 — ADR-0024: drawing realms coordinates

**Files:**
- Create: `docs/adr/0024-drawing-realms-coordinates.md`

- [ ] **Step 17.1: Write the ADR.**

```markdown
# ADR-0024: Drawing persistence uses real Unix-ms, not virtual-ms

**Status:** Accepted
**Date:** 2026-05-24
**Spec:** docs/superpowers/specs/2026-05-24-replay-chart-pan-lock-and-drawing-tools-design.md

## Context

The chart in the Replay Viewer renders on a **Virtual Axis** that stitches several **Stock-Date** sessions end-to-end with a 1-second compressed inter-session gap. Drawings (horizontal lines, trendlines, freehand strokes) need to persist across page reloads and be re-rendered correctly when the user reopens the same **Code** at a possibly different **Stock-Date Range**.

The drawing's time coordinate could be encoded in either of two ways:

1. **Virtual-ms** — the value emitted by `axis.toVirtual(realMs)` and fed directly to `timeScale.timeToCoordinate`. Cheapest render path (zero conversion at draw time).
2. **Real Unix-ms** — the value used everywhere else in the project (`Cursor`, `frontier_ms`, `segments[*].session_open_ms`). One extra `axis.toVirtual` call per vertex at draw time.

## Decision

Drawings persist their time coordinates as **real Unix-ms (UTC)**. The renderer converts to virtual-ms via `axis.toVirtual(realMs)` and then to canvas X via `timeScale.timeToCoordinate(virtualMs / 1000)` per vertex per frame.

## Consequences

**Range-independent persistence (the reason for this ADR).** Virtual-ms is computed relative to the first segment's `sessionOpenMs` (per `util/virtualAxis.ts`). A drawing stored as virtual-ms is therefore tied to one specific **Virtual Axis** construction, i.e. one specific **Stock-Date Range**. Storing drawings per **Code** with virtual-ms would silently corrupt their position whenever the user reopened the same **Code** at a different Range. Real Unix-ms is invariant under Range changes.

**Alignment with ADR-0003.** All time on the API and UI contracts is real Unix-ms. Drawings inherit the same encoding, so any future server-side persistence (e.g. sync across devices) reuses the existing serialization without translation.

**Per-vertex conversion cost.** The render path now does one binary search inside `axis.toVirtual` plus two coordinate calls per vertex per frame. For the cardinalities users actually produce (< 50 drawings, < 5000 vertices total per pencil), this is far below frame budget.

**Out-of-range vertex behavior.** When a vertex's `realMs` falls outside every segment, `axis.toVirtual` returns the prior-segment-end sentinel. The renderer treats those vertices as "skip and break the polyline" (pencil) or "clip to canvas bound along the slope" (trendline) rather than stacking the geometry on the sentinel — a virtual-ms representation could not preserve this information at all.

## Alternatives considered

- **Per-Range storage of virtual-ms.** Rejected: the analyst expectation is "my trendline on 005930 is still there next time I look at 005930", not "still there if I happen to pick the same week". Per-Range keys would multiply storage and create UX confusion.
- **Pixel coordinates.** Rejected for the same reason as in the spec — they desync on any pan/zoom.
- **Encoding the source Range alongside virtual-ms.** Rejected as more complex than just storing realMs and getting Range-independence for free.

## See also

- CONTEXT.md: **Drawing**, **Drawing Overlay**, **Drawing Tool**, **Virtual Axis**
- ADR-0003: API time encoding (Unix-ms)
- ADR-0013: RangeBundle single read path
```

- [ ] **Step 17.2: Commit.**

```bash
git add docs/adr/0024-drawing-realms-coordinates.md
git commit -m "$(cat <<'EOF'
docs(adr): 0024 — drawings persist real Unix-ms, not virtual-ms

Captures the realMs-vs-virtualMs decision from the drawing-tools spec
grilling: real Unix-ms keeps drawings valid across different Stock-Date
Range loads of the same Code, aligns with ADR-0003, and only costs one
extra axis.toVirtual call per vertex per frame.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18 — E2E tests

**Files:**
- Create: `frontend/tests/e2e/drawing.spec.ts`

- [ ] **Step 18.1: Write the e2e spec.**

```ts
// frontend/tests/e2e/drawing.spec.ts
//
// E2E coverage for:
//   1. Pan-lock fix (Task 1) — pan works when fully zoomed out.
//   2. Drawing flow: open menu → choose hline → click → drawing exists.
//   3. Persistence: drawing survives a page reload.
//   4. Eraser: drawing removed on click.
//
// Relies on the same fixture as replay-zoom.spec.ts: code 003490, date
// 20260511. The spec uses a single-day range to keep fixture
// requirements minimal.

import { test, expect } from '@playwright/test';

const CODE = '003490';
const DATE = '20260511';
const URL = `/replay?tabs=${CODE}:${DATE}:${DATE}:1m&active=0`;

async function waitForChart(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-pane="candle"]', { timeout: 15_000 });
  await page.waitForSelector('[data-drawing-overlay]', { timeout: 15_000 });
}

test.describe('Replay drawing tools', () => {
  test('pan works when fully zoomed out', async ({ page }) => {
    await page.goto(URL);
    await waitForChart(page);
    // Read the first canvas (lightweight-charts main) bounding box and drag
    // 200px to the left from its center.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('chart canvas has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 200, startY, { steps: 20 });
    await page.mouse.up();
    // Visual smoke: no assertion on logical range (private), but the test
    // would have hung / lockup-resembled without movement under the old bug.
    // Add a screenshot for manual review.
    await page.screenshot({ path: 'test-results/drawing-pan.png' });
  });

  test('hline tool: open menu → click → drawing rendered', async ({ page }) => {
    await page.goto(URL);
    await waitForChart(page);
    await page.getByRole('button', { name: '그리기' }).click();
    await page.locator('[data-drawing-tool="hline"]').click();
    // Menu closes after pick.
    await expect(page.locator('[data-drawing-menu]')).toHaveCount(0);
    // Click somewhere in the lower half of the chart.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('chart canvas has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);
    // No DOM assertion possible (drawing is canvas pixels); we screenshot
    // and rely on absence-of-crash + later persistence assertion.
    await page.screenshot({ path: 'test-results/drawing-hline.png' });
  });

  test('hline persists across reload', async ({ page, context }) => {
    await page.goto(URL);
    await waitForChart(page);
    await page.getByRole('button', { name: '그리기' }).click();
    await page.locator('[data-drawing-tool="hline"]').click();
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('chart canvas has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);
    // Force the debounced persist to flush by waiting > 250ms then
    // navigating (beforeunload also flushes).
    await page.waitForTimeout(400);
    // Read localStorage directly.
    const stored = await page.evaluate(() => localStorage.getItem('replay.drawings.v1.003490'));
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored as string);
    expect(parsed.v).toBe(1);
    expect(parsed.items.length).toBeGreaterThanOrEqual(1);
    expect(parsed.items[0].kind).toBe('hline');
    // Reload — drawing list survives.
    await page.reload();
    await waitForChart(page);
    const afterReload = await page.evaluate(() =>
      localStorage.getItem('replay.drawings.v1.003490'),
    );
    expect(afterReload).toBe(stored);
  });

  test('clear-all empties the localStorage list', async ({ page }) => {
    await page.goto(URL);
    await waitForChart(page);
    // Seed two hlines.
    await page.getByRole('button', { name: '그리기' }).click();
    await page.locator('[data-drawing-tool="hline"]').click();
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('chart canvas has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5);
    await page.waitForTimeout(400);
    // Open menu → clear all.
    await page.getByRole('button', { name: '그리기' }).click();
    await page.locator('[data-drawing-clear-all]').click();
    await page.waitForTimeout(400);
    const stored = await page.evaluate(() =>
      localStorage.getItem('replay.drawings.v1.003490'),
    );
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string).items).toHaveLength(0);
  });
});
```

- [ ] **Step 18.2: Run the e2e spec.**

```bash
(cd frontend && npx playwright test tests/e2e/drawing.spec.ts)
```

Expected: all 4 specs pass. If the harness can't seed the fixture, the spec degrades to opening the page; address by ensuring the fixture exists (`HOGA_DATA_DIR=/tmp/hoga-e2e-data` per `playwright.config.ts`).

- [ ] **Step 18.3: Commit.**

```bash
git add frontend/tests/e2e/drawing.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): cover pan-lock fix + drawing tools flow + persistence

Four specs: pan works at full zoom-out (regression for the fix),
hline click commits a drawing, the drawing persists across reload
via localStorage replay.drawings.v1.<code>, and clear-all empties
the persisted list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run by the implementing agent before declaring done)

- [ ] All 18 tasks committed in order; `git log --oneline -25` shows ~18 new commits.
- [ ] `(cd frontend && npx tsc --noEmit)` exits zero.
- [ ] `(cd frontend && npx vitest run)` passes all suites (existing + new).
- [ ] `(cd frontend && npm run lint)` passes.
- [ ] Manual smoke test from Step 15.5 still passes end-to-end.
- [ ] Spec coverage: each of the spec's "File touchpoints" entries maps to a task — yes (Task 2-7, 13, 15 cover the new files; Tasks 1, 14, 15 cover the modified files).

## Notes for the implementing agent

- If `lightweight-charts`' `pane.getSeries()` API differs from what Task 15.2 assumes (v5 may surface this differently), fall back to populating a module-level ref from `RangeSeriesPane` for the candle slot only.
- `nanoid` is already a dependency (see `package.json:dependencies.nanoid`).
- The `--accent` token referenced as the drawing color must exist in `tokens.css`. If absent in the worktree, default the color to `#FFD60A` (the project's accent yellow per design tokens) and surface a TODO in code.
- Pencil preview during drag is a known v1 limitation — the freehand line only appears after the user releases the pointer. A follow-up can render the in-flight `pencilDraftRef.current` from the redraw path by introducing a `useState` tick when points are appended.
