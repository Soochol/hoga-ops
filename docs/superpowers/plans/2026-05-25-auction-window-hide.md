# Auction Window Hide — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `auctionWindowMask` "mask values to 0" behaviour with "hide data points entirely" for chart-pane indicators derived from order book or trade data (Ratio, QuoteTotals, FillStrength histograms and Cumulative Net Fill), while keeping Candle and Volume panes untouched.

**Architecture:** A new helper module `chart/util/auctionMaskGap.ts` exposes a `makeAuctionMaskGap(axis, enabled)` factory returning a small state machine. Each affected projector filters out in-auction points and (for continuous-line series) pushes a `WhitespaceData` boundary marker at the auction-start virtual time so lightweight-charts breaks the line cleanly instead of interpolating across the gap. The `auctionWindowMask` toggle key is preserved in `CHART_TOGGLES` and `ChartViewPrefs` so existing localStorage values keep working — only the user-facing label/description change.

**Tech Stack:** TypeScript, React, Zustand, lightweight-charts v5, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-25-auction-window-hide-design.md`
**Related ADR:** `docs/adr/0029-auction-mask-hide-not-zero.md`

---

## File Structure

**Create:**
- `frontend/src/chart/util/auctionMaskGap.ts` — state machine factory (the "emit one whitespace at first transition into auction window" logic, shared by three continuous-line projectors)
- `frontend/src/chart/util/auctionMaskGap.test.ts`

**Modify:**
- `frontend/src/state/chartPrefs.ts:11-16` — toggle label + description text only
- `frontend/src/chart/projectors/ratio.ts` — `projectRatio` returns `(BaselineData | WhitespaceData)[]`, drops in-auction points, inserts boundary whitespace. Outlier mask (`isExtreme ? 0 : raw`) unchanged.
- `frontend/src/chart/projectors/ratio.test.ts` — replace "value=0 inside auction" assertion with "point absent + whitespace at boundary"; keep all other tests intact.
- `frontend/src/chart/projectors/quoteTotals.ts` — `projectBid`/`projectAsk` return `(LineData | WhitespaceData)[]`, drop in-auction points, insert boundary whitespace per series.
- `frontend/src/chart/projectors/quoteTotals.test.ts` — same shape as ratio.
- `frontend/src/chart/projectors/fillStrength.ts` — `projectBuy`/`projectSell` gain `auctionWindowMask: boolean` parameter and drop in-auction points (no whitespace — histograms have no continuity); `projectCumulativeNetFill` gains `auctionWindowMask: boolean`, suppresses in-auction emission, inserts boundary whitespace, but keeps accumulating `runningSum`; `FillStrengthPaneContext` gains `auctionWindowMask: boolean`; `useFillStrengthContext` adds one selector line; `FILL_STRENGTH_SPEC.series` data thunks pass `ctx.auctionWindowMask`.
- `frontend/src/chart/projectors/fillStrength.test.ts` — add tests for the new hiding behaviour on all three series.
- `frontend/src/replay/SettingsModal.test.tsx` — update the 4 occurrences of `name: '호가비 동시호가 마스킹'` to the new label.

**Not modified (verified — no work needed):**
- `frontend/src/util/auctionMask.ts` — predicate semantics unchanged.
- `frontend/src/util/auctionMask.test.ts` — predicate semantics unchanged.
- `frontend/src/chart/AuctionWindowOverlay.tsx` — background band stays.
- `frontend/src/sidebar/TotalQtyBar.tsx` — already renders "Auction" label, not value=0; matches new spec.
- `frontend/src/state/useAuctionMaskActive.ts` — spot-view hook unchanged.
- Backend (`hoga/api/bundle.py`) — visual-only change.

---

## Task 1: Update toggle label and description

**Why first:** Trivial text edit. Demonstrates the localStorage-preserving rename pattern and gets the user-visible string aligned with the rest of the plan early.

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts:11-16`
- Test: `frontend/src/replay/SettingsModal.test.tsx` (lines that reference the old label literal)

- [ ] **Step 1: Update the CHART_TOGGLES entry text**

Edit `frontend/src/state/chartPrefs.ts`, replace the first entry of `CHART_TOGGLES` (lines 11-16):

```ts
  {
    key: 'auctionWindowMask',
    label: '동시호가 구간 지표 숨김',
    description: '15:20–15:30 KST 동시호가 구간에서 호가비·호가총합·체결강도를 표시하지 않습니다. (캔들/거래량 제외)',
    default: true,
  },
```

The `key`, `default`, and the entry's position in the array stay exactly the same. Only `label` and `description` change.

- [ ] **Step 2: Update SettingsModal tests that match the old label literal**

