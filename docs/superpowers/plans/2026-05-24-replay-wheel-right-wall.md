# Replay Chart — Wheel Right Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-edge wall to ctrl/cmd+wheel zoom-out and shift+wheel pan-right on the `/replay` chart so neither can push `to` past the last candle's logical index.

**Architecture:** Extend the pure helper `computeWheelOutcome` with a `maxTo` parameter. Both ctrl and shift branches check the new range's `to` against `maxTo` and clamp when rightward motion would exceed it — ctrl keeps the computed `from` (anchor migrates to right edge), shift preserves span (window stops translating). Plain wheel is unchanged. The wall threshold comes from `bundle.candles.length - 1` and is passed in from ChartStage; an empty-bundle guard yields `Number.POSITIVE_INFINITY` to disable the wall while data is loading.

**Tech Stack:** TypeScript, React, Vite, Vitest (jsdom), `lightweight-charts` v5.

**Spec:** `docs/superpowers/specs/2026-05-24-replay-wheel-right-wall-design.md`

**Working directory for all commands:** `frontend/` unless otherwise noted.

**Test runner:** `npx vitest run <pathOrPattern>` (no `npm run test` script).
**Type-check:** `npx tsc -b --noEmit` from `frontend/`.
**Lint:** `npm run lint` from `frontend/`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `frontend/src/util/wheelInteractions.ts` | **Modify** | Add `maxTo: number` to `WheelInput`; clamp logic in shift and ctrl branches. |
| `frontend/src/util/wheelInteractions.test.ts` | **Modify** | Add `maxTo` to the `baseInput()` default (`Infinity`); add 7 new test cases for wall behavior. |
| `frontend/src/chart/ChartStage.tsx` | **Modify** | Compute `maxTo` from `bundle` (with empty-bundle guard); pass to the helper; expand effect deps to `[chart, bundle]`. |

No new files.

---

## Task 1: Extend the helper with `maxTo` (TDD)

**Files:**
- Modify: `frontend/src/util/wheelInteractions.test.ts`
- Modify: `frontend/src/util/wheelInteractions.ts`

- [ ] **Step 1: Add `maxTo` default to the test fixture, write new failing tests**

Open `frontend/src/util/wheelInteractions.test.ts`. Find the `baseInput()` function at the top. Add `maxTo: Number.POSITIVE_INFINITY` to its default override base:

```ts
function baseInput(over: Partial<WheelInput> = {}): WheelInput {
  return {
    range: { from: 0, to: 100 },
    deltaY: 100,
    shiftKey: false,
    ctrlOrMetaKey: false,
    mouseX: 0,
    coordinateToLogical: () => 50,
    maxTo: Number.POSITIVE_INFINITY,
    ...over,
  };
}
```

Then append a new top-level `describe` block to the bottom of the file, before the final closing `});`:

```ts
  describe('right wall — Ctrl/Cmd zoom-out clamp', () => {
    it('clamps `to` to maxTo when ctrl zoom-out would push past the wall', () => {
      // range={50,99}, anchor=80, deltaY=100, maxTo=100
      // span=49, factor=exp(0.1)≈1.105
      // newFrom = 80 - (80-50)*1.105 ≈ 46.85
      // newTo   = 80 + (99-80)*1.105 ≈ 100.99  → clamp to 100
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 99 },
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 80,
          maxTo: 100,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeCloseTo(46.85, 1);
    });

    it('does not clamp ctrl zoom-out that stays under the wall', () => {
      // range={50,90}, anchor=70, deltaY=100, maxTo=100
      // newTo ≈ 70 + 20*1.105 = 92.1 — below wall
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 90 },
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 70,
          maxTo: 100,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBeCloseTo(92.1, 1);
      expect(out!.from).toBeCloseTo(47.9, 1);
    });

    it('does not clamp ctrl zoom-in even when current `to` is past the wall', () => {
      // range={0,115}, anchor=50, deltaY=-100, maxTo=100
      // factor < 1 — newTo < to, direction gate prevents clamp
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 115 },
          deltaY: -100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50,
          maxTo: 100,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBeLessThan(115);
      // No clamp applied — to should be the formula value, not 100.
      expect(out!.to).not.toBe(100);
    });
  });

  describe('right wall — Shift pan-right clamp', () => {
    it('does not clamp shift pan-right that stays under the wall', () => {
      // range={50,90}, deltaY=100, maxTo=100; span=40, step=4 → newTo=94
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 90 },
          deltaY: 100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 54, to: 94 });
    });

    it('clamps shift pan-right at the wall, preserving span', () => {
      // range={50,99}, deltaY=100, maxTo=100; span=49, step=4.9 → newTo=103.9
      // Clamp to=100, from=100-49=51
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 99 },
          deltaY: 100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 51, to: 100 });
    });

    it('does not clamp shift pan-left even when `to` is past the wall', () => {
      // range={20,115}, deltaY=-100, maxTo=100; step=-9.5
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 20, to: 115 },
          deltaY: -100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 10.5, to: 105.5 });
    });

    it('clamps shift pan-right with large span preserving span at wall', () => {
      // range={5,95}, deltaY=100, maxTo=100; span=90, step=9 → newTo=104
      // Clamp to=100, from=100-90=10
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 5, to: 95 },
          deltaY: 100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 10, to: 100 });
    });
  });

  describe('right wall — plain wheel and Infinity maxTo', () => {
    it('plain wheel ignores maxTo entirely', () => {
      // Plain wheel keeps `to` fixed regardless of maxTo.
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 100 },
          deltaY: 100,
          maxTo: 50, // wall well below current to
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100); // unchanged
      expect(out!.from).toBeLessThan(0);
    });

    it('maxTo=Infinity preserves pre-wall behavior on ctrl', () => {
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 100 },
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50,
          maxTo: Number.POSITIVE_INFINITY,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBeGreaterThan(100); // no clamp
    });

    it('maxTo=Infinity preserves pre-wall behavior on shift', () => {
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 100 },
          deltaY: 100,
          shiftKey: true,
          maxTo: Number.POSITIVE_INFINITY,
        }),
      );
      expect(out).toEqual({ from: 10, to: 110 });
    });
  });
```

