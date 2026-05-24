# Replay Chart — Modifier-Aware Wheel Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `lightweight-charts`' built-in mouse-anchored wheel zoom with three modifier-aware behaviors on the `/replay` chart: plain wheel zooms anchored at the rightmost visible candle, `Shift+wheel` pans the time axis, `Ctrl/Cmd+wheel` zooms anchored at the mouse position.

**Architecture:** Disable the library's wheel handler via `handleScale: { mouseWheel: false }`. Own a single `wheel` listener on the chart container. Delegate all branch math to a pure helper `computeWheelOutcome` in a new file so the logic is unit-testable without mounting a chart. The helper returns a new `{ from, to }` logical range; the listener applies it via `timeScale.setVisibleLogicalRange(...)`. Existing zoom-in cap (`barSpacing > 50`) and zoom-out floor (`minBarSpacing`) continue to clamp automatically through their existing subscribers.

**Tech Stack:** TypeScript, React, Vite, Vitest (jsdom), `lightweight-charts` v5.

**Spec:** `docs/superpowers/specs/2026-05-24-replay-mouse-interactions-design.md`

**Working directory for all commands:** `frontend/` unless otherwise noted.

**Test runner:** `npx vitest run <pathOrPattern>` (no `npm run test` script exists).
**Type-check:** `npx tsc -b --noEmit` from `frontend/`.
**Lint:** `npm run lint` from `frontend/`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `frontend/src/util/wheelInteractions.ts` | **Create** | Pure `computeWheelOutcome(input) → {from,to} \| null` + types. No DOM, no library imports. |
| `frontend/src/util/wheelInteractions.test.ts` | **Create** | Vitest cases covering all three branches + edge cases. |
| `frontend/src/chart/ChartStage.tsx` | **Modify** | Add `handleScale: { mouseWheel: false }` to `createChart`; add `useEffect` that attaches a `wheel` listener and delegates to `computeWheelOutcome`. |

The helper lives in `util/` (alongside `auctionMask.ts`, `imbalance.ts`, etc.) because the project's convention is "pure logic in `util/`, React/effects in feature directories." Keeping it out of `ChartStage.tsx` lets us unit-test without rendering the chart component.

---

## Task 1: Pure helper — types + branch logic via TDD

**Files:**
- Create: `frontend/src/util/wheelInteractions.ts`
- Create: `frontend/src/util/wheelInteractions.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `frontend/src/util/wheelInteractions.test.ts` with the following content:

```ts
import { describe, expect, it, vi } from 'vitest';
import { computeWheelOutcome, type WheelInput } from './wheelInteractions';

// Reusable base — tests override the fields they care about.
function baseInput(over: Partial<WheelInput> = {}): WheelInput {
  return {
    range: { from: 0, to: 100 },
    deltaY: 100,
    shiftKey: false,
    ctrlOrMetaKey: false,
    mouseX: 0,
    coordinateToLogical: () => 50,
    ...over,
  };
}

