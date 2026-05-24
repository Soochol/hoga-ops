# Replay Sidebar Splitter + Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user resize the Cursor Sidebar (10호가 / 거래원 / 체결) on `/replay` via a vertical splitter, and collapse / re-expand the whole sidebar via a Toolbar toggle and a floating right-edge handle. Persist both width and collapsed state in localStorage.

**Architecture:** Extract the splitter logic from `pages/Capture.tsx` into a reusable presentational component `layout/VerticalSplitter`. Introduce a small zustand store `state/replayLayout.ts` that owns `sidebarPx` + `sidebarCollapsed` and persists them via its own `subscribe` listener (not component `useEffect`). Workarea reads the store to drive the grid template; Toolbar grows a toggle button; a new `CollapsedSidebarHandle` button appears at the right edge when collapsed. The chart auto-resizes via existing `autoSize: true` + ResizeObserver — no chart-side changes.

**Tech Stack:** React 18 + TypeScript, zustand v4, Tailwind v3 + custom CSS tokens, Vitest + React Testing Library, jsdom test environment.

**Spec:** [docs/superpowers/specs/2026-05-24-replay-sidebar-splitter-design.md](../specs/2026-05-24-replay-sidebar-splitter-design.md)
**ADR:** [docs/adr/0022-runtime-sidebar-width-user-owned.md](../../adr/0022-runtime-sidebar-width-user-owned.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/layout/VerticalSplitter.tsx` | **Create** | Reusable presentational splitter — pointer + keyboard interaction, ARIA. Knows nothing about parent layout |
| `frontend/src/layout/VerticalSplitter.test.tsx` | **Create** | Unit tests for the splitter component |
| `frontend/src/state/replayLayout.ts` | **Create** | zustand store owning `sidebarPx` / `sidebarCollapsed`, localStorage persistence inside the store |
| `frontend/src/state/replayLayout.test.ts` | **Create** | Unit tests for the store: defaults, clamp, persist, corrupt-value fallback, reset |
| `frontend/src/replay/CollapsedSidebarHandle.tsx` | **Create** | Floating right-edge button visible when the sidebar is collapsed |
| `frontend/src/replay/Workarea.tsx` | **Modify** | Replace static `grid-cols-[1fr_var(--sidebar-w)]` with a store-driven dynamic grid; wire splitter + handle |
| `frontend/src/replay/Workarea.test.tsx` | **Modify** | Add cases for collapsed=true (handle visible), collapsed=false (sidebar + splitter visible), expand-on-click |
| `frontend/src/replay/Toolbar.tsx` | **Modify** | Add a sidebar toggle button (▶/◀) bound to `useReplayLayoutStore.toggleSidebar` |
| `frontend/src/replay/Toolbar.test.tsx` | **Modify** | Add case for the toggle button: correct `aria-expanded`/label, click toggles store |
| `frontend/src/sidebar/CursorSidebar.tsx` | **Modify** | Drop `w-sidebar` (width is now parent grid track); add `id="replay-sidebar"` for `aria-controls` |
| `frontend/src/pages/Capture.tsx` | **Modify** | Migrate inline splitter to the new `VerticalSplitter` component |
| `DESIGN.md` | **Modify** | One paragraph noting that `--sidebar-w` is the default seed and `state/replayLayout.ts` owns runtime |

No backend changes. No new dependencies.

---

## Conventions used in this plan

- **Working directory** for all commands: `frontend/` unless otherwise noted.
- **Test runner**: `npx vitest run <pathOrPattern>` for one-shot runs; the project does not expose an `npm run test` script today.
- **Type-check**: `npx tsc -b --noEmit` from `frontend/`.
- **Lint**: `npm run lint` from `frontend/`.
- **Commit style**: prefix with `feat(replay):` / `refactor(layout):` / `test(...)` matching recent log entries. Co-author trailer is the repo default.

---

## Task 1: Create `useReplayLayoutStore` with defaults + clamp (no persistence yet)

Builds the smallest possible store and proves clamp behavior. Persistence comes in Task 2.

**Files:**
- Create: `frontend/src/state/replayLayout.ts`
- Create: `frontend/src/state/replayLayout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/state/replayLayout.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';

import { useReplayLayoutStore, SIDEBAR_PX_MIN, SIDEBAR_PX_MAX } from './replayLayout';

beforeEach(() => {
  // Reset to fresh defaults between tests. We expose a private __reset for tests only.
  useReplayLayoutStore.getState().__resetForTests();
});

describe('useReplayLayoutStore — defaults and clamp', () => {
  it('starts with a positive sidebarPx and not collapsed', () => {
    const s = useReplayLayoutStore.getState();
    expect(s.sidebarPx).toBeGreaterThanOrEqual(SIDEBAR_PX_MIN);
    expect(s.sidebarPx).toBeLessThanOrEqual(SIDEBAR_PX_MAX);
    expect(s.sidebarCollapsed).toBe(false);
  });

  it('setSidebarPx clamps below MIN', () => {
    useReplayLayoutStore.getState().setSidebarPx(50);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(SIDEBAR_PX_MIN);
  });

  it('setSidebarPx clamps above MAX', () => {
    useReplayLayoutStore.getState().setSidebarPx(9999);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(SIDEBAR_PX_MAX);
  });

  it('setSidebarPx accepts in-range values verbatim', () => {
    useReplayLayoutStore.getState().setSidebarPx(380);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(380);
  });

  it('setSidebarCollapsed toggles', () => {
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(true);
    useReplayLayoutStore.getState().setSidebarCollapsed(false);
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(false);
  });

  it('toggleSidebar flips the boolean', () => {
    const before = useReplayLayoutStore.getState().sidebarCollapsed;
    useReplayLayoutStore.getState().toggleSidebar();
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(!before);
  });

  it('resetSidebar restores in-range default and uncollapses', () => {
    useReplayLayoutStore.getState().setSidebarPx(480);
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    useReplayLayoutStore.getState().resetSidebar();
    const s = useReplayLayoutStore.getState();
    expect(s.sidebarPx).toBeGreaterThanOrEqual(SIDEBAR_PX_MIN);
    expect(s.sidebarPx).toBeLessThanOrEqual(SIDEBAR_PX_MAX);
    expect(s.sidebarCollapsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/state/replayLayout.test.ts
```

Expected: failure with `Cannot find module './replayLayout'` (file doesn't exist yet).

- [ ] **Step 3: Implement the store (no persistence yet)**

Create `frontend/src/state/replayLayout.ts`:

```ts
import { create } from 'zustand';

/**
 * Runtime layout state for /replay's Cursor Sidebar. The design token
 * `--sidebar-w` (tokens.css) seeds the default width; this store owns
 * the user-overridable runtime value and the collapsed flag.
 *
 * Persistence lives inside the store (see Task 2's subscribe block),
 * not in component useEffect, because three independent consumers
 * (Workarea, Toolbar, CollapsedSidebarHandle) share the state.
 *
 * See ADR-0022 for why we keep both the token and the store.
 */

export const SIDEBAR_PX_MIN = 240;
export const SIDEBAR_PX_MAX = 520;

const SIDEBAR_PX_FALLBACK = 320; // matches --sidebar-w base intent at default density

export function readSidebarTokenPx(): number {
  if (typeof document === 'undefined') return SIDEBAR_PX_FALLBACK;
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue('--sidebar-w').trim();
  if (raw.endsWith('px')) {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : SIDEBAR_PX_FALLBACK;
  }
  if (raw.endsWith('rem')) {
    const rem = Number.parseFloat(raw);
    const rootFontPx = Number.parseFloat(getComputedStyle(root).fontSize);
    const px = rem * rootFontPx;
    return Number.isFinite(px) && px > 0 ? px : SIDEBAR_PX_FALLBACK;
  }
  return SIDEBAR_PX_FALLBACK;
}

function clampPx(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_PX_FALLBACK;
  return Math.min(SIDEBAR_PX_MAX, Math.max(SIDEBAR_PX_MIN, n));
}

type ReplayLayoutState = {
  sidebarPx: number;
  sidebarCollapsed: boolean;
  setSidebarPx: (px: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  resetSidebar: () => void;
  /** Test-only: restore initial defaults. Not part of the public API. */
  __resetForTests: () => void;
};

function initialState(): Pick<ReplayLayoutState, 'sidebarPx' | 'sidebarCollapsed'> {
  return {
    sidebarPx: clampPx(readSidebarTokenPx()),
    sidebarCollapsed: false,
  };
}

export const useReplayLayoutStore = create<ReplayLayoutState>((set) => ({
  ...initialState(),
  setSidebarPx: (px) => set({ sidebarPx: clampPx(px) }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  resetSidebar: () =>
    set({ sidebarPx: clampPx(readSidebarTokenPx()), sidebarCollapsed: false }),
  __resetForTests: () => set(initialState()),
}));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd frontend && npx vitest run src/state/replayLayout.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Type-check**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/replayLayout.ts frontend/src/state/replayLayout.test.ts
git commit -m "feat(state): add useReplayLayoutStore with sidebar px + collapsed"
```

---

## Task 2: Add localStorage persistence to the store

The store now writes itself to localStorage on every change and rehydrates on first read. Tests cover round-trip, corrupt JSON, and SSR fallback.

**Files:**
- Modify: `frontend/src/state/replayLayout.ts`
- Modify: `frontend/src/state/replayLayout.test.ts`

- [ ] **Step 1: Extend the test file with persistence cases**

Append to `frontend/src/state/replayLayout.test.ts`:

```ts
describe('useReplayLayoutStore — localStorage persistence', () => {
  const KEY = 'replay.layout';

  beforeEach(() => {
    localStorage.clear();
    useReplayLayoutStore.getState().__resetForTests();
  });

  it('writes changes to localStorage under "replay.layout"', () => {
    useReplayLayoutStore.getState().setSidebarPx(360);
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    expect(stored).toEqual({ sidebarPx: 360, sidebarCollapsed: true });
  });

  it('rehydrates from localStorage when present', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarPx: 400, sidebarCollapsed: true }));
    // Reset the module cache so the store re-imports and re-reads localStorage.
    vi.resetModules();
    const { useReplayLayoutStore: freshStore } = await import('./replayLayout');
    const s = freshStore.getState();
    expect(s.sidebarPx).toBe(400);
    expect(s.sidebarCollapsed).toBe(true);
  });

  it('falls back to defaults on corrupt JSON', async () => {
    localStorage.setItem(KEY, '{not json');
    vi.resetModules();
    const { useReplayLayoutStore: freshStore, SIDEBAR_PX_MIN, SIDEBAR_PX_MAX } =
      await import('./replayLayout');
    const s = freshStore.getState();
    expect(s.sidebarPx).toBeGreaterThanOrEqual(SIDEBAR_PX_MIN);
    expect(s.sidebarPx).toBeLessThanOrEqual(SIDEBAR_PX_MAX);
    expect(s.sidebarCollapsed).toBe(false);
  });

  it('falls back to defaults when stored sidebarPx is out of range', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarPx: 50, sidebarCollapsed: false }));
    vi.resetModules();
    const { useReplayLayoutStore: freshStore, SIDEBAR_PX_MIN } = await import('./replayLayout');
    const s = freshStore.getState();
    expect(s.sidebarPx).toBe(SIDEBAR_PX_MIN); // clamped
  });

  it('falls back to defaults when stored sidebarCollapsed is wrong type', async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarPx: 360, sidebarCollapsed: 'yes' }));
    vi.resetModules();
    const { useReplayLayoutStore: freshStore } = await import('./replayLayout');
    expect(freshStore.getState().sidebarCollapsed).toBe(false);
  });
});
```

Add `import { vi } from 'vitest'` to the existing `import { beforeEach, describe, expect, it } from 'vitest';` line at the top of the file (replace with `import { beforeEach, describe, expect, it, vi } from 'vitest';`).

- [ ] **Step 2: Run the new tests; expect them to fail**

```bash
cd frontend && npx vitest run src/state/replayLayout.test.ts
```

Expected: the 5 new tests fail (no persistence wired yet).

- [ ] **Step 3: Add persistence to the store**

Modify `frontend/src/state/replayLayout.ts`. Replace the `initialState()` function and the file tail (everything after `function clampPx` through end-of-file) with:

```ts
function clampPx(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_PX_FALLBACK;
  return Math.min(SIDEBAR_PX_MAX, Math.max(SIDEBAR_PX_MIN, n));
}