- [ ] **Step 2: Run the new tests; expect them to fail**

```bash
cd frontend && npx vitest run src/util/wheelInteractions.test.ts
```

Expected: FAIL on the new wall tests (helper doesn't know about `maxTo` yet). Existing tests should fail with a TypeScript error since `WheelInput` doesn't yet include `maxTo` — that's expected.

Note: if vitest doesn't error on the missing field due to spread semantics, the wall tests will fail on the `expect(out!.to).toBe(100)` clamp assertions. Either failure mode is acceptable.

- [ ] **Step 3: Update the helper to add `maxTo` and the clamp logic**

Open `frontend/src/util/wheelInteractions.ts`. Replace the entire file content with:

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
 * Right wall: ctrl and shift branches clamp when rightward motion would
 * push `to` past `maxTo` (typically the last candle's logical index).
 * Plain wheel is unaffected because it never increases `to`.
 *
 * No DOM, no chart library — separated so the branching logic is
 * unit-testable without mounting a chart.
 *
 * See: `docs/superpowers/specs/2026-05-24-replay-mouse-interactions-design.md`,
 *      `docs/superpowers/specs/2026-05-24-replay-wheel-right-wall-design.md`
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
  /**
   * Upper bound for the result's `to`. Typically `bundle.candles.length - 1`
   * — the logical index of the last candle in the active RangeBundle.
   * Pass `Number.POSITIVE_INFINITY` to disable the wall (e.g., before data
   * loads).
   */
  maxTo: number;
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
    const newFrom = from + step;
    const newTo = to + step;
    // Right wall: panning right past the last candle stops translating —
    // pin `to` at maxTo, preserve span.
    if (step > 0 && newTo > i.maxTo) {
      return { from: i.maxTo - span, to: i.maxTo };
    }
    return { from: newFrom, to: newTo };
  }

  // deltaY > 0 (wheel down) → factor > 1 → zoom OUT.
  // deltaY < 0 (wheel up) → factor < 1 → zoom IN.
  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    const newFrom = anchor - (anchor - from) * factor;
    const newTo = anchor + (to - anchor) * factor;
    // Right wall: zoom-out that pushes `to` past the last candle clamps `to`
    // to maxTo and keeps the computed `from`. The anchor effectively migrates
    // to the right edge for this and subsequent zoom-out ticks. Direction
    // gate (`newTo > to`) ensures zoom-IN doesn't clamp even when `to` is
    // already past maxTo (initial state with rightOffset).
    if (newTo > to && newTo > i.maxTo) {
      return { from: newFrom, to: i.maxTo };
    }
    return { from: newFrom, to: newTo };
  }

  // Default: right-edge-anchored zoom — `to` stays fixed.
  return { from: to - span * factor, to };
}
```

- [ ] **Step 4: Run all helper tests; expect all to pass**

```bash
cd frontend && npx vitest run src/util/wheelInteractions.test.ts
```

Expected: PASS, 19 tests total (12 pre-existing + 7 new wall tests).

- [ ] **Step 5: Type-check and lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: no NEW errors from your changes. Note: at the time of writing this plan there is already at least one pre-existing `tsc` error in `ChartStage.tsx` (`candleSeries declared but never read` from an in-flight refactor unrelated to wheel work) and ~107 pre-existing lint errors in unrelated files. Confirm any errors are pre-existing (run `git stash` to verify the same errors appear without your changes if needed) — do not attempt to fix unrelated pre-existing errors as part of this task.

- [ ] **Step 6: Commit**

```bash
cd .. && git add frontend/src/util/wheelInteractions.ts frontend/src/util/wheelInteractions.test.ts
git commit -m "feat(chart): right wall in computeWheelOutcome (maxTo)

