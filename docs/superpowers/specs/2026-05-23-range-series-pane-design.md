# RangeSeriesPane — Deep Module for Chart Pane Lifecycle

**Date**: 2026-05-23
**Topic**: Unify five near-clone chart pane components (CandlePane,
VolumePane, RatioPane, QuoteTotalsPane, FillStrengthPane) behind a
single deep module `RangeSeriesPane` parameterized by a `PaneSpec`
data structure. Migration via infra-first, pane-by-pane.

## Context

The Replay Viewer mounts five chart panes on a shared `lightweight-charts`
instance. After completing the Quote Totals Pane work
(`docs/superpowers/specs/2026-05-23-quote-totals-pane-design.md`), an
architectural review surfaced that all five panes follow an identical
lifecycle shape:

```
useEffect → resolveTokens → chart.addSeries × N
  → bundle.<key>.points.filter(p => axis.contains(p.t))
  → .map(p => ({ time: axis.toVirtual(p.t) / 1000, value: <projection> }))
  → setData
  → cleanup: try { chart.removeSeries } catch
```

Only the per-pane *projection* varies (which `bundle` key, which fields,
per-bucket color logic, prefs-aware masking). The shared boilerplate is
~30-40 LOC per pane, repeated five times. Cross-cutting policy changes —
such as the recent ChartErrorBoundary teardown-race guard that left
"Matches IntensityPane" comments scattered across CandlePane, RatioPane,
and VolumeProfileOverlay (cleaned in commit `4966cf0`) — must be applied
in N places and tend to drift.

The five panes are **shallow modules** in the
`improve-codebase-architecture` sense: each pane's interface (4 props)
is nearly as complex as its implementation (~70-140 LOC). Most of that
implementation is the same boilerplate. Unifying behind one deep module
concentrates the cross-cutting policy in a single seam.

A forward-looking factor: future indicators (EMA / SMA / BB / MACD /
거래원 net / VWAP / OBV / …) are anticipated to derive from the same
RangeBundle shape. Each new indicator under the current pattern costs
~70-140 LOC of duplicated boilerplate plus three ChartStage edits;
under the unified pattern, ~30 LOC of pure projection logic in one
file plus one entry in the spec registry.

## Goals

- Introduce `frontend/src/chart/RangeSeriesPane.tsx` as the deep module
  that owns chart-pane lifecycle. It accepts a `PaneSpec` and a `paneIndex`
  prop; it does not contain any per-pane domain logic.
- Define a `PaneSpec` interface with exactly five slots (name, stretch,
  series, useContext, plus per-series afterAdd). Refuse to grow beyond
  five — a sixth slot is the signal the abstraction is leaking and
  needs redesign.
- Co-locate the five per-pane projector functions under
  `frontend/src/chart/projectors/{name}.ts` as pure functions
  unit-tested in isolation. The master `paneSpecs.ts` registry is
  declarative — it lists which projector and series options each pane
  uses, nothing more.
- Migrate the five existing panes one at a time. Each migration is one
  commit, leaves the tree green, and deletes its corresponding old
  component file. The infra commit lands first with the new module
  empty-driven (no panes yet using it), then five migration commits
  in increasing complexity order.
