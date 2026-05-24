# Auction Mask predicate unification — design

**Status:** Draft
**Date:** 2026-05-24
**Owner:** frontend

## Problem

The Auction Mask predicate `auctionWindowMask && axis.inClosingAuctionWindow(t)` lives in **two shapes** today:

| Location | Form | Why |
|---|---|---|
| `state/useAuctionMaskActive.ts` | React hook | Spot views (TotalQtyBar) — inside React tree, can call hooks |
| `chart/projectors/ratio.ts:59` | Inline `&&` expression | Series projector — not React tree, can't call hooks |
| `chart/projectors/quoteTotals.ts:36,52` | Inline `&&` × 2 (bid + ask) | Same as above |

**3 inline duplications + 1 hook body** = 4 callsites that must drift together. CONTEXT.md explicitly acknowledges this (line 50: "series projectors ... inline the same predicate ... because they are not React-tree code and cannot call hooks"). Acknowledging the duplication isn't the same as having a fix — and the comment is itself a friction signal.

When (not if) the predicate evolves — say "Auction Mask should also fire during half-day pre-close" — four edits in four files have to land together, and the hook + inlines can drift silently.

## Goal

A single **pure predicate** module — `frontend/src/util/auctionMask.ts` — owning the Auction Mask decision rule. The existing React hook delegates to it. Series projectors call it directly.

```ts
// util/auctionMask.ts
export function isAuctionMaskActive(
  auctionWindowMask: boolean,
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow'>,
  t: number,
): boolean
```

After the change:
- 4 callsites all read the same function.
- One place to change the rule.
- Pure-function unit tests cover the rule (no React renderer needed for the rule itself).
- The hook keeps its responsibility — reading store + cursor + null guards — but no longer owns the rule.

## Non-goals

- **No domain-term change.** "Auction Mask" stays exactly as defined in CONTEXT.md. The pure predicate is a *new utility for an existing concept*, not a renaming.
- **Candle muting is NOT folded in** (per ADR-0018). `chart/projectors/candle.ts:25` calls `axis.inClosingAuctionWindow` for *muting*, not *masking* — different semantic (price-formation cue vs. misleading-value suppression). Leave it.
- **`AuctionWindowOverlay.tsx:48` is NOT a callsite.** It checks `prefs.auctionWindowMask` to decide whether to *render the overlay at all* — there's no axis/t involved. Leave it.
- **No change to `axis.inClosingAuctionWindow`** — that primitive stays on `VirtualAxis`; this work consolidates the **toggle + predicate** composition only.
- **No change to the hook's location** — `state/useAuctionMaskActive.ts` stays, because reading `useTabsStore` + `useCursor` is store-coupled.

## Architecture

### New module: `frontend/src/util/auctionMask.ts`

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

**Why `util/` not `state/`:** the predicate has zero state coupling. `state/` houses store-coupled modules; `util/` houses pure domain helpers. Same convention as `util/sessionTime.ts` (the broader phase-classification module the Auction Window definition lives within).

**Why `Pick<VirtualAxis, ...>`:** the function only needs `inClosingAuctionWindow`. The narrow type lets unit tests pass `{ inClosingAuctionWindow: (t) => boolean }` without mocking the full `VirtualAxis` surface.

### Hook delegation: `state/useAuctionMaskActive.ts`

Replace the inline rule with a delegation:

```ts
import { useTabsStore } from './tabs';
import { useCursor } from '../api/useCursor';
import { isAuctionMaskActive } from '../util/auctionMask';
import type { VirtualAxis } from '../util/virtualAxis';

export function useAuctionMaskActive(axis: VirtualAxis): boolean {
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask);
  const { cursorMs } = useCursor();
  if (cursorMs == null || !Number.isFinite(cursorMs)) return false;
  return isAuctionMaskActive(auctionWindowMask, axis, cursorMs);
}
```

The hook now owns **only** what makes it a hook: store reads, cursor read, null guards. The rule itself lives in `util/auctionMask.ts`.

### Projector callsite migration

**`chart/projectors/ratio.ts`** — line 59:
```ts
// Before
auctionWindowMask && axis.inClosingAuctionWindow(p.t)
  ? 0
  : quoteImbalance(p.bid_total, p.ask_total),

// After
isAuctionMaskActive(auctionWindowMask, axis, p.t)
  ? 0
  : quoteImbalance(p.bid_total, p.ask_total),
```