Ctrl/Cmd zoom-out clamps to maxTo and keeps computed from (mouse anchor
migrates to right edge). Shift pan-right clamps to maxTo and preserves
span. Plain wheel and zoom-in are unaffected — direction-gated checks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire `maxTo` from ChartStage

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx` (two edits — compute `maxTo` inside the wheel `useEffect`, add `bundle` to the deps array)

- [ ] **Step 1: Locate the wheel `useEffect` and update it**

Open `frontend/src/chart/ChartStage.tsx`. Find the wheel `useEffect` (currently around lines 313-348, ending with `}, [chart]);`). Replace its body to compute `maxTo` and pass it to the helper:

Find this:

```tsx
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

Replace with:

```tsx
  useEffect(() => {
    const container = containerRef.current;
    if (!chart || !container) return;
    const ts = chart.timeScale();
    // `candles.length === 0` would yield maxTo=-1 and clamp every wheel
    // event to a degenerate range — guard against the brief empty-bundle
    // window before data loads.
    const maxTo =
      bundle && bundle.candles.length > 0
        ? bundle.candles.length - 1
        : Number.POSITIVE_INFINITY;

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
        maxTo,
      });
      if (outcome) ts.setVisibleLogicalRange(outcome);
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [chart, bundle]);
```

Three changes:
1. New `maxTo` constant with empty-bundle guard.
2. `maxTo` added to the `computeWheelOutcome` arg.
3. Effect deps array changed from `[chart]` to `[chart, bundle]` so the closure captures the latest `maxTo` whenever the active **RangeBundle** changes (Stock-Date Range swap, Timeframe change, etc.).

- [ ] **Step 2: Type-check and lint**

```bash
cd frontend && npx tsc -b --noEmit && npm run lint
```

Expected: clean (no new errors). The `bundle` symbol is already in scope — it's a prop on `ChartStage`.

- [ ] **Step 3: Run the full frontend test suite**

```bash
cd frontend && npx vitest run
```

Expected: all tests pass (652 + 7 new = 659).

- [ ] **Step 4: Commit**

```bash
cd .. && git add frontend/src/chart/ChartStage.tsx
git commit -m "feat(chart): wire right-wall maxTo from active RangeBundle

Pass bundle.candles.length-1 as maxTo to computeWheelOutcome with an
empty-bundle guard (Infinity) so the wall is disabled while data is
loading. Effect deps gain bundle so the listener re-attaches with a
fresh maxTo whenever the active RangeBundle changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Manual verification on `/replay`

This task has no automated test — wall behavior must be felt in the browser.

**Files:** none (verification only).

- [ ] **Step 1: Ensure dev servers are running**

If not already running (from the previous wheel-interactions verification session):

```bash
# From repo root, in separate terminals:
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
cd frontend && npm run dev
```

Wait for `Application startup complete.` and `ready in`.

- [ ] **Step 2: Open the replay viewer and load data**

Navigate to `http://localhost:5173/replay`. Pick a stock-date with > 100 candles. Wait for the chart to fully render.

- [ ] **Step 3: Verify ctrl/cmd+wheel-out wall**

Hover near the chart middle. Hold `Ctrl` (or `Cmd` on macOS) and scroll wheel down repeatedly. Confirm:
- The first tick snaps the rightmost ~15-bar empty padding tight against the last candle.
- Subsequent ticks extend the left side only; the last candle stays glued to the right edge of the viewport.
- The chart never shows empty space past the last candle.

- [ ] **Step 4: Verify ctrl/cmd+wheel-in unaffected**

While at the wall (last candle pinned right), reverse direction — hold ctrl/cmd and scroll up. Confirm:
- The chart zooms in smoothly toward the cursor position.
- The last candle un-pins from the right edge as the visible window shrinks.
- No jerky snap.