const STORAGE_KEY = 'replay.layout';

type Persisted = { sidebarPx: number; sidebarCollapsed: boolean };

function loadPersisted(): Persisted {
  const fallback: Persisted = {
    sidebarPx: clampPx(readSidebarTokenPx()),
    sidebarCollapsed: false,
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const obj = parsed as Record<string, unknown>;
    const px =
      typeof obj.sidebarPx === 'number' ? clampPx(obj.sidebarPx) : fallback.sidebarPx;
    const collapsed =
      typeof obj.sidebarCollapsed === 'boolean'
        ? obj.sidebarCollapsed
        : fallback.sidebarCollapsed;
    return { sidebarPx: px, sidebarCollapsed: collapsed };
  } catch {
    return fallback;
  }
}

function savePersisted(p: Persisted): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* privacy mode / quota — silently ignore */
  }
}

type ReplayLayoutState = {
  sidebarPx: number;
  sidebarCollapsed: boolean;
  setSidebarPx: (px: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  resetSidebar: () => void;
  __resetForTests: () => void;
};

export const useReplayLayoutStore = create<ReplayLayoutState>((set) => ({
  ...loadPersisted(),
  setSidebarPx: (px) => set({ sidebarPx: clampPx(px) }),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  resetSidebar: () =>
    set({ sidebarPx: clampPx(readSidebarTokenPx()), sidebarCollapsed: false }),
  __resetForTests: () =>
    set({ sidebarPx: clampPx(readSidebarTokenPx()), sidebarCollapsed: false }),
}));

// Persistence subscriber: writes the persisted slice on every change.
// Registered once at module load; survives HMR via zustand's stable store identity.
useReplayLayoutStore.subscribe((state) => {
  savePersisted({ sidebarPx: state.sidebarPx, sidebarCollapsed: state.sidebarCollapsed });
});
```

Delete the older `initialState()` function and the older `create<ReplayLayoutState>(...)` block from Task 1 — they are replaced by the code above.

- [ ] **Step 4: Run all `replayLayout` tests**

```bash
cd frontend && npx vitest run src/state/replayLayout.test.ts
```

Expected: 12 passed (7 from Task 1 + 5 from Task 2).

- [ ] **Step 5: Type-check**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/replayLayout.ts frontend/src/state/replayLayout.test.ts
git commit -m "feat(state): persist replayLayout to localStorage 'replay.layout'"
```

---

## Task 3: Create `VerticalSplitter` component with tests

A presentational component: pointer drag, double-click reset, keyboard nudge, ARIA. Knows nothing about the parent layout — emits `onDrag(clientX)` and lets the parent compute the new value.

**Files:**
- Create: `frontend/src/layout/VerticalSplitter.tsx`
- Create: `frontend/src/layout/VerticalSplitter.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/layout/VerticalSplitter.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import VerticalSplitter from './VerticalSplitter';

function renderSplitter(overrides: Partial<React.ComponentProps<typeof VerticalSplitter>> = {}) {
  const onDrag = overrides.onDrag ?? vi.fn();
  const onReset = overrides.onReset ?? vi.fn();
  const onNudge = overrides.onNudge ?? vi.fn();
  render(
    <VerticalSplitter
      ariaLabel="test splitter"
      ariaValueNow={320}
      ariaValueMin={240}
      ariaValueMax={520}
      onDrag={onDrag}
      onReset={onReset}
      onNudge={onNudge}
      {...overrides}
    />,
  );
  return { onDrag, onReset, onNudge };
}

describe('VerticalSplitter', () => {
  it('renders with separator ARIA attributes', () => {
    renderSplitter();
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-label', 'test splitter');
    expect(sep).toHaveAttribute('aria-valuenow', '320');
    expect(sep).toHaveAttribute('aria-valuemin', '240');
    expect(sep).toHaveAttribute('aria-valuemax', '520');
    expect(sep).toHaveAttribute('tabindex', '0');
  });

  it('calls onDrag(clientX) when dragged', () => {
    const { onDrag } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.mouseDown(sep, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseMove(window, { clientX: 650 });
    fireEvent.mouseUp(window);
    expect(onDrag).toHaveBeenCalledTimes(2);
    expect(onDrag).toHaveBeenNthCalledWith(1, 700);
    expect(onDrag).toHaveBeenNthCalledWith(2, 650);
  });

  it('stops calling onDrag after mouseup', () => {
    const { onDrag } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.mouseDown(sep, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 650 });
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it('calls onReset on double-click', () => {
    const { onReset } = renderSplitter();
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('Enter and Space call onReset', () => {
    const { onReset } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'Enter' });
    fireEvent.keyDown(sep, { key: ' ' });
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('Arrow keys call onNudge with small magnitude', () => {
    const { onNudge } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onNudge).toHaveBeenNthCalledWith(1, -1, 'small');
    expect(onNudge).toHaveBeenNthCalledWith(2, 1, 'small');
  });

  it('Shift+Arrow, Home, End call onNudge with large magnitude', () => {
    const { onNudge } = renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(sep, { key: 'Home' });
    fireEvent.keyDown(sep, { key: 'End' });
    expect(onNudge).toHaveBeenNthCalledWith(1, -1, 'large');
    expect(onNudge).toHaveBeenNthCalledWith(2, -1, 'large');
    expect(onNudge).toHaveBeenNthCalledWith(3, 1, 'large');
  });

  it('cleans up document.body styles on mouseup', () => {
    renderSplitter();
    const sep = screen.getByRole('separator');
    fireEvent.mouseDown(sep, { clientX: 800 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.mouseUp(window);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/layout/VerticalSplitter.test.tsx
```

Expected: failure with `Cannot find module './VerticalSplitter'`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/layout/VerticalSplitter.tsx`:

```tsx
import { useEffect, useRef } from 'react';

/**
 * Reusable vertical splitter — a thin grid track the user drags to resize
 * adjacent regions. Knows nothing about the parent layout; emits raw
 * cursor X and lets the parent map clientX → its own value space
 * (px or percent, axis direction).
 *
 * Visual: a 12px-wide grab zone with a 2px-thick bar centered inside,
 * `var(--border)` by default and `var(--accent)` on hover (per the
 * 2026-05-20 design system). Double-click resets; arrow keys nudge.
 */

type Props = {
  /** Called on every drag move with the raw cursor X (clientX). */
  onDrag: (clientX: number) => void;
  /** Called on double-click and on Enter/Space. */
  onReset: () => void;
  /** Optional keyboard nudge handler. direction: -1 (left) | +1 (right). */
  onNudge?: (direction: -1 | 1, magnitude: 'small' | 'large') => void;
  ariaLabel: string;
  ariaValueNow: number;
  ariaValueMin: number;
  ariaValueMax: number;
};

export default function VerticalSplitter({
  onDrag,
  onReset,
  onNudge,
  ariaLabel,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
}: Props) {
  const draggingRef = useRef(false);
  // Hold latest onDrag in a ref so the window mousemove handler always
  // sees the freshest closure without re-registering listeners.
  const onDragRef = useRef(onDrag);
  useEffect(() => {
    onDragRef.current = onDrag;
  }, [onDrag]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      onDragRef.current(e.clientX);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Defensive cleanup in case unmount happens mid-drag.
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onReset();
      return;
    }
    if (!onNudge) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onNudge(-1, e.shiftKey ? 'large' : 'small');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onNudge(1, e.shiftKey ? 'large' : 'small');
    } else if (e.key === 'Home') {
      e.preventDefault();
      onNudge(-1, 'large');
    } else if (e.key === 'End') {
      e.preventDefault();
      onNudge(1, 'large');
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={ariaValueNow}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title="드래그하여 크기 조정 · 더블클릭으로 초기화"
      className="cursor-col-resize flex items-stretch justify-center bg-transparent select-none focus:outline-none focus-visible:[&>div]:!bg-[var(--accent)]"
    >
      <div
        aria-hidden
        className="w-[2px] rounded-[1px] bg-[var(--border)] transition-[background-color,width] duration-150 hover:!w-1 hover:!bg-[var(--accent)]"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests; expect them to pass**

```bash
cd frontend && npx vitest run src/layout/VerticalSplitter.test.tsx
```

Expected: 8 passed.

- [ ] **Step 5: Type-check + lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/layout/VerticalSplitter.tsx frontend/src/layout/VerticalSplitter.test.tsx
git commit -m "feat(layout): VerticalSplitter reusable component with drag+keyboard"
```

---

## Task 4: Migrate `pages/Capture.tsx` to `VerticalSplitter`

Prove the new component works for the existing caller before introducing the second one. This catches API mistakes early.

**Files:**
- Modify: `frontend/src/pages/Capture.tsx`

- [ ] **Step 1: Read the current Capture.tsx**

```bash
cat frontend/src/pages/Capture.tsx
```

Note the existing inline splitter at lines ~36-102 (mouse handlers + `<div role="separator">` block) and the existing imports at lines 1-3. We will replace the inline handlers with a callback to `VerticalSplitter` while keeping the storage / clamp logic local (Capture uses percent, not px).

- [ ] **Step 2: Replace the inline splitter with `VerticalSplitter`**

Rewrite `frontend/src/pages/Capture.tsx` to:

```tsx
import { useEffect, useRef, useState } from 'react';
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';
import VerticalSplitter from '../layout/VerticalSplitter';

function currentKstMonth(): { year: number; month: number } {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utcMs + 9 * 60 * 60_000);
  return { year: kst.getFullYear(), month: kst.getMonth() + 1 };
}

const STORAGE_KEY = 'capture.leftPct';
const DEFAULT_LEFT_PCT = 60;
const MIN_PCT = 25;
const MAX_PCT = 75;

function loadInitialPct(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(v) && v >= MIN_PCT && v <= MAX_PCT) return v;
  } catch {
    /* SSR / privacy mode — fall through */
  }
  return DEFAULT_LEFT_PCT;
}