**`chart/projectors/quoteTotals.ts`** — lines 36 + 52 (bid + ask):
```ts
// Before
auctionWindowMask && axis.inClosingAuctionWindow(p.t) ? 0 : p.bid_total,

// After
isAuctionMaskActive(auctionWindowMask, axis, p.t) ? 0 : p.bid_total,
```
(Same pattern for `ask_total`.)

Each projector adds:
```ts
import { isAuctionMaskActive } from '../../util/auctionMask';
```

### What does NOT change

- `chart/projectors/candle.ts:25` — `axis.inClosingAuctionWindow(c.ts_ms)` is candle muting (ADR-0018), not masking.
- `chart/AuctionWindowOverlay.tsx:48` — `prefs.auctionWindowMask` is a render-or-not decision; no `t`, no axis call.
- `state/tabs.ts` `CHART_TOGGLES[].key === 'auctionWindowMask'` — that's the toggle storage key, unrelated.
- `util/virtualAxis.ts` — `inClosingAuctionWindow` stays a `VirtualAxis` method.
- `util/sessionTime.ts` — owns the timing rule that `inClosingAuctionWindow` delegates to; unaffected.

## Files

### Created
- `frontend/src/util/auctionMask.ts` — ~25 LOC including the docstring.
- `frontend/src/util/auctionMask.test.ts` — ~50 LOC, pure-function tests.

### Modified
- `frontend/src/state/useAuctionMaskActive.ts` — delegate to `isAuctionMaskActive`. Net delta: ~3 lines.
- `frontend/src/chart/projectors/ratio.ts` — replace inline expression with call. 1 callsite + 1 import.
- `frontend/src/chart/projectors/quoteTotals.ts` — replace 2 inline expressions with calls. 2 callsites + 1 import.

### Not touched
- `state/useAuctionMaskActive.test.ts` — the 3 hook behaviors (toggle off / cursor null / axis predicate result) are unchanged; existing tests still pass without edit. The hook's external contract is identical.
- `chart/projectors/candle.ts`, `chart/AuctionWindowOverlay.tsx` — different semantics, per non-goals.
- CONTEXT.md — no domain term change.

## Behavior contracts (must hold)

1. **Pure equivalence**: `isAuctionMaskActive(toggle, axis, t)` returns exactly `toggle && axis.inClosingAuctionWindow(t)` for every input — no extra logic, no short-circuit changes.
2. **Hook behavior unchanged**: 3 existing tests in `useAuctionMaskActive.test.ts` pass unmodified.
3. **Projector output unchanged**: visual regression risk = 0 (pure refactor of an expression). Existing `frontend/src/api/` and other consumers of `RangeBundle` are unaffected.

## Edge cases (covered by new tests)

| Case | Expected |
|---|---|
| `toggle === false`, axis would return true | `false`. Axis predicate **not** called (short-circuit). |
| `toggle === true`, axis returns `false` | `false` |
| `toggle === true`, axis returns `true` | `true` |
| `toggle === false`, axis would throw | `false`. No call → no throw. |
| `t === 0` (truthy boundary check defense) | Forwarded to axis verbatim; result is whatever axis returns. |
| Negative or non-finite `t` | Forwarded to axis verbatim — guarding non-finite numbers is the *caller's* responsibility (the hook guards `cursorMs == null`; projectors trust `bundle.quote_ratio.points[*].t` is finite per wire contract). |

## Testing

### `util/auctionMask.test.ts` — unit tests on the pure predicate
1. `toggle off + axis would return true` → `false`, axis predicate not invoked (verified via spy)
2. `toggle on + axis returns false` → `false`
3. `toggle on + axis returns true` → `true`
4. `toggle off + axis throws if called` → `false` without throw (defends short-circuit)
5. `t === 0` → forwarded; result matches axis

### Regression
- `state/useAuctionMaskActive.test.ts` — 3 existing tests pass unchanged (delegates to the new util internally; external contract identical).
- `frontend/src/api/`, `frontend/src/chart/`, etc. — no test changes; behavior preserved.

### Manual
- Open `/replay` with a captured Stock-Date that includes the 15:20–15:30 closing window. Toggle Auction Mask on/off in Settings. Verify:
  - RatioPane goes flat / non-flat through the window
  - QuoteTotalsPane bid + ask collapse to 0 / non-zero through the window
  - TotalQtyBar (sidebar spot reading) follows when cursor is inside the window

## Open questions

None.

## Out of scope / 후속

- Folding `candle.ts` muting into the same module — different semantic per ADR-0018.
- Generalising "predicate + toggle composition" across other settings — only one such composition exists today (the Auction Mask itself).
- `useChartPrefs` shallow wrapper deletion (friction #2 from the deepening exploration) — separate candidate, deferred to a later session.
