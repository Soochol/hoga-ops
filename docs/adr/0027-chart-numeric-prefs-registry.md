# 0027 — Numeric chart prefs use a declarative registry, sister to CHART_TOGGLES

**Status:** accepted (2026-05-24)

## Decision

Integer numeric chart preferences (per-tab, persisted via localStorage) live in a single declarative registry `CHART_NUMERIC_PREFS` in `frontend/src/state/chartPrefs.ts`, parallel to the existing `CHART_TOGGLES`:

```ts
export const CHART_NUMERIC_PREFS = [
  {
    key: 'ratioOutlierThreshold',
    label: '호가비 극단값 임계 배수',
    description: '한쪽 호가가 다른 쪽의 이 배수 이상이면 그 시점의 호가비를 0 으로 마스킹합니다…',
    default: 100,
    min: 2,
    max: 10_000,
    enabledBy: 'ratioOutlierFilterEnabled',
  },
] as const satisfies readonly NumericPrefDef[];
```

A new numeric pref is **one registry entry**. The type field on `ChartViewPrefs`, the value in `DEFAULT_PREFS`, the store setter (`setNumericPref`), the `mergePrefs` validation, and the `NumericPrefRow` rendering in the Settings modal all derive automatically.

This applies to scalar integer prefs only. Enum-valued prefs (`volumeProfileMode: 'range' | 'per-day'`) and structured prefs (`movingAverages: MAConfig[]`) remain explicit fields — each has shape that a generic registry can't carry without losing type information.

## Why

When the first numeric pref (`ratioOutlierThreshold`) was added, it required edits in five files:

1. Type field in `ChartViewPrefs` (chartPrefs.ts)
2. Default value in `DEFAULT_PREFS` (chartPrefs.ts)
3. Bespoke setter `setRatioOutlierThreshold` in the store (tabs.ts)
4. Bespoke validation `if (typeof p.ratioOutlierThreshold === 'number' && ...)` in `mergePrefs` (tabsPersistence.ts)
5. Bespoke `RatioOutlierThresholdRow` React component (SettingsModal.tsx)

Boolean toggles, by contrast, had been deepened months earlier into `CHART_TOGGLES`; adding `ratioOutlierFilterEnabled` (the companion toggle for this same feature) cost **one line**. The asymmetry was immediately load-bearing: the next contributor would either copy the scattered `ratioOutlierThreshold` pattern (and inherit the same five-touchpoint cost) or notice the asymmetry and ask "why isn't there a `CHART_NUMERIC_PREFS`?"

The most dangerous of the five touchpoints was (4) — silent bug class. A new pref without the corresponding `mergePrefs` validation would silently accept corrupt localStorage (NaN, out-of-range, wrong type) and pass them straight to projectors, where chart autoscale would break in ways hard to trace to "you forgot to update tabsPersistence.ts." Registry iteration makes this impossible: a pref that's in the type must be in the registry, and the loop runs unconditionally.

The `enabledBy?: ChartToggleKey` field generalizes the toggle/threshold pair pattern (used here for outlier filter on/off + threshold value). When the next such pair lands, no per-pref UI code is needed — the registry entry captures the relationship and `NumericPrefRow` honors it.

## Consequences

- New numeric pref cost: **5 edits → 1 registry entry**.
- `mergePrefs` validation no longer has bespoke if-blocks per numeric pref; the `for (const def of numericPrefDefs)` loop handles all of them.
- `SnapshotDeps` gains a `numericPrefDefs` field, symmetric with `chartToggleKeys` — the persistence module stays acyclic with `chartPrefs` (value imports flow through injection per the existing pattern).
- The generic `setNumericPref(id, key: NumericPrefKey, value)` store action replaces per-pref setters. UI code calls it with a key from the registry; the union type prevents typos.
- Tests for registry-driven validation are themselves generic — a "future numeric pref" can be simulated with a synthetic def object in tests without touching the registry.
- `MovingAverages[]` and `volumeProfileMode` remain on their own paths. The registry's value proposition is "scalar integer, single source of truth for shape"; complex shapes pay for their explicit fields with type safety.

## Alternatives considered

**Full polymorphic pref registry (boolean + numeric + enum + structured in one list).** Rejected. TypeScript can't carry a discriminated union of "value kind" through `Object.fromEntries(...)`-style spread defaults without verbose mapped types per kind. The result would have been ergonomically worse than the current "toggle registry + numeric registry + explicit fields" split, while only saving one Map declaration.

**Register UI renderer per pref in the registry entry.** Rejected (this was the Explorer agent's first suggestion). Moving JSX into `chartPrefs.ts` would invert the state ↔ view dependency — the state module would import React and pull in a transitive view tree. The current split (registry = data shape; Settings modal = generic renderer that iterates registry) keeps the seam clean: a future redesign of the settings UI doesn't touch the registry.

**Wait until 3+ numeric prefs exist before generalizing (rule of three).** Considered and rejected. The trigger for deepening is not "we have N instances" but "the asymmetry has become load-bearing." Right now the *next* contributor adding a numeric pref will hit the five-touchpoint cost; right now the `mergePrefs` silent-bug class is a real footgun. The cost of generalization at N=1 was modest because the boolean registry pattern was already there to mirror — the same generalization at N=3 would be no easier and would have allowed two more scattered prefs to accumulate test/persistence drift in the meantime.

**Per-pref bespoke setter (`setRatioOutlierThreshold(id, value)`) preserved alongside the generic.** Rejected. Two setters for the same operation is the kind of "convenience layer" that drifts — one gets validation logic, the other doesn't. The generic setter with a typed key is one fewer thing to remember.

**Generic `setPref(id, key, value)` that handles both toggles and numerics.** Rejected. Boolean toggles already have `setToggle(id, key: ChartToggleKey, value: boolean)`; collapsing the two would require either runtime kind-dispatch (loses type narrowing — caller could pass a number to a toggle) or a union return type (caller-side guard noise). Keeping `setToggle` and `setNumericPref` as twin specialized seams is the cleaner deepening.

## Relation to CHART_TOGGLES

`CHART_TOGGLES` is the elder sibling: boolean toggles were registered declaratively from early on; this ADR is the late-arrival numeric counterpart. Architecturally they are twin seams — same purpose (single source of truth for chart prefs), same derivation pattern (type/default/setter/validation/UI all auto-derive), same dependency injection through `SnapshotDeps`. Any future ADR proposing a third registry (e.g. `CHART_ENUM_PREFS` for selectable enums) should reference both as the established pattern.