function clamp(pct: number): number {
  return Math.max(MIN_PCT, Math.min(MAX_PCT, pct));
}

export default function Capture() {
  const { year, month } = currentKstMonth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState<number>(loadInitialPct);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(leftPct));
    } catch {
      /* ignore */
    }
  }, [leftPct]);

  const onDrag = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setLeftPct(clamp(pct));
  };

  const onNudge = (direction: -1 | 1, magnitude: 'small' | 'large') => {
    const step = magnitude === 'small' ? 1 : 5;
    setLeftPct((p) => clamp(p + direction * step));
  };

  return (
    <div
      ref={containerRef}
      style={{ gridTemplateColumns: `${leftPct}fr 12px ${100 - leftPct}fr` }}
      className="grid gap-0 p-4 h-full bg-bg text-fg"
    >
      <section className="bg-bg-card border rounded-lg p-4 overflow-y-auto">
        <CaptureForm referenceYear={year} referenceMonth={month} />
      </section>
      <VerticalSplitter
        ariaLabel={`패널 크기 조정 (${Math.round(leftPct)}% / ${Math.round(100 - leftPct)}%)`}
        ariaValueNow={Math.round(leftPct)}
        ariaValueMin={MIN_PCT}
        ariaValueMax={MAX_PCT}
        onDrag={onDrag}
        onReset={() => setLeftPct(DEFAULT_LEFT_PCT)}
        onNudge={onNudge}
      />
      <section className="bg-bg-card border rounded-lg p-3 flex flex-col min-h-0">
        <CaptureQueue />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Verify Capture page still renders without errors**

Open two terminals (or background the first):

```bash
cd frontend && npm run dev
```

Visit http://localhost:5173/capture and confirm:
1. The page renders with the two-pane layout.
2. The divider has the same visual (2px gray bar, accent on hover).
3. Dragging resizes the panes.
4. Double-clicking the divider snaps back to 60/40.
5. Reload the page — the last drag position persists.

Document this as a manual-verification step in your commit message. Stop the dev server after verification.

- [ ] **Step 4: Type-check + lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 5: Run any existing Capture.tsx tests**

```bash
cd frontend && npx vitest run src/pages 2>&1 | tail -20
```

Expected: pass, or "no tests found" if Capture has no direct tests. If existing tests reference internal handler names (`draggingRef`, `onDividerDown`), they should be removed in this commit since we replaced those internals.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Capture.tsx
git commit -m "refactor(capture): migrate inline splitter to VerticalSplitter"
```

---

## Task 5: Create `CollapsedSidebarHandle` component

A small floating button shown at the right edge when the sidebar is collapsed. Clicking it expands the sidebar via the store.

**Files:**
- Create: `frontend/src/replay/CollapsedSidebarHandle.tsx`
- Create: `frontend/src/replay/CollapsedSidebarHandle.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/replay/CollapsedSidebarHandle.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';

import CollapsedSidebarHandle from './CollapsedSidebarHandle';
import { useReplayLayoutStore } from '../state/replayLayout';

beforeEach(() => {
  useReplayLayoutStore.getState().__resetForTests();
  // Pre-collapse for these tests
  useReplayLayoutStore.getState().setSidebarCollapsed(true);
});

describe('CollapsedSidebarHandle', () => {
  it('renders a button with the expand label and aria-expanded=false', () => {
    render(<CollapsedSidebarHandle />);
    const btn = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'replay-sidebar');
  });

  it('clicking expands the sidebar (collapsed → false)', () => {
    render(<CollapsedSidebarHandle />);
    fireEvent.click(screen.getByRole('button', { name: '사이드바 보이기' }));
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/replay/CollapsedSidebarHandle.test.tsx
```

Expected: failure with `Cannot find module './CollapsedSidebarHandle'`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/replay/CollapsedSidebarHandle.tsx`:

```tsx
import { useReplayLayoutStore } from '../state/replayLayout';

/**
 * Floating right-edge button shown when the Cursor Sidebar is collapsed.
 * Clicking it expands the sidebar. Pairs with the Toolbar toggle as a
 * second entry point — see the 2026-05-24 Replay Sidebar Splitter spec.
 */
export default function CollapsedSidebarHandle() {
  const expand = () => useReplayLayoutStore.getState().setSidebarCollapsed(false);
  return (
    <button
      type="button"
      onClick={expand}
      aria-label="사이드바 보이기"
      aria-expanded={false}
      aria-controls="replay-sidebar"
      title="사이드바 보이기"
      className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-16 bg-bg-card border border-border-strong rounded-l text-fg-dim hover:text-accent hover:border-accent flex items-center justify-center text-xs font-mono"
    >
      ◀
    </button>
  );
}
```

- [ ] **Step 4: Run the test; expect pass**

```bash
cd frontend && npx vitest run src/replay/CollapsedSidebarHandle.test.tsx
```

Expected: 2 passed.

- [ ] **Step 5: Type-check + lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/replay/CollapsedSidebarHandle.tsx frontend/src/replay/CollapsedSidebarHandle.test.tsx
git commit -m "feat(replay): CollapsedSidebarHandle for the floating expand affordance"
```

---

## Task 6: Wire `Workarea` to use the store, splitter, and handle

Replace the static grid template with a dynamic one driven by `useReplayLayoutStore`. Mount the splitter + sidebar when not collapsed; mount the handle when collapsed.

**Files:**
- Modify: `frontend/src/replay/Workarea.tsx`
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Modify: `frontend/src/replay/Workarea.test.tsx`

- [ ] **Step 1: Extend `Workarea.test.tsx` with the new scenarios**

Append to `frontend/src/replay/Workarea.test.tsx`, after the existing `describe('Workarea — useRange wiring + RangeAdjustmentNotice', ...)` block:

```tsx
import { useReplayLayoutStore } from '../state/replayLayout';

vi.mock('./CollapsedSidebarHandle', () => ({
  default: () => <div data-testid="collapsed-handle-stub" />,
}));

describe('Workarea — sidebar splitter + collapse wiring', () => {
  beforeEach(() => {
    useReplayLayoutStore.getState().__resetForTests();
    useTabsStore.getState().reset?.();
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930',
      fromDate: '20260512',
      toDate: '20260512',
      timeframe: '1m',
    });
    (useRange as ReturnType<typeof vi.fn>).mockReturnValue({
      data: baseBundle,
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('renders sidebar + splitter when not collapsed', () => {
    const tab = useTabsStore.getState().tabs[0];
    wrap(<Workarea tab={tab} />);
    expect(screen.getByTestId('cursor-sidebar-stub')).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: /사이드바 폭 조정/ })).toBeInTheDocument();
    expect(screen.queryByTestId('collapsed-handle-stub')).toBeNull();
  });

  it('renders only the floating handle when collapsed', () => {
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    const tab = useTabsStore.getState().tabs[0];
    wrap(<Workarea tab={tab} />);
    expect(screen.queryByTestId('cursor-sidebar-stub')).toBeNull();
    expect(screen.queryByRole('separator', { name: /사이드바 폭 조정/ })).toBeNull();
    expect(screen.getByTestId('collapsed-handle-stub')).toBeInTheDocument();
  });

  it('splitter drag updates the store sidebarPx', () => {
    const tab = useTabsStore.getState().tabs[0];
    const { container } = wrap(<Workarea tab={tab} />);
    // Stub the container's bounding rect so onDrag has a stable rect.right.
    const root = container.querySelector('[data-testid="workarea-grid"]') as HTMLElement;
    expect(root).not.toBeNull();
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    } as DOMRect);
    const sep = screen.getByRole('separator', { name: /사이드바 폭 조정/ });
    fireEvent.mouseDown(sep, { clientX: 600 });
    fireEvent.mouseMove(window, { clientX: 600 }); // rect.right=1000, splitter-half=6, sidebar=1000-600-6=394
    fireEvent.mouseUp(window);
    expect(useReplayLayoutStore.getState().sidebarPx).toBe(394);
  });
});
```

Also add `fireEvent` to the imports at the top of the file:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
```

- [ ] **Step 2: Run the new tests; expect failure**

```bash
cd frontend && npx vitest run src/replay/Workarea.test.tsx
```

Expected: the three new tests fail (no wiring yet) while the existing three keep passing.

- [ ] **Step 3: Modify `Workarea.tsx`**

Rewrite the body of `Workarea.tsx` to read store state and conditionally render. Replace the existing return-statement's outer `<div className="flex flex-col h-full min-h-0 bg-bg">` block (lines 81-110 today) with the version below; keep the function signature, hooks, and `showNotice` / `onAdjust` logic intact.

Add imports at the top (alongside existing imports):

```tsx
import VerticalSplitter from '../layout/VerticalSplitter';
import { useReplayLayoutStore, SIDEBAR_PX_MIN, SIDEBAR_PX_MAX } from '../state/replayLayout';
import CollapsedSidebarHandle from './CollapsedSidebarHandle';
```

Also add `useRef` to the existing `useEffect, useMemo, useState` import from React:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
```

Then replace the return JSX (the `return ( <div className="flex flex-col h-full min-h-0 bg-bg"> … </div> );` block) with:

```tsx
  const sidebarPx = useReplayLayoutStore((s) => s.sidebarPx);
  const collapsed = useReplayLayoutStore((s) => s.sidebarCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);

  const gridTemplateColumns = collapsed ? '1fr' : `1fr 12px ${sidebarPx}px`;

  const onSplitterDrag = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // chart=1fr, splitter=12px, sidebar=<sidebarPx>px.
    // Sidebar's left edge = rect.right - sidebarPx.
    // We want sidebar.left = clientX + 6 (center of 12px splitter).
    const next = rect.right - clientX - 6;
    useReplayLayoutStore.getState().setSidebarPx(next);
  };

  const onSplitterNudge = (dir: -1 | 1, mag: 'small' | 'large') => {
    const step = mag === 'small' ? 8 : 40;
    // Convention: ArrowRight (dir=+1) shrinks the sidebar (chart grows).
    const next = useReplayLayoutStore.getState().sidebarPx - dir * step;
    useReplayLayoutStore.getState().setSidebarPx(next);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg">
      {showNotice && (
        <RangeAdjustmentNotice
          requestedFrom={fromDate!}
          requestedTo={toDate!}
          actualFirst={bundle!.segments[0].date}
          actualLast={bundle!.segments[bundle!.segments.length - 1].date}
          onAdjust={onAdjust}
          onDismiss={() => setNoticeDismissed(true)}
        />
      )}
      {bundle && (
        <InvariantOutcomesBanner
          excluded={bundle.excluded_dates ?? []}
          warnings={bundle.data_warnings ?? []}
        />
      )}
      <div
        ref={containerRef}
        data-testid="workarea-grid"
        style={{ gridTemplateColumns }}
        className="grid gap-2 p-2 flex-1 min-h-0 relative"
      >
        <ChartErrorBoundary>
          <ChartStage
            key={`${code}:${fromDate}:${toDate}`}
            bundle={bundle ?? null}
            axis={axis}
          />
        </ChartErrorBoundary>
        {!collapsed && (
          <>
            <VerticalSplitter
              ariaLabel={`사이드바 폭 조정 (현재 ${Math.round(sidebarPx)}px)`}
              ariaValueNow={Math.round(sidebarPx)}
              ariaValueMin={SIDEBAR_PX_MIN}
              ariaValueMax={SIDEBAR_PX_MAX}
              onDrag={onSplitterDrag}
              onReset={() => useReplayLayoutStore.getState().resetSidebar()}
              onNudge={onSplitterNudge}
            />
            <CursorSidebarConnected axis={axis} />
          </>
        )}
        {collapsed && <CollapsedSidebarHandle />}
      </div>
    </div>
  );