- Preserve the existing `data-pane="<name>"` selectors (used by E2E
  specs and the prior session's pane-leak diagnostics). Selector
  values map 1:1 from `PaneSpec.name`.
- Preserve the established render-order constraint (lightweight-charts
  v5 auto-clamps `paneIndex` to the next available index when
  intermediate panes don't exist). The new `PANES` registry in
  ChartStage holds order *and* stretch in one data structure, so the
  invariant lives in data rather than scattered across JSX + array.

## Non-goals

- VolumeProfileOverlay and DayBoundaryOverlay are NOT unified. They are
  canvas overlays (not lightweight-charts series) with orthogonal
  concerns (data overlay vs structural marker) and are intentionally
  shallow per the architecture review.
- Backend changes — `RangeBundle` wire shape, `build_*_slice` builders.
  No file under `hoga/` is touched.
- New indicators — this PR introduces no new pane data; it strictly
  re-homes existing rendering.
- `improve-codebase-architecture` candidates 2 (ChartStage PANES
  data-driven) and 3 (test mock consolidation) are *subsumed* by this
  refactor and need no separate work — the PANES array is part of
  ChartStage's RangeSeriesPane integration (candidate 2), and the test
  mock pattern is replaced by projector-level unit tests +
  spec-driven RangeSeriesPane integration tests (candidate 3).

## Architecture

### RangeSeriesPane

A single React component owning the full chart-pane lifecycle:

```tsx
type SeriesSpec<Ctx = void> = {
  type: SeriesDefinition;                       // CandlestickSeries | LineSeries | HistogramSeries | BaselineSeries
  options: any;                                 // lightweight-charts series options (as-any consistent with existing convention)
  data: (bundle: RangeBundle,
         axis: VirtualAxis,
         ctx: Ctx) => any[];                    // pure projection; output type matches `type`
  afterAdd?: (series: ISeriesApi<any>) => void; // e.g., createPriceLine(0) for the BaselineSeries zero line
};

type PaneSpec<Ctx = void> = {
  name: string;            // 'candle' | 'volume' | 'ratio' | 'quote-totals' | 'fill-strength'
  stretch: number;         // pane-height weight passed to setStretchFactor
  series: SeriesSpec<Ctx>[];
  useContext?: () => Ctx;  // optional React hook returning per-render context (only RATIO_SPEC uses this for auctionWindowMask)
};

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex: number;
  spec: PaneSpec<any>;
};
```

The component:

1. Calls `spec.useContext?.()` once per render (the hook position is
   stable because `spec` is a module-level constant — rules-of-hooks
   are not violated by the conditional call).
2. In a single `useEffect` with deps `[chart, bundle, axis, paneIndex, ctx]`:
   - Iterates `spec.series`, calling `chart.addSeries(s.type, s.options, paneIndex)` for each.
   - Calls `s.afterAdd?.(series)` after each add (e.g., RatioPane's `createPriceLine`).
   - Calls each `s.data(bundle, axis, ctx)` and passes the result to `series.setData`.
   - Returns a cleanup that calls `chart.removeSeries(series)` inside `try/catch` for each — the ChartErrorBoundary teardown-race guard owned in one place.

The body returns `null`; the wrapper div with `data-pane={spec.name}`
and `className="hidden"` lives in ChartStage's `PANES.map` render block.

### paneSpecs.ts — Declarative Registry

A short, scannable index of the five panes:

```ts
import { CANDLE_SPEC } from './projectors/candle';
import { VOLUME_SPEC } from './projectors/volume';
import { RATIO_SPEC } from './projectors/ratio';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';

export const PANE_SPECS = [
  CANDLE_SPEC,         // paneIndex 0
  VOLUME_SPEC,         // paneIndex 1
  RATIO_SPEC,          // paneIndex 2
  QUOTE_TOTALS_SPEC,   // paneIndex 3
  FILL_STRENGTH_SPEC,  // paneIndex 4
] as const;

export const PANE_STRETCH = PANE_SPECS.map((s) => s.stretch);
```

ChartStage renders:

```tsx
{PANE_SPECS.map((spec, i) => (
  <div key={spec.name} data-pane={spec.name} className="hidden">
    <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={i} spec={spec} />
  </div>
))}
```

This collapses ChartStage's five hand-mounted pane blocks plus the
parallel `PANE_STRETCH` array into one data-driven loop. The
render-order constraint (lightweight-charts v5 pane-index clamping) is
enforced by `PANE_SPECS` ordering — no JSX position to drift.

### projectors/{name}.ts — Pure Functions

Each projector is one file exporting:

1. A pure projector function `(bundle, axis, ctx?) => DataPoint[]`.
2. The corresponding `*_SPEC: PaneSpec` constant that uses it.
3. (Co-located) a `*.test.ts` file unit-testing the projector with
   varied fixtures.

Example shape (`projectors/quoteTotals.ts`):

```ts
import { LineSeries } from 'lightweight-charts';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = { up: ['--up', '#22C55E'], down: ['--down', '#F43F5E'] } as const;

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
  minMove: 1,
};

export const projectBid = (bundle, axis) =>
  bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: axis.toVirtual(p.t) / 1000, value: p.bid_total }));

export const projectAsk = (bundle, axis) =>
  bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: axis.toVirtual(p.t) / 1000, value: p.ask_total }));

const { up, down } = resolveTokens(TOKEN_SPEC);

export const QUOTE_TOTALS_SPEC: PaneSpec = {
  name: 'quote-totals',
  stretch: 0.4,
  series: [
    { type: LineSeries, options: { color: up, lineWidth: 1, priceFormat }, data: projectBid },
    { type: LineSeries, options: { color: down, lineWidth: 1, priceFormat }, data: projectAsk },
  ],
};
```

The `projectBid` / `projectAsk` exports are independently unit-testable
without rendering React.

### Per-pane spec summary

| spec | series count | type | data source | useContext | afterAdd |
|---|---|---|---|---|---|
| `CANDLE_SPEC` | 1 | CandlestickSeries | `bundle.candles[]` | — | — |
| `VOLUME_SPEC` | 1 | HistogramSeries (per-bucket color via point.color) | `bundle.candles[]` | — | — |
| `RATIO_SPEC` | 1 | BaselineSeries | `bundle.quote_ratio.points[]` | `useChartPrefs` → `auctionWindowMask` | `createPriceLine(0)` |
| `QUOTE_TOTALS_SPEC` | 2 | LineSeries × 2 | `bundle.quote_ratio.points[]` | — | — |
| `FILL_STRENGTH_SPEC` | 2 | HistogramSeries × 2 (one negated) | `bundle.fill_strength.points[]` | — | — |

### CONTEXT.md entry

`RangeSeriesPane` is already registered in `CONTEXT.md` as a new
glossary term — added inline during the grill session that produced
this design.

## Migration plan

Six commits, each green at boundary.

### Commit 1 — Infra

Creates the infra files with QuoteTotalsPane as the first concrete
consumer (chosen because it's the simplest and was just freshly built
in the prior session):

- Create `frontend/src/chart/RangeSeriesPane.tsx` with the component.
- Create `frontend/src/chart/paneSpecs.ts` with an interim registry
  that contains ONLY `QUOTE_TOTALS_SPEC`. The other four entries are
  placeholders or absent.
- Create `frontend/src/chart/projectors/quoteTotals.ts` exporting
  `projectBid`, `projectAsk`, `QUOTE_TOTALS_SPEC`.
- Create `frontend/src/chart/projectors/quoteTotals.test.ts` with
  projector unit tests (axis filtering, virtual-time mapping,
  bid/ask correctness).
- Create `frontend/tests/component/RangeSeriesPane.test.tsx` with
  spec-driven integration tests (single-series spec, multi-series
  spec, useContext invocation, afterAdd invocation, cleanup
  removeSeries × N).
- Modify `ChartStage.tsx`: import `PANE_SPECS`, replace the
  hand-mounted `<QuoteTotalsPane>` block with `<RangeSeriesPane spec={QUOTE_TOTALS_SPEC} paneIndex={3} />` inside its existing data-pane wrapper. Keep the other four hand-mounted pane blocks unchanged.
- Delete `frontend/src/chart/QuoteTotalsPane.tsx`.
- Delete `frontend/tests/component/QuoteTotalsPane.test.tsx`.
- Update `frontend/tests/component/ChartStage.test.tsx`'s
  `vi.mock('../../src/chart/QuoteTotalsPane', …)` to mock RangeSeriesPane (one mock to replace both — the other four panes still mock individually until their migration commits).

### Commit 2 — Volume migration

- Create `frontend/src/chart/projectors/volume.ts` exporting
  `projectVolume`, `VOLUME_SPEC`. Per-bucket color computed from
  candle direction (`close >= open ? up : down`).
- Create `frontend/src/chart/projectors/volume.test.ts`.
- Add `VOLUME_SPEC` to `PANE_SPECS` registry.
- Modify `ChartStage.tsx`: replace `<VolumePane>` block with
  `<RangeSeriesPane spec={VOLUME_SPEC} paneIndex={1} />`.
- Delete `frontend/src/chart/VolumePane.tsx`.
- Delete `frontend/tests/component/VolumePane.test.tsx`.
- Remove `vi.mock('../../src/chart/VolumePane', …)` from
  `ChartStage.test.tsx`.

### Commit 3 — FillStrength migration

- Create `frontend/src/chart/projectors/fillStrength.ts` exporting
  `projectBuy`, `projectSell` (negated), `FILL_STRENGTH_SPEC`.
- Create `frontend/src/chart/projectors/fillStrength.test.ts`.
- Add `FILL_STRENGTH_SPEC` to registry, replace
  `<FillStrengthPane>` in ChartStage with RangeSeriesPane.
- Delete `frontend/src/chart/FillStrengthPane.tsx` and its test.
- Update `vi.mock` in `ChartStage.test.tsx`.

### Commit 4 — Candle migration

- Create `frontend/src/chart/projectors/candle.ts` exporting
  `projectCandle` (OHLC mapping + per-segment muted tint via
  `axis.inClosingAuctionWindow`), `CANDLE_SPEC`.
- Create `frontend/src/chart/projectors/candle.test.ts` —
  including a test for the muted-tint threshold across day
  boundaries.
- Add `CANDLE_SPEC` to registry, replace `<CandlePane>` in
  ChartStage with RangeSeriesPane.
- Delete `frontend/src/chart/CandlePane.tsx`. Delete
  `frontend/src/chart/CandlePane.test.tsx` (the existing test file
  lives in `src/`, unlike sibling panes — see Risks).
- Update `vi.mock`.

### Commit 5 — Ratio migration

- Create `frontend/src/chart/projectors/ratio.ts` exporting
  `projectRatio` ((bid_total, ask_total) → quoteImbalance, then
  apply `auctionWindowMask` via `axis.inClosingAuctionWindow` when
  the prefs flag is on), `useRatioContext` (returns
  `useChartPrefs().auctionWindowMask`), `RATIO_SPEC` with
  `useContext: useRatioContext` and the BaselineSeries gradient
  options preserved from the current RatioPane. `afterAdd` calls
  `createPriceLine({ price: 0, … })`.
- Create `frontend/src/chart/projectors/ratio.test.ts` — with ctx
  injected as a plain object (no React rendering needed for the
  projector unit; only the `useRatioContext` hook itself uses
  React, and that path is exercised by integration tests).
- Add `RATIO_SPEC` to registry, replace `<RatioPane>` in
  ChartStage with RangeSeriesPane.
- Delete `frontend/src/chart/RatioPane.tsx` and
  `frontend/tests/component/RatioPane.test.tsx`.
- Update `vi.mock` in `ChartStage.test.tsx`.

### Commit 6 — ChartStage finalization

- Now that all five panes use RangeSeriesPane, refactor
  `ChartStage.tsx`'s render block to a single `PANE_SPECS.map(...)`
  loop replacing the five hand-mounted blocks.
- Replace `PANE_STRETCH = [1.4, 0.3, 0.4, 0.4, 0.4] as const` with
  `PANE_STRETCH = PANE_SPECS.map(s => s.stretch)`.
- Simplify the jsdoc — the pane list now lives in `PANE_SPECS`, so
  the bullet-list at top of file can shrink to a one-line pointer.
- The inline comment about lightweight-charts v5's auto-clamp
  behavior stays — that's the invariant that `PANE_SPECS` ordering
  encodes; the comment is the reason future readers can't reorder
  carelessly.

After Commit 6, the only chart-pane components remaining under
`frontend/src/chart/` are `RangeSeriesPane.tsx`,
`VolumeProfileOverlay.tsx`, `DayBoundaryOverlay.tsx`, and
`ChartStage.tsx`. The five `*Pane.tsx` files are gone.

## Testing

### Projector unit tests (5 files, pure functions)

Each `projectors/{name}.test.ts` exercises the projector function
directly:

- Inputs: a fixture `bundle`, a `createVirtualAxis(...)` axis, an
  optional `ctx` object.
- Assertions: returned `DataPoint[]` matches expected shape and
  values (e.g., bid_total mapped to `value`, virtual-time correct,
  pre-open auction points dropped, day-boundary handling correct).
- No React render needed; tests are fast and have a tiny mock
  surface.

Notable per-projector tests:

- `candle.test.ts`: muted-tint threshold (15:20 KST onward per
  segment), day-boundary correctness for multi-segment fixtures.
- `volume.test.ts`: per-bucket color matches candle direction.
- `ratio.test.ts`: `auctionWindowMask` ctx flag drops values in
  the 15:20-15:30 closing-auction window; quoteImbalance math.
- `quoteTotals.test.ts`: bid/ask value extraction, pre-open drop.
- `fillStrength.test.ts`: sell side negation, virtual-time mapping.

### RangeSeriesPane integration test (1 file)

`frontend/tests/component/RangeSeriesPane.test.tsx` uses a
`makeMockChart()` helper (lives in this same file initially; can
later move to `frontend/tests/helpers/` if reused) and renders the
component with three synthetic spec fixtures:

- **Single-series spec, no ctx**: asserts `addSeries × 1`,
  `setData` called with projector output, `removeSeries × 1` on
  unmount.
- **Two-series spec, no ctx**: same but × 2; verifies series
  ordering and per-series options pass-through.
- **Spec with useContext + afterAdd**: asserts the hook is called,
  the result is passed to each `data(...)` invocation, and
  `afterAdd(series)` runs once per added series.

These three tests cover the entire RangeSeriesPane surface. The
five per-pane integration tests that exist today are *replaced* by
the five projector unit tests plus this one integration test.

### ChartStage.test.tsx

Switches from five `vi.mock('../../src/chart/{Name}Pane', …)` calls
to one `vi.mock('../../src/chart/RangeSeriesPane', …)`. The mock
stub continues to `() => null`. Existing assertions about
`data-pane=...` wrapper presence stay valid (wrappers now generated
by `PANE_SPECS.map`).

### E2E specs

`frontend/tests/e2e/replay-smoke.spec.ts` still asserts on
`data-pane="..."` selectors. Selector values are preserved 1:1
through `PaneSpec.name`. No change.

## Risks

- **PaneSpec interface bloat**: the agreed slot count is five
  (`name`, `stretch`, `series`, `useContext?`, plus per-series
  `afterAdd?`). A sixth slot is the sentinel that abstraction has
  leaked — at that point, redesign rather than grow. This is a
  guardrail, not a prediction; we currently know of no need for a
  sixth slot among today's five panes or near-future indicators.

- **CandlePane's existing test file lives in `src/`, not `tests/component/`**.
  Unlike its sibling pane tests, `frontend/src/chart/CandlePane.test.tsx`
  is co-located. Commit 4 deletes it. The new projector test
  `projectors/candle.test.ts` co-locates similarly, so the
  test-location convention isn't disturbed.

- **VolumePane and CandlePane both read `bundle.candles[]`**.
  Their projectors share the candle data source; if a future
  refactor wants to derive both panes from one shared candle
  iteration (e.g., for performance), the spec system tolerates it
  trivially — the projector for each is a separate pure function;
  shared work would happen inside a small util consumed by both.

- **`useChartPrefs` hook position**: `RATIO_SPEC.useContext` is
  called inside RangeSeriesPane's render. The hook is invoked
  conditionally (only when `spec.useContext` is defined). Rules-of-hooks
  permit this *because the spec is a module-level constant* — at any
  given render of a specific RangeSeriesPane instance, the hook
  presence/absence is stable across the component's lifetime. If a
  future spec dynamically swaps `useContext` in/out, that would
  violate rules-of-hooks; the agreed convention is "spec is
  module-level constant, never mutated."

- **DataPoint type union**: lightweight-charts has typed data
  interfaces per series type (`HistogramData`, `LineData`,
  `CandlestickData`, `BaselineData`). The PaneSpec's `data` field
  returns `any[]` to avoid forcing TypeScript-side discrimination.
  This matches the existing `as any` convention used by
  RatioPane and FillStrengthPane. Type safety inside each
  projector is the projector author's responsibility; at the
  RangeSeriesPane seam, the data is opaque.

## Verification checklist

After Commit 6, before declaring done:

1. `pnpm exec tsc -b` exits 0.
2. `pnpm exec vitest run` — all tests PASS (note: 5 old pane test
   files deleted; 5 projector test files added; 1
   RangeSeriesPane integration test added; total test count
   should be within ±15 of the pre-refactor count).
3. `git grep -E "CandlePane|VolumePane|RatioPane|QuoteTotalsPane|FillStrengthPane" -- frontend/`
   returns zero hits except inside `docs/`.
4. `/replay` for `003490` between 2026-05-19 and 2026-05-20 at 1 m
   renders five panes with the same visual output as before the
   refactor. Spot-check each pane's labels and colors against the
   pre-refactor screenshot.
5. The previously-fixed FillStrength leak into pane 3 (prior session
   regression) still does not recur.
6. The CONTEXT.md `RangeSeriesPane` glossary entry is accurate
   relative to the final code.

## Cross-references

- **CONTEXT.md** — `RangeSeriesPane` glossary entry added in the
  grill session preceding this spec.
- **Spec** `docs/superpowers/specs/2026-05-23-quote-totals-pane-design.md`
  — the prior session's spec that QuoteTotalsPane came from; this
  refactor extends its single-pane work into a 5-pane unification.
- **ADR-0013** (RangeBundle single read path) — the wire model
  whose series this refactor renders; unaffected by this PR.
- **ADR-0016** (depth_intensity retirement) — the recent ADR that
  removed the 6th pane (`IntensityPane`) and freed the pane-3 slot
  for QuoteTotalsPane; this refactor unifies the panes that remain.