Edit `frontend/src/replay/SettingsModal.test.tsx`. There are 5 occurrences of `'호가비 동시호가 마스킹'` (lines 32, 48, 68, 71, 83, 93 — exact line numbers may shift, use grep to find them). Replace every occurrence of the literal string `호가비 동시호가 마스킹` with `동시호가 구간 지표 숨김`. The matching uses accessible-name lookup, so changing the label string in chartPrefs.ts requires changing the test's expected name to match.

Run grep to verify nothing else matches before/after:

```bash
grep -rn '호가비 동시호가 마스킹' frontend/src/
```

Expected after edit: no output.

- [ ] **Step 3: Run the touched test files**

```bash
cd frontend && npx vitest run src/state/chartPrefs.test.ts src/replay/SettingsModal.test.tsx
```

Expected: all tests pass. `chartPrefs.test.ts` does not assert the label text (only the `key` and `default`), so it should pass without modification. `SettingsModal.test.tsx` passes with the updated literal.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/replay/SettingsModal.test.tsx
git commit -m "$(cat <<'EOF'
feat(chart-prefs): rename auctionWindowMask label to '동시호가 구간 지표 숨김'

Spec: docs/superpowers/specs/2026-05-25-auction-window-hide-design.md
The toggle key, default, and stored localStorage values are unchanged — only
the user-facing label and description shift to reflect the new hide-rather-
than-mask-to-0 semantics that the projector changes in subsequent commits
will introduce. ADR-0029 documents the architectural reversal in full.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create `auctionMaskGap` helper + tests

**Why now:** Three projectors will depend on this helper. Build it test-first so the contract is locked before any projector edit.

**Files:**
- Create: `frontend/src/chart/util/auctionMaskGap.ts`
- Test: `frontend/src/chart/util/auctionMaskGap.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/chart/util/auctionMaskGap.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest';
import { makeAuctionMaskGap } from './auctionMaskGap';

type AxisLike = {
  inClosingAuctionWindow: (t: number) => boolean;
  toVirtual: (t: number) => number;
};

const fakeAxis = (inAuction: (t: number) => boolean): AxisLike => ({
  inClosingAuctionWindow: inAuction,
  toVirtual: (t) => t, // 1:1 mapping for tests
});

describe('makeAuctionMaskGap — disabled', () => {
  it('isHidden always returns false when enabled=false', () => {
    const gap = makeAuctionMaskGap(fakeAxis(() => true), false);
    expect(gap.isHidden(1000)).toBe(false);
    expect(gap.isHidden(2000)).toBe(false);
  });

  it('breakBefore always returns null when enabled=false', () => {
    const gap = makeAuctionMaskGap(fakeAxis(() => true), false);
    expect(gap.breakBefore(1000)).toBeNull();
    expect(gap.breakBefore(2000)).toBeNull();
  });
});

describe('makeAuctionMaskGap — enabled', () => {
  it('isHidden returns true iff axis predicate is true', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    expect(gap.isHidden(1000)).toBe(false);
    expect(gap.isHidden(5000)).toBe(true);
    expect(gap.isHidden(9000)).toBe(true);
  });

  it('emits one WhitespaceData at the first transition into the auction window', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    expect(gap.breakBefore(1000)).toBeNull();
    expect(gap.breakBefore(3000)).toBeNull();
    const br = gap.breakBefore(5000);
    expect(br).not.toBeNull();
    // Whitespace is positioned 1ms before the first in-auction virtual time,
    // converted to seconds.
    expect(br).toEqual({ time: (5000 - 1) / 1000 });
  });

  it('does NOT emit a second break for subsequent in-auction points', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    gap.breakBefore(1000); // outside
    gap.breakBefore(5000); // entry — break emitted
    expect(gap.breakBefore(6000)).toBeNull(); // still inside — no second break
    expect(gap.breakBefore(7000)).toBeNull();
  });

  it('re-arms after leaving the auction window (defensive)', () => {
    // Synthetic axis that toggles in/out/in for the same iteration.
    const inAuction = (t: number) => t >= 5000 && t <= 6000;
    const gap = makeAuctionMaskGap(fakeAxis(inAuction), true);
    expect(gap.breakBefore(5000)).toEqual({ time: 4.999 }); // entry 1
    expect(gap.breakBefore(6000)).toBeNull(); // still in
    expect(gap.breakBefore(7000)).toBeNull(); // left
    expect(gap.breakBefore(8000)).toBeNull(); // still out
    // A re-entry inside the same iterator (rare) should break again.
    const inAuction2 = (t: number) => t >= 9000;
    const gap2 = makeAuctionMaskGap(fakeAxis(inAuction2), true);
    // Mirror: enter, leave, enter again on a different instance proves
    // reset() works; here we use reset() directly.
    gap.reset();
    expect(gap.breakBefore(9000)).toEqual({ time: 8.999 });
  });

  it('reset() clears the "already broke" flag without affecting predicate', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    gap.breakBefore(5000); // entry, break emitted
    expect(gap.breakBefore(6000)).toBeNull();
    gap.reset();
    // After reset, the next in-auction point emits a break again.
    expect(gap.breakBefore(6000)).toEqual({ time: 5.999 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/chart/util/auctionMaskGap.test.ts
```