```

- [ ] **Step 4: Modify `CursorSidebar.tsx` — drop `w-sidebar`, add `id`**

In `frontend/src/sidebar/CursorSidebar.tsx`, locate the `<aside>` element (currently at line 51):

```tsx
    <aside className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg w-sidebar h-full min-h-0">
```

Replace with:

```tsx
    <aside
      id="replay-sidebar"
      className="grid grid-rows-[2fr_1fr_1fr] gap-2 p-2 bg-bg h-full min-h-0"
    >
```

The `w-sidebar` class is removed because the sidebar's width is now governed by its grid track in the parent. `id="replay-sidebar"` is the target for `aria-controls` on the Toolbar toggle and the CollapsedSidebarHandle.

- [ ] **Step 5: Run all Workarea + CursorSidebar tests**

```bash
cd frontend && npx vitest run src/replay/Workarea.test.tsx src/sidebar
```

Expected: all pass (3 original + 3 new in Workarea; any existing CursorSidebar tests untouched).

- [ ] **Step 6: Visual smoke check**

```bash
cd frontend && npm run dev
```

In a browser at http://localhost:5173/replay:
1. Load a stock so the Workarea is visible.
2. Drag the splitter — sidebar resizes, chart auto-resizes.
3. Reload — width persists.
4. Manually flip the store from devtools: `useReplayLayoutStore.getState().setSidebarCollapsed(true)` — sidebar disappears, floating handle appears at the right edge.
5. Click the floating handle — sidebar returns.

Stop the dev server.

- [ ] **Step 7: Type-check + lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/replay/Workarea.tsx frontend/src/replay/Workarea.test.tsx frontend/src/sidebar/CursorSidebar.tsx
git commit -m "feat(replay): dynamic Workarea grid + splitter + collapsed handle"
```

