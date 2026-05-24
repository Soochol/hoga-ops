# Auction Mask Predicate Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the hand-inlined `auctionWindowMask && axis.inClosingAuctionWindow(t)` expression duplicated across 3 projector callsites + 1 hook body with a single pure predicate `isAuctionMaskActive` in `frontend/src/util/auctionMask.ts`. The hook delegates; projectors call the function directly.

**Architecture:** Pure function + thin React hook adapter. The hook owns store/cursor reads; the predicate owns the rule.

**Tech Stack:** TypeScript, Vitest (jsdom).

**Spec:** [docs/superpowers/specs/2026-05-24-auction-mask-unification-design.md](../specs/2026-05-24-auction-mask-unification-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `frontend/src/util/auctionMask.ts` | NEW | Pure `isAuctionMaskActive(toggle, axis, t)`. ~25 LOC. |
| `frontend/src/util/auctionMask.test.ts` | NEW | Pure-function unit tests with axis spy. ~50 LOC. |
| `frontend/src/state/useAuctionMaskActive.ts` | MODIFY | Delegate to `isAuctionMaskActive`. |
| `frontend/src/chart/projectors/ratio.ts` | MODIFY | Replace 1 inline expression with call. |
| `frontend/src/chart/projectors/quoteTotals.ts` | MODIFY | Replace 2 inline expressions with calls (bid + ask). |

**Not touched:** `state/useAuctionMaskActive.test.ts` (hook contract unchanged), `chart/projectors/candle.ts` (different semantic per ADR-0018), `chart/AuctionWindowOverlay.tsx` (no axis/t).

---

## Task 1: Create `util/auctionMask.ts` with smoke test

**Files:**
- Create: `frontend/src/util/auctionMask.ts`
- Create: `frontend/src/util/auctionMask.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `frontend/src/util/auctionMask.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isAuctionMaskActive } from './auctionMask';