Expected: FAIL with module-not-found / `makeAuctionMaskGap is not exported`.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/chart/util/auctionMaskGap.ts` with this content:

```ts
import type { Time, WhitespaceData } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';

/**
 * State-machine helper for projectors that need to drop in-auction-window
 * points AND break their continuous line cleanly at the 15:20 boundary
 * (ADR-0029). Without an explicit `WhitespaceData` at the boundary,
 * lightweight-charts would interpolate a straight segment from the last
 * pre-window point to the first post-window (or next-day) point —
 * a "phantom break" that crosses the empty band diagonally.
 *
 * Usage in a projector loop:
 *
 *     const gap = makeAuctionMaskGap(axis, ctx.auctionWindowMask);
 *     const out = [];
 *     for (const p of bundle.points) {
 *       if (!axis.contains(p.t)) continue;
 *       const br = gap.breakBefore(p.t);
 *       if (br) out.push(br);
 *       if (gap.isHidden(p.t)) continue;
 *       out.push({ time: virtualSeconds(p.t), value: p.value });
 *     }
 *
 * When `enabled` is false, both methods are no-ops so projectors can call
 * them unconditionally.
 *
 * `reset()` is provided for callers that iterate segments outermost
 * (Cumulative Net Fill) — it clears the "we already broke" flag so a
 * fresh segment's first in-auction point still triggers a break. Day
 * boundaries already insert their own whitespace via the existing
 * per-segment logic; both whitespaces can coexist (different timestamps).
 */
export type AuctionMaskGap = {
  /** Returns a WhitespaceData to push BEFORE emitting the current point,
   *  or null. Called once per point. */
  breakBefore(t: number): WhitespaceData<Time> | null;
  /** Whether this point should be skipped (inside the auction window). */
  isHidden(t: number): boolean;
  /** Re-arm the entry-detection flag. Call at segment boundaries when
   *  the caller iterates segments. */
  reset(): void;
};