---

## Task 7: Add the Toolbar toggle button

The toggle is the primary entry point. When the sidebar is visible the button shows `▶` (hide); when collapsed it shows `◀` (show). `aria-expanded` reflects state; `aria-controls="replay-sidebar"`.

**Files:**
- Modify: `frontend/src/replay/Toolbar.tsx`
- Modify: `frontend/src/replay/Toolbar.test.tsx`

- [ ] **Step 1: Extend `Toolbar.test.tsx` with toggle scenarios**

Append to `frontend/src/replay/Toolbar.test.tsx`, after the existing describe block:

```tsx
import { useReplayLayoutStore } from '../state/replayLayout';

describe('Toolbar — sidebar toggle', () => {
  beforeEach(() => {
    useReplayLayoutStore.getState().__resetForTests();
    useTabsStore.getState().reset?.();
  });

  it('shows the hide label and aria-expanded=true when sidebar is visible', () => {
    renderToolbar();
    const btn = screen.getByRole('button', { name: '사이드바 숨기기' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAttribute('aria-controls', 'replay-sidebar');
  });

  it('shows the show label and aria-expanded=false when sidebar is collapsed', () => {
    useReplayLayoutStore.getState().setSidebarCollapsed(true);
    renderToolbar();
    const btn = screen.getByRole('button', { name: '사이드바 보이기' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the toggle flips the store', () => {
    renderToolbar();
    const btn = screen.getByRole('button', { name: '사이드바 숨기기' });
    fireEvent.click(btn);
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(true);
    // After collapse, the same button rerenders with the new label
    fireEvent.click(screen.getByRole('button', { name: '사이드바 보이기' }));
    expect(useReplayLayoutStore.getState().sidebarCollapsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new tests; expect failure**

```bash
cd frontend && npx vitest run src/replay/Toolbar.test.tsx
```

Expected: the three new tests fail (button doesn't exist yet); existing tests pass.

- [ ] **Step 3: Add the toggle button to `Toolbar.tsx`**

In `frontend/src/replay/Toolbar.tsx`, add an import at the top with the other store imports:

```tsx
import { useReplayLayoutStore } from '../state/replayLayout';
```

Inside the `Toolbar()` function body, just before the `return (` statement, add:

```tsx
  const sidebarCollapsed = useReplayLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = () => useReplayLayoutStore.getState().toggleSidebar();
```

In the JSX returned, insert a new `<button>` just **after** the existing `<span className="flex-1" />` spacer and **before** the `{rangeError && …}` block:

```tsx
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? '사이드바 보이기' : '사이드바 숨기기'}
        aria-expanded={!sidebarCollapsed}
        aria-controls="replay-sidebar"
        title={sidebarCollapsed ? '사이드바 보이기' : '사이드바 숨기기'}
        className="px-3 py-1.5 text-sm bg-bg-card text-fg-dim hover:text-fg border border-border rounded font-mono"
      >
        {sidebarCollapsed ? '◀' : '▶'}
      </button>