describe('isAuctionMaskActive — scaffold', () => {
  it('exports as a function', () => {
    expect(typeof isAuctionMaskActive).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

From `frontend/`: `npx vitest run src/util/auctionMask.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `frontend/src/util/auctionMask.ts`:

```ts
import type { VirtualAxis } from './virtualAxis';

/**
 * Pure Auction Mask predicate (CONTEXT.md "Auction Mask").
 *
 * Returns `true` iff (1) the per-tab `auctionWindowMask` toggle is on AND
 * (2) `t` falls inside the closing Auction Window per `VirtualAxis`.
 *
 * Used by series projectors that loop over many `t` values; the React hook
 * variant `state/useAuctionMaskActive` delegates here after threading cursor
 * + null guards.
 *
 * The narrow `Pick<VirtualAxis, 'inClosingAuctionWindow'>` parameter lets
 * test fakes satisfy the contract without constructing a full `VirtualAxis`.
 */
export function isAuctionMaskActive(
  auctionWindowMask: boolean,
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow'>,
  t: number,
): boolean {
  if (!auctionWindowMask) return false;
  return axis.inClosingAuctionWindow(t);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/util/auctionMask.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/util/auctionMask.ts frontend/src/util/auctionMask.test.ts
git commit -m "feat(util): isAuctionMaskActive — pure Auction Mask predicate"
```

---

## Task 2: TDD the predicate's behavior (5 tests)

**Files:** `frontend/src/util/auctionMask.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `frontend/src/util/auctionMask.test.ts`:

```ts
import { vi } from 'vitest';

type AxisLike = { inClosingAuctionWindow: (t: number) => boolean };

describe('isAuctionMaskActive — behavior', () => {
  it('returns false when toggle is off, and does not call axis predicate', () => {
    const spy = vi.fn(() => true);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(false, axis, 1_700_000_000_000)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns false when toggle is on but axis predicate returns false', () => {
    const spy = vi.fn(() => false);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(true, axis, 1_700_000_000_000)).toBe(false);
    expect(spy).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('returns true when toggle is on and axis predicate returns true', () => {
    const spy = vi.fn(() => true);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(true, axis, 1_700_000_000_000)).toBe(true);
    expect(spy).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('short-circuits before axis throws when toggle is off', () => {
    const axis: AxisLike = {
      inClosingAuctionWindow: () => {
        throw new Error('should not be called');
      },
    };
    expect(() => isAuctionMaskActive(false, axis, 0)).not.toThrow();
    expect(isAuctionMaskActive(false, axis, 0)).toBe(false);
  });

  it('forwards t === 0 (and other boundary values) to the axis verbatim', () => {
    const spy = vi.fn((t: number) => t === 0);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(true, axis, 0)).toBe(true);
    expect(spy).toHaveBeenCalledWith(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/util/auctionMask.test.ts`
Expected: PASS, 6 tests total (scaffold + 5).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/util/auctionMask.test.ts
git commit -m "test(util): cover isAuctionMaskActive short-circuit + boundaries"
```

---

## Task 3: Delegate `useAuctionMaskActive` hook to the predicate

**Files:** `frontend/src/state/useAuctionMaskActive.ts`

- [ ] **Step 1: Read the current hook**

Run: `cat frontend/src/state/useAuctionMaskActive.ts`
Expected: 19-line hook reading `useTabsStore`, `useCursor`, then inlining `auctionWindowMask && axis.inClosingAuctionWindow(cursorMs)`.

- [ ] **Step 2: Replace the file body**

Replace the entire file contents of `frontend/src/state/useAuctionMaskActive.ts` with:

```ts
import { useTabsStore } from './tabs';
import { useCursor } from '../api/useCursor';
import { isAuctionMaskActive } from '../util/auctionMask';
import type { VirtualAxis } from '../util/virtualAxis';

/**
 * Returns whether the Auction Mask is currently active for the active tab's cursor.
 *
 * Active iff (1) the per-tab `auctionWindowMask` toggle is on AND (2) the cursor
 * falls inside the closing Auction Window. The rule itself lives in
 * `util/auctionMask.isAuctionMaskActive`; this hook owns the store + cursor
 * reads plus the cursor-null guard. Spot views (TotalQtyBar, etc.) use this;
 * series projectors call `isAuctionMaskActive` directly (cannot use hooks).
 */
export function useAuctionMaskActive(axis: VirtualAxis): boolean {
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask);
  const { cursorMs } = useCursor();
  if (cursorMs == null || !Number.isFinite(cursorMs)) return false;
  return isAuctionMaskActive(auctionWindowMask, axis, cursorMs);
}
```

- [ ] **Step 3: Run existing hook tests — must pass unchanged**

Run: `npx vitest run src/state/useAuctionMaskActive.test.ts`
Expected: PASS — the 3 existing tests (toggle-off, cursor-null, axis-false) all pass with no edit. If any fails, STOP and investigate; the hook's external contract must be identical.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b` from `frontend/`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/useAuctionMaskActive.ts
git commit -m "refactor(state): useAuctionMaskActive delegates rule to util predicate"
```

---

## Task 4: Migrate `ratio.ts` projector to use the predicate

**Files:** `frontend/src/chart/projectors/ratio.ts`

- [ ] **Step 1: Add the import**

In `frontend/src/chart/projectors/ratio.ts`, add to the imports block at the top:

```ts
import { isAuctionMaskActive } from '../../util/auctionMask';
```

- [ ] **Step 2: Replace the inline expression**

In the `projectRatio` function (around line 50-62), find:

```ts
      value:
        auctionWindowMask && axis.inClosingAuctionWindow(p.t)
          ? 0
          : quoteImbalance(p.bid_total, p.ask_total),
```

Replace with:

```ts
      value: isAuctionMaskActive(auctionWindowMask, axis, p.t)
        ? 0
        : quoteImbalance(p.bid_total, p.ask_total),
```

The comment block above this expression (lines 54-57 explaining `auctionWindowMask` + `axis.inClosingAuctionWindow`) should be tightened — the *what* now lives in `isAuctionMaskActive`'s docstring. Reduce to:

```ts
      // CONTEXT.md "Auction Window" — during 15:20–15:30 the bid/ask ratio is
      // dominated by one-sided accumulation. `isAuctionMaskActive` owns the
      // rule (per-tab toggle + axis threshold).
```

- [ ] **Step 3: Typecheck + run any tests touching this projector**

Run: `npx tsc -b` from `frontend/`. Expected: clean.

Run: `npx vitest run src/chart/projectors/` if such tests exist, else `npx vitest run` to confirm no regression elsewhere.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/projectors/ratio.ts
git commit -m "refactor(chart): RatioPane projector uses isAuctionMaskActive"
```

---

## Task 5: Migrate `quoteTotals.ts` projector (bid + ask)

**Files:** `frontend/src/chart/projectors/quoteTotals.ts`

- [ ] **Step 1: Add the import**

Add to the imports block at the top:

```ts
import { isAuctionMaskActive } from '../../util/auctionMask';
```

- [ ] **Step 2: Replace both inline expressions**

In `projectBid` (around line 30-39), find:

```ts
      value:
        auctionWindowMask && axis.inClosingAuctionWindow(p.t)
          ? 0
          : p.bid_total,
```

Replace with:

```ts
      value: isAuctionMaskActive(auctionWindowMask, axis, p.t) ? 0 : p.bid_total,
```

In `projectAsk` (around line 46-55), find:

```ts
      value:
        auctionWindowMask && axis.inClosingAuctionWindow(p.t)
          ? 0
          : p.ask_total,
```

Replace with:

```ts
      value: isAuctionMaskActive(auctionWindowMask, axis, p.t) ? 0 : p.ask_total,
```

Tighten the shared comment block above `projectBid` (currently lines 21-25) — `isAuctionMaskActive` now owns the rule:

```ts
// CONTEXT.md "Auction Window" — posted totals are dominated by one-sided
// accumulation during 15:20–15:30. `isAuctionMaskActive` owns the rule
// (per-tab toggle + axis threshold), matching the RatioPane treatment.
```

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc -b` from `frontend/`. Expected: clean.
Run: `npx vitest run`. Expected: full suite green.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/projectors/quoteTotals.ts
git commit -m "refactor(chart): QuoteTotalsPane projector uses isAuctionMaskActive"
```

---

## Task 6: Full sweep + grep audit

**Files:** none.

- [ ] **Step 1: Confirm no inline `auctionWindowMask && axis.inClosingAuctionWindow` remains**

Run: `grep -rn "auctionWindowMask && axis\.inClosingAuctionWindow" frontend/src/`
Expected: zero matches. All 3 inline usages should have been replaced.

- [ ] **Step 2: Confirm `isAuctionMaskActive` is the only owner**

Run: `grep -rn "isAuctionMaskActive\b" frontend/src/`
Expected: matches in:
- `util/auctionMask.ts` (definition)
- `util/auctionMask.test.ts` (tests)
- `state/useAuctionMaskActive.ts` (hook delegation)
- `chart/projectors/ratio.ts` (callsite)
- `chart/projectors/quoteTotals.ts` (callsite)

Plus the hook export name `useAuctionMaskActive` (different word, with `use` prefix) elsewhere — that's expected.

- [ ] **Step 3: Full vitest + tsc + eslint**

```bash
npx vitest run
npx tsc -b
npx eslint src/util/auctionMask.ts src/util/auctionMask.test.ts src/state/useAuctionMaskActive.ts src/chart/projectors/ratio.ts src/chart/projectors/quoteTotals.ts
```

Expected: 602 + 6 new util tests = ~608 tests passing; tsc + eslint clean.

- [ ] **Step 4: If anything failed, fix in place and re-run. Otherwise this task produces no commit.**

---

## Out of scope (per spec)

- Folding `candle.ts` muting (ADR-0018 separation).
- `AuctionWindowOverlay.tsx` (different semantic).
- `useChartPrefs` wrapper deletion (deferred).

## Self-Review Notes

- **Spec coverage**: pure predicate (T1+T2), hook delegation (T3), 2 projector migrations (T4+T5), audit (T6). All covered.
- **Type consistency**: `isAuctionMaskActive`, `Pick<VirtualAxis, 'inClosingAuctionWindow'>` used uniformly.
- **Hook contract preserved**: T3 step 3 explicitly verifies `useAuctionMaskActive.test.ts` passes unchanged — the external contract is invariant.
- **No CONTEXT.md edit**: "Auction Mask" definition unchanged; only the **implementation location** consolidates.
