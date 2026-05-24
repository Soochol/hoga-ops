# Projector deepening follow-ups (from FillStrength cumulative line work)

Surfaced by the `/improve-codebase-architecture` pass after merging the **Cumulative Net Fill (체결강도 누적)** feature (commits `129f399..8427168` + zero-baseline helper `<TBD-after-commit>`). Three deepening opportunities are recorded here for later — none are blockers, and one ("zero-baseline guide") was already applied inline. Order is by leverage, highest first.

Glossary used: see `/home/dev/.claude/skills/improve-codebase-architecture/LANGUAGE.md`. Domain terms per `CONTEXT.md`.

---

## 1. `VirtualAxis.projectTime(realMs)` — fold contains+toVirtual into one call

**Status:** open — recommended next deepening pass

**Files involved (today's call sites):**
- `frontend/src/chart/projectors/candle.ts:23-28`
- `frontend/src/chart/projectors/volume.ts:22-24`
- `frontend/src/chart/projectors/ratio.ts:66-77`
- `frontend/src/chart/projectors/quoteTotals.ts:30-48`
- `frontend/src/chart/projectors/movingAverage.ts:85-91`
- `frontend/src/chart/projectors/fillStrength.ts:35-44,75-77`

**Problem.** Six projectors repeat the same idiom:

```ts
bundle.X.points
  .filter((p) => axis.contains(p.t))
  .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: ... }));
```

`VirtualAxis`'s **interface** exposes `contains` and `toVirtual` as independent operations, but every caller pairs them in the same order and applies the same `/1000` divide + `UTCTimestamp` cast. The result: the time-encoding contract leaks across six modules. A change like "switch to nanosecond precision" or "stop using the `as any` cast" would touch six files.

**Solution.** Add a method to `VirtualAxis`:

```ts
// frontend/src/util/virtualAxis.ts
projectTime(realMs: number): UTCTimestamp | null  // null = out of viewport
```

Callers collapse to:

```ts
bundle.X.points.flatMap((p) => {
  const time = axis.projectTime(p.t);
  return time === null ? [] : [{ time, value: ... }];
});
```

Or, with a helper `projectPoint<T>(realMs, value: T): { time, value } | null`, even tighter.

**Why this earns its keep (deletion test):** if `projectTime` is deleted, the six callers each re-invent the `contains → toVirtual → /1000 → cast` chain. Complexity *concentrates* when the method exists; it *spreads* when it doesn't. Passes.

**Test surface:** `virtualAxis.test.ts` already tests `contains` and `toVirtual` independently; a small `projectTime` test confirms the null-on-out-of-viewport contract. Projector tests then only assert the value transformation, which is what they're really about.

**Size:** 6 projector files + `virtualAxis.ts` + matching test updates. ~150 LoC churn.

**Care points:**
- The Cumulative Net Fill projector ([fillStrength.ts:65-83](../../frontend/src/chart/projectors/fillStrength.ts#L65-L83)) splits in-session vs in-viewport on purpose (the in-session gate runs the sum even when the point is out-of-viewport). `projectTime` only owns the in-viewport gate; the in-session gate stays inline. Document this distinction in the helper's JSDoc.

---

## 2. `usePaneContext<T>(selector)` — centralize the `useShallow + useActivePrefs` ritual

**Status:** open — small, high-locality

**Files involved:**
- `frontend/src/chart/projectors/ratio.ts:96-103` (`useRatioContext`, with the "Maximum update depth exceeded" warning JSDoc)
- `frontend/src/chart/projectors/fillStrength.ts:89-99` (`useFillStrengthContext`, same JSDoc warning paraphrased)

**Problem.** Two **adapters** wrap `useActivePrefs` with `useShallow` to stabilize an object-literal reference. The warning ("without useShallow, every render creates a fresh object and the data effect re-runs, causing the infinite-loop case `useCursor.ts` documented") is duplicated in both files. A third pane that ships without that wrapping is one PR away from re-discovering the trap.

By LANGUAGE.md's rule: *two adapters = a real seam*.

**Solution.** Add a tiny helper next to `RangeSeriesPane`:

```ts
// frontend/src/chart/RangeSeriesPane.ts (or a sibling utils file)
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs, type ChartViewPrefs } from '../state/chartPrefs';

/** Subscribe to a slice of the active tab's ChartViewPrefs with reference
 *  stability for object-shaped selectors. Required for any PaneSpec
 *  `useContext` callback that returns an object literal — without
 *  useShallow, every render creates a fresh reference and the data effect
 *  re-runs (worst case: infinite loop, documented in useCursor.ts). */
export function usePaneContext<T>(selector: (prefs: ChartViewPrefs) => T): T {
  return useActivePrefs(useShallow(selector));
}
```

Callers shrink to:

```ts
const useFillStrengthContext = () =>
  usePaneContext((p) => ({ cumulativeEnabled: p.fillStrengthCumulative }));
```

**Why this earns its keep (deletion test):** delete `usePaneContext`, and the warning JSDoc + ritual re-spreads to every pane context hook. The trap (infinite loop) is severe enough that one-place enforcement is justified at N=2.

**Size:** ~15 LoC new file (or addition to RangeSeriesPane), 2 caller simplifications. Trivial.

**Care points:**
- For pane contexts that return a primitive (`useQuoteTotalsContext` returns a `boolean`), `useShallow` is unnecessary. The helper should still work (Zustand's `Object.is` already handles primitives correctly) but document that the primitive case doesn't need the wrapper at all.

---

## 3. `CHART_TOGGLES` registry shape — defer until 2nd heterogeneous field lands

**Status:** open — ADR-0027 adjacent, defer

**Files involved:**
- `frontend/src/state/chartPrefs.ts:10-52` — `CHART_TOGGLES`, `categoryOf` helper

**Problem.** `as const` narrows each registry entry to its literal shape, dropping fields that the entry omits. Today's only heterogeneous field is `category?: 'chart' | 'indicators'`, and the `categoryOf` helper uses `'category' in t` narrowing to read it safely. The helper works. But every future optional field (an `icon?`, `enabledBy?`, `experimentalSince?`, …) will repeat the same problem and accrue its own `iconOf`, `enabledByOf` helpers.

The underlying tension: ADR-0027 (`chart-numeric-prefs-registry`) chose `as const satisfies readonly NumericPrefDef[]` because `CHART_NUMERIC_PREFS` has a uniform shape. `CHART_TOGGLES` chose `as const` (no `satisfies`) because adding `satisfies` doesn't widen the inferred type, leaving the union narrowing unsolved. So `CHART_TOGGLES` doesn't really enjoy the "one declarative def" property that its numeric sibling does — it just hides the cost behind the helper.

**Why this is deferred.** One `categoryOf` is fine. Two would be a smell; three would be a clear signal. Wait for the second optional field before designing the fix.

**Possible solutions (when the time comes):**

- **(a) Define-time factory** — `defineToggle({ key, label, description, default, category?, ... })` that returns an object normalized to a single supertype (all optional fields explicitly present, set to `undefined` where unprovided). Trade-off: every entry uses a function call instead of a literal; literal type narrowing on `key` still preserved via the factory's generic parameter.
- **(b) Explicit `undefined` per entry** — `category: undefined as ChartToggleCategory | undefined` on the existing two entries. Trivial fix, but cosmetically ugly; doesn't scale to more optional fields.
- **(c) ADR-0027 addendum** — promote the registry shape to a "polymorphic toggle registry" pattern, document why CHART_TOGGLES diverges from CHART_NUMERIC_PREFS. Pair with one of (a) / (b).

If both this and the `usePaneContext` deepening are addressed at once, an addendum to ADR-0027 covering "patterns that emerged after the initial registry" would carry both.

---

## 4. `addZeroBaselineGuide` (DONE inline)

Already applied in this session. The visual contract for the 0-price reference line (dotted, 1px, neutral) is now centralized in `frontend/src/chart/util/zeroBaseline.ts`. Two prior call sites in `ratio.ts` and `fillStrength.ts` collapse to a one-line helper invocation. CONTEXT.md's `Zero Baseline Guide` term entry records the convention.

See commit `<TBD-after-commit>`.