```

The final JSX order is: `StockCombobox` → `DateRangePicker` → `TimeframeSelector` → settings button → SettingsModal → `<span className="flex-1" />` → **sidebar toggle (new)** → `rangeError` → Load button.

- [ ] **Step 4: Run all Toolbar tests**

```bash
cd frontend && npx vitest run src/replay/Toolbar.test.tsx
```

Expected: all pass (original + 3 new).

- [ ] **Step 5: Visual smoke check**

```bash
cd frontend && npm run dev
```

At http://localhost:5173/replay:
1. The Toolbar shows a small `▶` button to the right of the settings/Load area.
2. Clicking it collapses the sidebar — chart fills the workarea, floating handle appears at the right edge.
3. The Toolbar button is now `◀`.
4. Clicking it again expands the sidebar.
5. Reload — collapsed state persists.

Stop the dev server.

- [ ] **Step 6: Type-check + lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/replay/Toolbar.tsx frontend/src/replay/Toolbar.test.tsx
git commit -m "feat(replay): Toolbar sidebar-toggle button"
```

---

## Task 8: Update `DESIGN.md`

Document that `--sidebar-w` is the default seed, and runtime ownership lives in `state/replayLayout.ts`.

**Files:**
- Modify: `DESIGN.md`

- [ ] **Step 1: Locate the layout section**