- [ ] **Step 5: Verify shift+wheel pan-right wall**

Scroll forward (shift + wheel down) until the visible window slides toward the last candle. Confirm:
- The window stops translating once the last candle reaches the right edge.
- The visible span (number of bars visible) is preserved at the moment of hitting the wall.
- Continuing to shift+wheel-down is visually a no-op (already at the wall).

- [ ] **Step 6: Verify shift+wheel pan-left unaffected**

From any state (including at the wall), shift+wheel up. Confirm:
- The window pans left freely.
- If you started past the wall (e.g., immediately after data load before any tightening), shift+wheel left should still work without unexpected clamping.

- [ ] **Step 7: Verify plain wheel unaffected**

With no modifiers, scroll wheel up/down. Confirm:
- Behavior is identical to before this change — zoom anchored at the right edge of the visible range.
- No wall interaction.

- [ ] **Step 8: Verify across Stock-Date Range / Timeframe changes**

Switch to a different stock-date or change the Timeframe. Confirm:
- The wall threshold updates to the new last-candle index.
- ctrl/shift wheel behavior matches expectations on the new data.

- [ ] **Step 9: Verify empty/loading state**

If feasible, observe the brief moment between selecting a new Stock-Date and the **RangeBundle** loading. During that time `bundle` may be null. Confirm that ctrl/shift wheel doesn't snap to a broken range during the load (the `Infinity` guard should keep behavior identical to the pre-wall version).

If verification reveals a behavior gap (e.g., snap feels too aggressive, want `lastBarIndex + 15` padding instead of strict `lastBarIndex`), edit the `maxTo` computation in `ChartStage.tsx` Step 1 (`bundle.candles.length - 1 + 15`) and re-run verification. Commit any tuning as a separate `fix(chart):` commit.

---

## Task 4: Final lint + tsc + vitest sweep

**Files:** none (verification only).

- [ ] **Step 1: Run lint, type-check, and full test suite together**

```bash
cd frontend && npm run lint && npx tsc -b --noEmit && npx vitest run
```

Expected: vitest reports 659 passing tests across 87 files. For lint and tsc, confirm no NEW errors from this branch's changes — pre-existing errors (notably `candleSeries declared but never read` in ChartStage from an in-flight refactor) are out of scope and should be left alone.

- [ ] **Step 2: Confirm git status is clean**

```bash
cd .. && git status
```

Expected: `nothing to commit, working tree clean`.

- [ ] **Step 3: Done**

The right-wall feature is implemented, tested, and ready. Next step in the parent chain is `/improve-codebase-architecture`.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Plan task |
|---|---|
| `WheelInput.maxTo` field added | Task 1 Step 3 |
| Ctrl branch: clamp on `newTo > to && newTo > maxTo`, keep computed `from` | Task 1 Step 3 (lines in ctrl branch) + Task 1 Step 1 (3 ctrl wall tests) |
| Shift branch: clamp on `step > 0 && newTo > maxTo`, preserve span | Task 1 Step 3 (lines in shift branch) + Task 1 Step 1 (4 shift wall tests) |
| Plain wheel branch unchanged | Task 1 Step 3 (default branch unchanged) + Task 1 Step 1 ("plain wheel ignores maxTo" test) |
| `maxTo = Infinity` disables wall | Task 1 Step 3 (comparison falls through) + Task 1 Step 1 (2 Infinity tests) |
| Empty-bundle guard in ChartStage | Task 2 Step 1 |
| Effect deps include `bundle` | Task 2 Step 1 |
| Direction gate prevents zoom-in clamp when `to > maxTo` | Task 1 Step 1 ("does not clamp ctrl zoom-in even when current `to` is past the wall") |
| Direction gate prevents pan-left clamp | Task 1 Step 1 ("does not clamp shift pan-left even when `to` is past the wall") |
| Manual: first ctrl tick snaps padding tight | Task 3 Step 3 |
| Manual: shift pan-right preserves span at wall | Task 3 Step 5 |
| Manual: wall threshold updates on bundle change | Task 3 Step 8 |
| Manual: empty/loading state doesn't break | Task 3 Step 9 |

All spec items have a task. No gaps.

**Placeholder scan:** No TBD/TODO. Every code step has complete code. Every command has expected output. ✓

**Type consistency:** `WheelInput.maxTo: number` defined once in Task 1 Step 3 and consumed verbatim in Task 1 Step 1 (tests use `maxTo` in `baseInput`) and Task 2 Step 1 (ChartStage passes `maxTo`). ✓