export function makeAuctionMaskGap(
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow' | 'toVirtual'>,
  enabled: boolean,
): AuctionMaskGap {
  if (!enabled) {
    return {
      breakBefore: () => null,
      isHidden: () => false,
      reset: () => {},
    };
  }

  let wasInAuction = false;

  return {
    breakBefore(t: number): WhitespaceData<Time> | null {
      const inside = axis.inClosingAuctionWindow(t);
      if (inside && !wasInAuction) {
        wasInAuction = true;
        // 1ms before the first in-auction virtual time, in seconds —
        // matches the day-boundary whitespace convention in fillStrength.ts.
        const breakTime = (axis.toVirtual(t) - 1) / 1000;
        return { time: breakTime as Time };
      }
      if (!inside) wasInAuction = false;
      return null;
    },
    isHidden(t: number): boolean {
      return axis.inClosingAuctionWindow(t);
    },
    reset(): void {
      wasInAuction = false;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/chart/util/auctionMaskGap.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/util/auctionMaskGap.ts frontend/src/chart/util/auctionMaskGap.test.ts
git commit -m "$(cat <<'EOF'
feat(chart): add auctionMaskGap helper for drop-and-break rendering

Spec: docs/superpowers/specs/2026-05-25-auction-window-hide-design.md
ADR: docs/adr/0029-auction-mask-hide-not-zero.md

makeAuctionMaskGap encapsulates the "first transition into the closing
Auction Window emits one boundary WhitespaceData, subsequent in-window
points are skipped" state machine. Three projectors (ratio, quoteTotals,
fillStrength cumulative) will consume this helper in upcoming commits.
Disabled mode returns no-op methods so projectors call it unconditionally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update `projectRatio` to drop-and-break

**Files:**
- Modify: `frontend/src/chart/projectors/ratio.ts`
- Test: `frontend/src/chart/projectors/ratio.test.ts`

- [ ] **Step 1: Update the failing test first**

Edit `frontend/src/chart/projectors/ratio.test.ts`. Replace the test block `it('masks closing-auction-window values to 0 when auctionWindowMask=true', ...)` (currently around lines 41-58 — locate by the `masks closing-auction-window` string) with this new block:

```ts
  it('drops closing-auction-window points and inserts a WhitespaceData break when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },   // inside → hidden
          { t: auctionStartMs + 120_000, bid_total: 100, ask_total: 1000 },  // inside → hidden
        ],
      },
    };
    const masked = projectRatio(bundle, axis, { ...baseCtx, auctionWindowMask: true });

    // Outside-window point + one whitespace at the boundary = 2 entries.
    // Both in-auction points are absent.
    expect(masked).toHaveLength(2);

    // First entry: the kept pre-auction point with real value.
    const first = masked[0] as { time: number; value: number };
    expect(first.time).toBe(0);
    expect(first.value).toBeCloseTo(1.0, 5);

    // Second entry: a WhitespaceData (no `value` field) at virtual time
    // 1ms before the first in-auction point. The first in-auction point's
    // virtual seconds is (auctionStartMs + 60_000 - sessionOpenMs) / 1000.
    const expectedBreakTime = (auctionStartMs + 60_000 - sessionOpenMs - 1) / 1000;
    const ws = masked[1] as { time: number; value?: number };
    expect(ws.time).toBe(expectedBreakTime);
    expect(ws.value).toBeUndefined();
  });

  it('keeps auction-window points when auctionWindowMask=false', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },
        ],
      },
    };
    const unmasked = projectRatio(bundle, axis, baseCtx);
    expect(unmasked).toHaveLength(1);
    const p = unmasked[0] as { value: number };
    expect(p.value).not.toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail and the outlier test still passes**

```bash
cd frontend && npx vitest run src/chart/projectors/ratio.test.ts
```

Expected: the two NEW tests fail (current behavior is value=0, not whitespace-and-drop). The OUTLIER test still passes. The `drops pre-open auction points` test still passes.

- [ ] **Step 3: Update `projectRatio` to drop-and-break**

Edit `frontend/src/chart/projectors/ratio.ts`. Replace the imports block at the top (lines 1-16) so it includes `WhitespaceData` and the new helper:

```ts
import {
  BaselineSeries,
  type BaselineData,
  type LineWidth,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { quoteImbalance } from '../../util/imbalance';
import { resolveTokens } from '../../util/tokens';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import { addZeroBaselineGuide } from '../util/zeroBaseline';
import { makeAuctionMaskGap } from '../util/auctionMaskGap';
```

(Note the removed `import { isAuctionMaskActive } from '../../util/auctionMask';` and the removed `import { isAuctionMaskActive }` references — `auctionMaskGap` replaces both. Also the removed `import { isAuctionMaskActive }` if present.)

Replace the `projectRatio` function (currently lines 55-87) with:

```ts
export function projectRatio(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: RatioPaneContext,
): (BaselineData<Time> | WhitespaceData<Time>)[] {
  const gap = makeAuctionMaskGap(axis, ctx.auctionWindowMask);
  const out: (BaselineData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of bundle.quote_ratio.points) {
    if (!axis.contains(p.t)) continue;
    const br = gap.breakBefore(p.t);
    if (br) out.push(br);
    if (gap.isHidden(p.t)) continue;
    const raw = quoteImbalance(p.bid_total, p.ask_total);
    // Outlier clamp: priceFormat above renders `1 + |raw|`, so the chart
    // label crosses `outlierThreshold` once ask/bid (or bid/ask) reaches
    // that multiple. Such spikes dominate the autoscale and flatten the
    // meaningful signal — mask to 0 (ADR-0026). Auction-window hiding
    // (ADR-0029) is handled above; outliers still use value-0 because
    // they are scattered, not bounded, and need pointwise treatment.
    const isExtreme =
      ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold;
    out.push({
      time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
      value: isExtreme ? 0 : raw,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/chart/projectors/ratio.test.ts
```

Expected: all 6 tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/ratio.ts frontend/src/chart/projectors/ratio.test.ts
git commit -m "$(cat <<'EOF'
feat(ratio): hide in-auction points instead of masking to 0 (ADR-0029)

Spec: docs/superpowers/specs/2026-05-25-auction-window-hide-design.md
projectRatio now returns (BaselineData | WhitespaceData)[] and uses the
auctionMaskGap helper to drop in-window points + insert a single boundary
WhitespaceData so the BaselineSeries line breaks cleanly at 15:20 instead
of rendering a 10-minute baseline plateau. The outlier mask (independent
toggle, value=0 semantics — ADR-0026) is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update `projectBid` / `projectAsk` to drop-and-break

**Files:**
- Modify: `frontend/src/chart/projectors/quoteTotals.ts`
- Test: `frontend/src/chart/projectors/quoteTotals.test.ts`

- [ ] **Step 1: Update the failing tests first**

Edit `frontend/src/chart/projectors/quoteTotals.test.ts`. Replace the `describe('closing-auction-window mask', () => { ... })` block (currently the last describe block in the file) with:

```ts
describe('closing-auction-window hide', () => {
  it('drops in-window bid/ask points and inserts a WhitespaceData break per series when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → kept
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },    // inside → hidden
          { t: auctionStartMs + 120_000, bid_total: 600, ask_total: 1000 },  // inside → hidden
        ],
      },
    };
    const bids = projectBid(bundle, axis, true);
    const asks = projectAsk(bundle, axis, true);

    // Each series: 1 kept point + 1 whitespace boundary = 2 entries.
    expect(bids).toHaveLength(2);
    expect(asks).toHaveLength(2);

    expect(bids[0]).toEqual({ time: 0, value: 100 });
    expect(asks[0]).toEqual({ time: 0, value: 200 });

    const expectedBreakTime = (auctionStartMs + 60_000 - sessionOpenMs - 1) / 1000;
    const bidWs = bids[1] as { time: number; value?: number };
    const askWs = asks[1] as { time: number; value?: number };
    expect(bidWs.time).toBe(expectedBreakTime);
    expect(bidWs.value).toBeUndefined();
    expect(askWs.time).toBe(expectedBreakTime);
    expect(askWs.value).toBeUndefined();
  });

  it('keeps in-window points when auctionWindowMask=false', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: auctionStartMs + 60_000, bid_total: 500, ask_total: 900 },
        ],
      },
    };
    expect(projectBid(bundle, axis, false)).toEqual([
      { time: (auctionStartMs + 60_000 - sessionOpenMs) / 1000, value: 500 },
    ]);
    expect(projectAsk(bundle, axis, false)).toEqual([
      { time: (auctionStartMs + 60_000 - sessionOpenMs) / 1000, value: 900 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

```bash
cd frontend && npx vitest run src/chart/projectors/quoteTotals.test.ts
```

Expected: the two NEW tests fail (current behavior is value=0). The pre-existing `projectBid` / `projectAsk` map+drop-pre-open tests still pass.

- [ ] **Step 3: Update `projectBid` and `projectAsk`**

Edit `frontend/src/chart/projectors/quoteTotals.ts`. Replace the imports at the top (lines 1-7) with:

```ts
import {
  LineSeries,
  type LineData,
  type UTCTimestamp,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import { makeAuctionMaskGap } from '../util/auctionMaskGap';
```

(`isAuctionMaskActive` import removed.)

Replace `projectBid` and `projectAsk` (lines 25-49) with:

```ts
// Closing Auction Window hiding (ADR-0029): in-window points are dropped
// and a WhitespaceData break is inserted at the boundary so the line
// terminates cleanly at 15:20 instead of plateauing at 0.
export function projectBid(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const gap = makeAuctionMaskGap(axis, auctionWindowMask);
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of bundle.quote_ratio.points) {
    if (!axis.contains(p.t)) continue;
    const br = gap.breakBefore(p.t);
    if (br) out.push(br);
    if (gap.isHidden(p.t)) continue;
    out.push({
      time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
      value: p.bid_total,
    });
  }
  return out;
}

export function projectAsk(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const gap = makeAuctionMaskGap(axis, auctionWindowMask);
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  for (const p of bundle.quote_ratio.points) {
    if (!axis.contains(p.t)) continue;
    const br = gap.breakBefore(p.t);
    if (br) out.push(br);
    if (gap.isHidden(p.t)) continue;
    out.push({
      time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
      value: p.ask_total,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/chart/projectors/quoteTotals.test.ts
```

Expected: all tests pass (4 original + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/quoteTotals.ts frontend/src/chart/projectors/quoteTotals.test.ts
git commit -m "$(cat <<'EOF'
feat(quote-totals): hide in-auction points instead of zeroing (ADR-0029)

Spec: docs/superpowers/specs/2026-05-25-auction-window-hide-design.md
projectBid and projectAsk now return (LineData | WhitespaceData)[] and use
auctionMaskGap. Each series carries its own boundary whitespace because
they render as two independent LineSeries instances. The earlier value=0
treatment created paired baseline-touching plateaus that looked like real
"both sides emptied out" data rather than "we declined to render".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Extend `fillStrength` (histograms + cumulative) to honor `auctionWindowMask`

**Files:**
- Modify: `frontend/src/chart/projectors/fillStrength.ts`
- Test: `frontend/src/chart/projectors/fillStrength.test.ts`

This is the largest task because three projectors live in this file. The histograms (`projectBuy`, `projectSell`) only need the predicate (no whitespace — histograms have no line continuity). The cumulative LineSeries (`projectCumulativeNetFill`) needs both: drop in-window emission AND insert a boundary whitespace, while keeping `runningSum` accumulating defensively.

- [ ] **Step 1: Add failing tests**

Append to `frontend/src/chart/projectors/fillStrength.test.ts` (after the existing `describe('FILL_STRENGTH_SPEC shape', ...)` block):

```ts
describe('projectBuy/projectSell — closing-auction hide', () => {
  it('drops in-window buy/sell points when auctionWindowMask=true (no whitespace; histograms have no continuity)', () => {
    const auctionStartMs = day1Open + 22_800_000; // 15:20 KST
    const bundle: any = {
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 50, sell_qty: 30 },                  // outside → kept
          { t: auctionStartMs + 60_000, buy_qty: 70, sell_qty: 70 },   // inside → hidden
        ],
      },
    };
    const axisLocal = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    expect(projectBuy(bundle, axisLocal, true)).toEqual([{ time: 0, value: 50 }]);
    expect(projectSell(bundle, axisLocal, true)).toEqual([{ time: 0, value: -30 }]);
  });

  it('keeps in-window buy/sell points when auctionWindowMask=false', () => {
    const auctionStartMs = day1Open + 22_800_000;
    const bundle: any = {
      fill_strength: {
        points: [{ t: auctionStartMs + 60_000, buy_qty: 70, sell_qty: 80 }],
      },
    };
    const axisLocal = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    expect(projectBuy(bundle, axisLocal, false)).toHaveLength(1);
    expect(projectSell(bundle, axisLocal, false)).toHaveLength(1);
  });
});

describe('projectCumulativeNetFill — closing-auction hide', () => {
  const singleDayAxis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ]);
  const auctionStartMs = day1Open + 22_800_000;

  it('skips emission inside the window AND inserts a boundary WhitespaceData when mask=true', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },                  // +70 → 70 (kept)
          { t: auctionStartMs + 60_000, buy_qty: 0, sell_qty: 100 },    // inside → hidden (but runningSum accumulates)
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis, true);

    // First emitted point keeps its value; the in-auction point is gone
    // but a whitespace boundary appears between them.
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ time: 0, value: 70 });
    const ws = out[1] as { time: number; value?: number };
    const expectedBreakTime = (auctionStartMs + 60_000 - day1Open - 1) / 1000;
    expect(ws.time).toBe(expectedBreakTime);
    expect(ws.value).toBeUndefined();
  });

  it('keeps in-window cumulative emission when mask=false', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },               // 70
          { t: auctionStartMs + 60_000, buy_qty: 0, sell_qty: 100 }, // -30
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis, false);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ value: 70 });
    expect(out[1]).toMatchObject({ value: -30 });
  });

  it('runningSum continues to accumulate through hidden in-window points', () => {
    // Defensive invariant: even though FillStrength normally has no in-window
    // points (Auction Cross rows are filtered out backend-side), if any did
    // exist, the cumulative should treat them as data and only suppress
    // emission. We verify by extending session_close_ms past 15:30 and adding
    // a post-auction-window point; the cumulative value of that point must
    // reflect the in-auction delta.
    const extendedClose = day1Open + sessionDurationMs + 3_600_000; // +1h
    const extendedAxis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: extendedClose },
    ]);
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: extendedClose }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },               // 70
          { t: auctionStartMs + 60_000, buy_qty: 0, sell_qty: 100 }, // hidden, but contributes -100
          { t: day1Open + sessionDurationMs + 60_000, buy_qty: 50, sell_qty: 0 }, // post-window: +50 → cum should be 20
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, extendedAxis, true);
    // Find the last non-whitespace point.
    const last = out.filter((p) => 'value' in p).at(-1) as { value: number };
    expect(last.value).toBe(20); // 70 - 100 + 50 = 20
  });
});

describe('FILL_STRENGTH_SPEC — auctionWindowMask threading', () => {
  const axis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ]);
  const bundle: any = {
    segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
    fill_strength: {
      points: [{ t: day1Open + 22_800_000 + 60_000, buy_qty: 99, sell_qty: 99 }], // in-auction
    },
  };

  it('buy histogram series data() honors ctx.auctionWindowMask', () => {
    const buy = FILL_STRENGTH_SPEC.series[0];
    expect(buy.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: true })).toEqual([]);
    expect(buy.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false })).toHaveLength(1);
  });

  it('sell histogram series data() honors ctx.auctionWindowMask', () => {
    const sell = FILL_STRENGTH_SPEC.series[1];
    expect(sell.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: true })).toEqual([]);
    expect(sell.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false })).toHaveLength(1);
  });

  it('cumulative series data() honors ctx.auctionWindowMask in addition to ctx.cumulativeEnabled', () => {
    const cum = FILL_STRENGTH_SPEC.series[2];
    // cumulativeEnabled=false → always empty regardless of mask
    expect(cum.data(bundle, axis, { cumulativeEnabled: false, auctionWindowMask: true })).toEqual([]);
    expect(cum.data(bundle, axis, { cumulativeEnabled: false, auctionWindowMask: false })).toEqual([]);
    // cumulativeEnabled=true + mask=true → emission suppressed for the in-auction point;
    // since it's the ONLY point and it lands inside the window, output is just the boundary
    // whitespace (1 element with no value).
    const masked = cum.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: true });
    expect(masked).toHaveLength(1);
    expect((masked[0] as { value?: number }).value).toBeUndefined();
    // cumulativeEnabled=true + mask=false → 1 cumulative point (the in-auction value).
    expect(cum.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/chart/projectors/fillStrength.test.ts
```

Expected: NEW tests fail (signature mismatch — `projectBuy` doesn't take a 3rd arg, etc.). Existing tests still pass.

- [ ] **Step 3: Update `fillStrength.ts`**

Edit `frontend/src/chart/projectors/fillStrength.ts`. Add the new helper import to the import block at the top (after the existing imports):

```ts
import { makeAuctionMaskGap } from '../util/auctionMaskGap';
```

Replace `projectBuy` and `projectSell` (currently lines 46-56) with:

```ts
export function projectBuy(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  const gap = makeAuctionMaskGap(axis, auctionWindowMask);
  const out: any[] = [];
  for (const p of bundle.fill_strength.points) {
    if (!axis.contains(p.t)) continue;
    if (gap.isHidden(p.t)) continue;
    out.push({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.buy_qty });
  }
  return out;
}

export function projectSell(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  const gap = makeAuctionMaskGap(axis, auctionWindowMask);
  const out: any[] = [];
  for (const p of bundle.fill_strength.points) {
    if (!axis.contains(p.t)) continue;
    if (gap.isHidden(p.t)) continue;
    out.push({ time: (axis.toVirtual(p.t) / 1000) as any, value: -p.sell_qty });
  }
  return out;
}
```

(Histograms don't need `breakBefore` — there is no continuous line to break.)

Now replace `projectCumulativeNetFill` (currently lines 96-130) with the thread-through version:

```ts
export function projectCumulativeNetFill(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): (LineData<Time> | WhitespaceData<Time>)[] {
  const out: (LineData<Time> | WhitespaceData<Time>)[] = [];
  bundle.segments.forEach((seg, segIdx) => {
    const gap = makeAuctionMaskGap(axis, auctionWindowMask);
    let runningSum = 0;
    let firstEmittedInSeg = true;
    for (const p of bundle.fill_strength.points) {
      if (p.t < seg.session_open_ms || p.t > seg.session_close_ms) continue;
      runningSum += p.buy_qty - p.sell_qty;
      if (!axis.contains(p.t)) continue;

      // Auction-window boundary: emit whitespace BEFORE the day-boundary
      // handling so the auction break and the optional zero-anchor coexist
      // at distinct timestamps.
      const auctionBr = gap.breakBefore(p.t);
      if (auctionBr) out.push(auctionBr);
      if (gap.isHidden(p.t)) continue;

      if (firstEmittedInSeg) {
        const segOpenVirtual = (axis.toVirtual(seg.session_open_ms) / 1000) as UTCTimestamp;
        const thisVirtual = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
        if (segIdx > 0) {
          out.push({ time: ((segOpenVirtual as number) - 1) as UTCTimestamp });
        }
        if (axis.contains(seg.session_open_ms) && (segOpenVirtual as number) < (thisVirtual as number)) {
          out.push({ time: segOpenVirtual, value: 0 });
        }
        firstEmittedInSeg = false;
      }

      out.push({
        time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
        value: runningSum,
      });
    }
  });
  return out;
}
```

Two subtleties baked in:
- `gap` is constructed **inside** the segment loop so its `wasInAuction` state resets per segment naturally — no explicit `gap.reset()` call needed.
- `runningSum` accumulates **before** the `gap.isHidden` check (defensive — preserves the "hide is rendering, not data" invariant).

Now update `FillStrengthPaneContext` and the spec wrapper (currently lines 132-179):

```ts
export type FillStrengthPaneContext = {
  cumulativeEnabled: boolean;
  auctionWindowMask: boolean;
};

const useFillStrengthContext = (): FillStrengthPaneContext =>
  useActivePrefs(
    useShallow((p): FillStrengthPaneContext => ({
      cumulativeEnabled: p.fillStrengthCumulative,
      auctionWindowMask: p.auctionWindowMask,
    })),
  );

export const FILL_STRENGTH_SPEC = {
  name: 'fill-strength' as const,
  stretch: 0.4,
  useContext: useFillStrengthContext,
  series: [
    {
      type: HistogramSeries,
      options: { color: buy, ...histOpts },
      data: (bundle, axis, ctx) => projectBuy(bundle, axis, ctx.auctionWindowMask),
    },
    {
      type: HistogramSeries,
      options: { color: sell, ...histOpts },
      data: (bundle, axis, ctx) => projectSell(bundle, axis, ctx.auctionWindowMask),
    },
    {
      type: LineSeries,
      options: {
        color: cumulative,
        lineWidth: 2,
        lineStyle: 0,
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: cumulativePriceFormat,
      },
      data: (bundle, axis, ctx) =>
        ctx.cumulativeEnabled ? projectCumulativeNetFill(bundle, axis, ctx.auctionWindowMask) : [],
      afterAdd: (series) => addZeroBaselineGuide(series, cumulativeBaseline),
    },
  ],
} satisfies PaneSpec<FillStrengthPaneContext>;
```

- [ ] **Step 4: Run all fillStrength tests**

```bash
cd frontend && npx vitest run src/chart/projectors/fillStrength.test.ts
```

Expected: all tests pass (existing single-day, multi-day, anchor, and SPEC-shape tests + the 3 new describe blocks added in step 1).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/fillStrength.ts frontend/src/chart/projectors/fillStrength.test.ts
git commit -m "$(cat <<'EOF'
feat(fill-strength): hide in-auction points; cumulative breaks at 15:20 (ADR-0029)

Spec: docs/superpowers/specs/2026-05-25-auction-window-hide-design.md
projectBuy / projectSell gain an auctionWindowMask parameter and drop in-
window points; no whitespace needed (histograms have no continuity).
projectCumulativeNetFill threads the same parameter, suppresses in-window
emission, and inserts a boundary whitespace per segment. runningSum keeps
accumulating across hidden points so the invariant "hide is a rendering
decision, not a data decision" stays clean. FillStrengthPaneContext +
useFillStrengthContext gain the new field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full-suite verification + smoke test

**Why:** Catches anything the per-file runs missed (typecheck regressions, snapshot tests elsewhere, integration breakage).

- [ ] **Step 1: Run the full frontend test suite**

```bash
cd frontend && npx vitest run
```

Expected: every test passes. If anything fails, fix it inline — typically this would be a stale snapshot or a test in `replay/`, `state/`, or `sidebar/` that references the now-unused `isAuctionMaskActive` import for `RatioPane` / `QuoteTotalsPane`.

- [ ] **Step 2: Run the TypeScript compiler**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors. If `tsc` complains about unused imports of `isAuctionMaskActive` in any projector, remove them. (The helper is no longer used by projectors; `state/useAuctionMaskActive.ts` still imports `isAuctionMaskActive` for spot views — leave that alone.)

- [ ] **Step 3: Verify the dev server boots and the chart renders**

Start the backend and frontend dev servers (per CLAUDE.md):

```bash
# Terminal A
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
# Terminal B
cd frontend && npm run dev
```

Open `http://localhost:5173/replay` in a browser. Pick a code+date that has captured data and confirm:

1. With the toggle on (default), the Ratio / QuoteTotals / FillStrength panes have a clean visual gap from 15:20 to 15:30 (no flatline-at-0 plateau, no diagonal interpolation line cutting through the band).
2. Toggling `Settings → 동시호가 구간 지표 숨김` off restores the original full-day rendering for those panes (호가비 reads as raw imbalance, QuoteTotals show raw accumulating levels, FillStrength shows whatever bars/cumulative exist).
3. Candle pane (with MA overlay) and Volume pane look identical regardless of toggle state.
4. The Auction Window background band (subtle grey strip behind 15:20-15:30) appears in both toggle states — it's tied to the same prefs but unrelated to the projector hide.

- [ ] **Step 4: Commit nothing — verification only**

No code changes here. If steps 1-3 surface a regression, fix it via a new commit referencing this task.

---

## Self-Review Notes (resolved during plan writing)

**Spec coverage**: every section of `docs/superpowers/specs/2026-05-25-auction-window-hide-design.md` maps to a task — toggle text → Task 1, helper → Task 2, ratio → Task 3, quoteTotals → Task 4, fillStrength (all three series + ctx + spec wrapper) → Task 5, full-suite check → Task 6.

**Placeholder scan**: no `TBD` / `TODO` / "fill in" / vague handling. All code blocks are complete.

**Type consistency**: `makeAuctionMaskGap` signature, `AuctionMaskGap` type members (`breakBefore`, `isHidden`, `reset`), and `FillStrengthPaneContext` field name (`auctionWindowMask`) all match across Tasks 2-5. The boundary-whitespace time formula `(t - 1) / 1000` (in axis-virtual seconds, with the `-1` in ms) is consistent in helper + ratio + quoteTotals + fillStrength tests.