```bash
grep -n "sidebar\|Sidebar\|--sidebar-w\|layout" DESIGN.md | head -20
```

Identify a fitting insertion point — the section that describes how layout widths are tokenized. If there is no dedicated "Layout" section, append a new top-level subsection at the end of the file titled `## Runtime layout overrides`.

- [ ] **Step 2: Add the paragraph**

Insert (either inline next to the existing `--sidebar-w` mention or as a new subsection if none exists):

```markdown
### Runtime layout overrides (Cursor Sidebar)

`--sidebar-w` is the **default seed** for the `/replay` Cursor Sidebar's width.
Runtime width and collapsed state are owned by [`frontend/src/state/replayLayout.ts`](frontend/src/state/replayLayout.ts),
which persists `{ sidebarPx, sidebarCollapsed }` to `localStorage['replay.layout']`.
Users adjust the width via a vertical splitter and may collapse the sidebar
entirely (Toolbar toggle or floating right-edge handle). Double-clicking the
splitter resets the width to the current token value, so a future density-mode
change (ADR-0011) automatically reseeds. See ADR-0022 for the trade-off and the
boundary that prevents this carve-out from generalizing into a per-page layout
preferences system.
```

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): runtime override for Cursor Sidebar width"
```

---

## Task 9: Full-suite verification

Confirm the whole frontend type-checks, lints, and tests cleanly with the new code.

- [ ] **Step 1: Run the entire test suite**

```bash
cd frontend && npx vitest run
```

Expected: all green. If a pre-existing test fails, do not fix it here — surface it in the commit message and confirm with the user (out of scope for this plan).

- [ ] **Step 2: Run the full type-check**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 3: Run lint**

```bash
cd frontend && npm run lint
```

Expected: clean.

- [ ] **Step 4: Production build smoke**

```bash
cd frontend && npm run build 2>&1 | tail -15
```

Expected: build finishes without errors.

- [ ] **Step 5: End-to-end smoke in the browser**

Start the full dev stack (backend + frontend) per `CLAUDE.md`:

```bash
# Terminal 1 (backend)
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga

# Terminal 2 (frontend)
cd frontend && npm run dev
```

At http://localhost:5173/replay:
1. Load a stock-date that has data.
2. Drag the splitter left and right — sidebar resizes, chart and 10호가/거래원/체결 cards re-flow without flicker or layout jank.
3. Double-click splitter — returns to default width.
4. Press the splitter (focus), Arrow keys — small nudge (8px); Shift+Arrow — large nudge (40px); Enter — reset.
5. Toolbar toggle `▶` → sidebar disappears, chart fills the area, floating `◀` handle appears at the right edge.
6. Floating handle click → sidebar returns.
7. Reload — both width and collapsed state persist.
8. Visit http://localhost:5173/capture — confirm the Capture page splitter still works (no visual regression from the migration in Task 4).

Stop both servers.

- [ ] **Step 6: Final commit (only if there are dangling changes)**

If `git status` is clean, skip this step. Otherwise:

```bash
git status
# Review remaining unstaged changes — likely none.
```

---

## Spec Coverage Check

| Spec section | Covered by |
|---|---|
| §1 `VerticalSplitter.tsx` (new) | Task 3 |
| §2 `state/replayLayout.ts` (new) | Tasks 1, 2 |
| §3 Workarea layout modification | Task 6 |
| §4 `CollapsedSidebarHandle.tsx` (new) | Task 5 |
| §5 Toolbar toggle | Task 7 |
| §6 `CursorSidebar.tsx` id + drop `w-sidebar` | Task 6 (Step 4) |
| §7 DESIGN.md update | Task 8 |
| §Capture.tsx migration | Task 4 |
| Edge cases — localStorage unavailable, corrupt value, out-of-range | Task 2 tests |
| Edge cases — splitter drag past edge | Covered by clamp in Task 1, exercised in Task 3 manual + Task 6 store test |
| Edge cases — chart resize | No change needed (existing `autoSize: true`) — verified in Task 6 Step 6 and Task 9 Step 5 |
| Accessibility — separator ARIA | Task 3 tests + Task 6 wiring |
| Accessibility — toggle aria-expanded + aria-controls | Task 7 tests |
| Persistence per-user (not per-tab) | Task 2 (single localStorage key, no tab id) |