describe('computeWheelOutcome', () => {
  describe('plain wheel — right-edge-anchored zoom', () => {
    it('zooms out keeping `to` fixed when deltaY > 0', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: 100 }));
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeLessThan(0); // span grew, `from` moved left
    });

    it('zooms in keeping `to` fixed when deltaY < 0', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: -100 }));
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeGreaterThan(0); // span shrank, `from` moved right
    });

    it('does not call coordinateToLogical when no Ctrl/Cmd', () => {
      const spy = vi.fn(() => 50);
      computeWheelOutcome(baseInput({ deltaY: 100, coordinateToLogical: spy }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl/Cmd wheel — mouse-anchored zoom', () => {
    it('expands both edges outward from the anchor on zoom out', () => {
      const out = computeWheelOutcome(
        baseInput({
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50, // anchor in the middle
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.from).toBeLessThan(0);
      expect(out!.to).toBeGreaterThan(100);
    });

    it('contracts both edges toward the anchor on zoom in', () => {
      const out = computeWheelOutcome(
        baseInput({
          deltaY: -100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.from).toBeGreaterThan(0);
      expect(out!.to).toBeLessThan(100);
    });

    it('falls back to `to` as anchor when coordinateToLogical returns null', () => {
      const out = computeWheelOutcome(
        baseInput({
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => null,
        }),
      );
      // With anchor = to (100), span 100 → factor ~1.105
      // from' = 100 - (100 - 0) * 1.105 ≈ -10.5; to' = 100 + (100 - 100) * 1.105 = 100
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeLessThan(0);
    });
  });

  describe('Shift wheel — pan', () => {
    it('pans right (toward future) on deltaY > 0, span unchanged', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: 100, shiftKey: true }));
      expect(out).toEqual({ from: 10, to: 110 });
    });

    it('pans left (toward past) on deltaY < 0', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: -100, shiftKey: true }));
      expect(out).toEqual({ from: -10, to: 90 });
    });

    it('returns null when deltaY is zero (no direction)', () => {
      expect(computeWheelOutcome(baseInput({ deltaY: 0, shiftKey: true }))).toBeNull();
    });
  });

  describe('modifier precedence', () => {
    it('Shift wins over Ctrl/Cmd when both held', () => {
      const out = computeWheelOutcome(
        baseInput({ deltaY: 100, shiftKey: true, ctrlOrMetaKey: true }),
      );
      // Pan result, not zoom
      expect(out).toEqual({ from: 10, to: 110 });
    });
  });

  describe('degenerate inputs', () => {
    it('returns null for zero-width range', () => {
      expect(
        computeWheelOutcome(baseInput({ range: { from: 5, to: 5 } })),
      ).toBeNull();
    });

    it('returns null for negative-width range', () => {
      expect(
        computeWheelOutcome(baseInput({ range: { from: 10, to: 5 } })),
      ).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the new tests; expect them to fail**

```bash
cd frontend && npx vitest run src/util/wheelInteractions.test.ts
```

Expected: FAIL with "Failed to resolve import './wheelInteractions'" (file does not exist yet).

- [ ] **Step 3: Create the pure helper to make the tests pass**

Create `frontend/src/util/wheelInteractions.ts` with the following content:

```ts
/**
 * Pure helper that computes a new lightweight-charts logical range
 * (`{from, to}`) for one wheel event on the replay chart.
 *
 * Three branches, selected by modifiers:
 *  - `shiftKey` → pan: translate the range, span unchanged.
 *  - `ctrlOrMetaKey` → zoom anchored at the mouse coordinate.
 *  - default → zoom anchored at `range.to` (rightmost visible candle).
 *
 * No DOM, no chart library — separated so the branching logic is
 * unit-testable without mounting a chart.
 *
 * See: `docs/superpowers/specs/2026-05-24-replay-mouse-interactions-design.md`
 */

export interface WheelInput {
  range: { from: number; to: number };
  deltaY: number;
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
  /** Mouse X relative to the chart container's left edge, in CSS px. */
  mouseX: number;
  /** Chart `timeScale.coordinateToLogical(x)` callback (may return null). */
  coordinateToLogical: (x: number) => number | null;
}

export type WheelOutcome = { from: number; to: number } | null;

export function computeWheelOutcome(i: WheelInput): WheelOutcome {
  const { from, to } = i.range;
  const span = to - from;
  if (span <= 0) return null;

  if (i.shiftKey) {
    const dir = Math.sign(i.deltaY);
    if (dir === 0) return null;
    const step = span * 0.1 * dir;
    return { from: from + step, to: to + step };
  }

  // deltaY > 0 (wheel down) → factor > 1 → zoom OUT.
  // deltaY < 0 (wheel up) → factor < 1 → zoom IN.
  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    return {
      from: anchor - (anchor - from) * factor,
      to: anchor + (to - anchor) * factor,
    };
  }

  // Default: right-edge-anchored zoom — `to` stays fixed.
  return { from: to - span * factor, to };
}
```

- [ ] **Step 4: Run the tests; expect them to pass**

```bash
cd frontend && npx vitest run src/util/wheelInteractions.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Type-check and lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean exit on both.

- [ ] **Step 6: Commit**

```bash
cd .. && git add frontend/src/util/wheelInteractions.ts frontend/src/util/wheelInteractions.test.ts
git commit -m "feat(chart): pure helper for modifier-aware wheel interactions

computeWheelOutcome decides the new visible logical range for one wheel
event based on shift/ctrl/cmd modifiers. Pure, no DOM, no chart library
— branch math is unit-testable without mounting a chart.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire the helper into ChartStage

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx` (two edits — `createChart` options block, new `useEffect` for the wheel listener)

- [ ] **Step 1: Disable the library's built-in wheel handler**

Open `frontend/src/chart/ChartStage.tsx`. Locate the `createChart(containerRef.current, { ... })` call around [ChartStage.tsx:107](frontend/src/chart/ChartStage.tsx#L107). Inside the options object, after the existing `rightPriceScale` field and before `autoSize: true`, insert:

```ts
      // We own wheel interactions via a custom listener (Task 2 of the
      // replay-mouse-interactions plan). Disable the library's built-in
      // mouse-anchored zoom so the two paths can't fight over the visible
      // range. `pinch`, `axisPressedMouseMove`, `axisDoubleClickReset` stay
      // at defaults — only the wheel is reclaimed.
      handleScale: { mouseWheel: false },
```

The surrounding context after the edit should look like:

```ts
      rightPriceScale: { borderColor: tokens.border },
      handleScale: { mouseWheel: false },
      autoSize: true,
    });
```

- [ ] **Step 2: Add an import for the helper**

At the top of `frontend/src/chart/ChartStage.tsx`, add a new import line alongside the other `../util/*` imports (after the `resolveTokens` and `chartScale` imports, before the store imports):

```ts
import { computeWheelOutcome } from '../util/wheelInteractions';
```

- [ ] **Step 3: Add the wheel listener `useEffect`**

After the existing "Initial fit-to-data + zoom-out floor" `useEffect` block (the one that ends around [ChartStage.tsx:305](frontend/src/chart/ChartStage.tsx#L305) with `}, [chart, bundle]);`), insert a new `useEffect`:

```tsx
  // Custom wheel handler — replaces the library's mouse-anchored default
  // with three modifier-aware behaviors:
  //   wheel              → zoom, right-edge anchored (latest visible candle)
  //   Shift + wheel      → pan time axis (no zoom)
  //   Ctrl/Cmd + wheel   → zoom, mouse-position anchored
  // The library's own wheel handler is disabled in createChart options.
  // Branch math lives in `util/wheelInteractions.ts` so it's testable
  // without a chart. Existing clamps (`barSpacing > 50` cap,
  // `minBarSpacing` floor) still apply because they run off the
  // `subscribeVisibleLogicalRangeChange` callback regardless of who
  // changed the range.
  useEffect(() => {
    const container = containerRef.current;
    if (!chart || !container) return;
    const ts = chart.timeScale();

    const onWheel = (e: WheelEvent) => {
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const outcome = computeWheelOutcome({
        range,
        deltaY: e.deltaY,
        shiftKey: e.shiftKey,
        ctrlOrMetaKey: e.ctrlKey || e.metaKey,
        mouseX: e.clientX - rect.left,
        coordinateToLogical: (x) => ts.coordinateToLogical(x),
      });
      if (outcome) ts.setVisibleLogicalRange(outcome);
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [chart]);
```

The `passive: false` option is required so `preventDefault()` actually suppresses page scroll, particularly for `Shift + wheel` which the browser would otherwise treat as horizontal page scroll.

- [ ] **Step 4: Type-check and lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean exit. If lint complains about the `useEffect` dependency array (`chart` only, not `containerRef`), keep it — `containerRef` is a `useRef`, not reactive; ESLint's React-Hooks rule allows omitting refs.

- [ ] **Step 5: Run the full frontend test suite to confirm nothing broke**

```bash
cd frontend && npx vitest run
```

Expected: all tests pass, including the new `wheelInteractions.test.ts`. Pay attention to any `ChartStage`-adjacent tests; if any break, read the failure carefully — the most likely cause is a missed import or a stray brace.

- [ ] **Step 6: Commit**

```bash
cd .. && git add frontend/src/chart/ChartStage.tsx
git commit -m "feat(chart): wire modifier-aware wheel handler into ChartStage

Disable lightweight-charts' built-in wheel zoom via handleScale.mouseWheel
=false; attach a single wheel listener on the chart container that delegates
to computeWheelOutcome. Plain wheel anchors at the rightmost visible candle,
Shift+wheel pans, Ctrl/Cmd+wheel anchors at the mouse position.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Manual verification on the live `/replay` page

This task has no automated test — chart interactions must be felt in the browser.

**Files:** none (verification only).

- [ ] **Step 1: Start the dev servers (if not already running)**

From repo root, in two separate terminals (or via VS Code's `Dev: backend + frontend` task):

```bash
# Terminal 1 — backend
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga

# Terminal 2 — frontend
cd frontend && npm run dev
```

Wait for `Application startup complete.` and Vite's `ready in` line.

- [ ] **Step 2: Open the replay viewer and load a stock-date**

Navigate to `http://localhost:5173/replay`. Pick any code with captured data. Wait for the chart to fully render.

- [ ] **Step 3: Verify plain wheel — right-edge-anchored zoom**

Hover the cursor near the **left** edge of the chart so it's clear which side is moving. Scroll wheel down (zoom out). Confirm:
- The rightmost visible candle stays pinned at the same X position on screen.
- More candles appear on the left.
- Page does not scroll.

Then scroll wheel up (zoom in). The rightmost candle stays pinned; the chart magnifies toward it.

- [ ] **Step 4: Verify Shift + wheel — pan**

Hold Shift and scroll wheel down. Confirm:
- The chart's visible window slides to the right (toward later time / future direction).
- The number of visible bars stays the same (no zoom).
- Page does not scroll horizontally.

Scroll up with Shift held — the window slides left.

- [ ] **Step 5: Verify Ctrl/Cmd + wheel — mouse-anchored zoom**

Position the cursor over a recognizable candle in the middle of the chart. Hold `Ctrl` (Linux/Windows) or `Cmd` (macOS) and scroll. Confirm:
- The candle directly under the cursor stays under the cursor as the chart zooms.
- Both edges (left and right) move proportionally.

- [ ] **Step 6: Verify existing clamps still apply**

- Spam wheel-up (zoom in) with no modifier. The chart should reach a maximum zoom and stop magnifying — the `barSpacing > 50` cap at [ChartStage.tsx:293-300](frontend/src/chart/ChartStage.tsx#L293-L300) is firing.
- Spam wheel-down (zoom out) with no modifier. The chart should reach a minimum zoom where all bars fit and stop — the `minBarSpacing` floor at [ChartStage.tsx:278](frontend/src/chart/ChartStage.tsx#L278) is firing.

- [ ] **Step 7: Verify Cursor Sidebar still tracks**

With the cursor still on the chart, observe that the Cursor Sidebar's 10호가 / 거래원 / 체결 cards update as the mouse moves. After a wheel event without hover movement, the cards should reflect the new viewport's right edge (PriceStrip fallback).

- [ ] **Step 8: Verify on a multi-day Stock-Date Range**

Switch to a date range spanning at least 2 trading days. Repeat steps 3-5. In particular, pan with `Shift + wheel` across a Day Boundary (the dotted vertical separator) — the chart should slide smoothly through it.

- [ ] **Step 9: Commit any tweaks (if needed)**

If verification revealed a behavior gap (e.g., zoom factor feels too aggressive on trackpad, pan direction feels reversed), adjust the constants in `wheelInteractions.ts` (`0.001` exponent, `0.1` pan-step ratio) and the corresponding test expectations, then commit:

```bash
cd .. && git add frontend/src/util/wheelInteractions.ts frontend/src/util/wheelInteractions.test.ts
git commit -m "fix(chart): tune wheel interaction constants from manual testing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If verification passes with no changes, this step is a no-op — proceed to Task 4.

---

## Task 4: Final verification — full lint + tsc + vitest

**Files:** none (verification only).

- [ ] **Step 1: Run lint, type-check, and full test suite together**

```bash
cd frontend && npm run lint && npx tsc -b --noEmit && npx vitest run
```

Expected: all three exit clean.

- [ ] **Step 2: Confirm git status is clean**

```bash
cd .. && git status
```

Expected: `nothing to commit, working tree clean`. All three task commits (Task 1, Task 2, and optionally Task 3) should appear in `git log`.

- [ ] **Step 3: Done**

The feature is implemented, tested, and verified. The next step in the chain (per the parent session) is `/improve-codebase-architecture` to look for adjacent refactor wins.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Plan task |
|---|---|
| `handleScale.mouseWheel: false` in createChart | Task 2 Step 1 |
| Custom `wheel` listener on container | Task 2 Step 3 |
| `passive: false` for preventDefault | Task 2 Step 3 |
| `computeWheelOutcome` pure helper | Task 1 Step 3 |
| Plain wheel = right-edge anchor | Task 1 Step 3 (default branch) + Task 3 Step 3 |
| Shift wheel = pan | Task 1 Step 3 (shift branch) + Task 3 Step 4 |
| Ctrl/Cmd wheel = mouse anchor | Task 1 Step 3 (ctrlOrMetaKey branch) + Task 3 Step 5 |
| Shift wins over Ctrl when both | Task 1 Step 1 (test in modifier-precedence describe block) |
| Zero-deltaY guard in pan | Task 1 Step 1 (test) + Step 3 (`if (dir === 0) return null;`) |
| Span ≤ 0 guard | Task 1 Step 1 (test) + Step 3 (`if (span <= 0) return null;`) |
| coordinateToLogical null fallback | Task 1 Step 1 (test) + Step 3 (`?? to`) |
| `setVisibleLogicalRange` applies outcome | Task 2 Step 3 |
| Existing barSpacing cap / minBarSpacing floor still apply | Task 3 Step 6 |
| Cursor still tracks via PriceStrip fallback | Task 3 Step 7 |
| Multi-day / Day Boundary case works | Task 3 Step 8 |

All spec items have a task. No gaps.

**Placeholder scan:** No TBD/TODO/handwave language. Every code step shows complete code. Every command shows expected output. ✓

**Type consistency:** `WheelInput` and `WheelOutcome` defined in Task 1 Step 3 and referenced verbatim in Task 1 Step 1 (tests) and Task 2 Step 3 (consumer). `computeWheelOutcome` signature stable. `coordinateToLogical: (x: number) => number | null` matches lightweight-charts v5's actual return type. ✓
