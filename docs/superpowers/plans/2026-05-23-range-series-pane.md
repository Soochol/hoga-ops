# RangeSeriesPane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the five chart-pane components (CandlePane, VolumePane, RatioPane, QuoteTotalsPane, FillStrengthPane) behind a single deep `RangeSeriesPane` module parameterized by a `PaneSpec` data structure; per-pane domain logic moves into pure projector functions under `frontend/src/chart/projectors/{name}.ts`.

**Architecture:** New `RangeSeriesPane.tsx` owns the lifecycle (resolveTokens-implicit-via-spec, addSeries × N, axis.contains filter, axis.toVirtual mapping, setData, try/catch removeSeries cleanup). Per-pane projectors are pure functions `(bundle, axis, ctx?) => DataPoint[]` unit-tested without React. A `paneSpecs.ts` declarative registry lists the five specs in paneIndex order. ChartStage maps over the registry instead of hand-mounting five blocks.

**Tech Stack:** React 18 + TypeScript, vitest + @testing-library/react, lightweight-charts v5.2.0.

**Spec:** `docs/superpowers/specs/2026-05-23-range-series-pane-design.md`

## Pre-conditions

This plan runs on top of commit `f421797` (final fixup of the Quote Totals Pane work) and `9d6aebe` (this spec + CONTEXT.md update). The 5 panes' current source is the verified state from that point. The pre-existing dirty files in the working tree (`frontend/src/util/time.ts`, `hoga/api/symbols.py`, `tests/test_api_symbols.py`, `frontend/src/state/tabs.ts` — count varies as user makes parallel edits) are NOT in this plan's scope; commands always stage explicit paths.

---

## Task 1: RangeSeriesPane infrastructure + QuoteTotals migration

**Files:**
- Create: `frontend/src/chart/RangeSeriesPane.tsx`
- Create: `frontend/tests/component/RangeSeriesPane.test.tsx`
- Create: `frontend/src/chart/projectors/quoteTotals.ts`
- Create: `frontend/src/chart/projectors/quoteTotals.test.ts`
- Create: `frontend/src/chart/paneSpecs.ts`
- Modify: `frontend/src/chart/ChartStage.tsx` (import + JSX swap)
- Modify: `frontend/tests/component/ChartStage.test.tsx` (vi.mock target)
- Delete: `frontend/src/chart/QuoteTotalsPane.tsx`
- Delete: `frontend/tests/component/QuoteTotalsPane.test.tsx`

QuoteTotals migrates first because it is the simplest (two LineSeries on `bundle.quote_ratio.points`, no chart prefs, no per-point color logic) and was freshly verified in the prior session — any regression is easy to detect.

- [ ] **Step 1: Create `frontend/src/chart/RangeSeriesPane.tsx`**

```tsx
import { useEffect } from 'react';
import { type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';

/**
 * One series inside a `PaneSpec`. Carries the lightweight-charts
 * SeriesDefinition + options plus a pure `data` projector and an optional
 * `afterAdd` hook (e.g. `series.createPriceLine` for `RATIO_SPEC`'s
 * zero-baseline reference).
 */
export type SeriesSpec<Ctx = void> = {
  type: any;
  options: any;
  data: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => any[];
  afterAdd?: (series: ISeriesApi<any>) => void;
};

/**
 * Declarative description of one chart pane: its slot name (= `data-pane`
 * attr), its stretch factor for `setStretchFactor`, its series, and an
 * optional context-providing hook. `useContext` is called once per render
 * by `RangeSeriesPane`; its result is passed to every series' `data`
 * projector. Specs without per-render context omit `useContext`.
 *
 * Rules-of-hooks: callers MUST keep each PaneSpec as a module-level
 * constant. The conditional `useContext` call below is stable per
 * component instance because `spec` is referentially stable.
 */
export type PaneSpec<Ctx = void> = {
  name: string;
  stretch: number;
  series: SeriesSpec<Ctx>[];
  useContext?: () => Ctx;
};

type Props<Ctx> = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex: number;
  spec: PaneSpec<Ctx>;
};

/**
 * RangeSeriesPane — the deep module that owns chart-pane lifecycle for
 * any indicator derived from a RangeBundle. See CONTEXT.md
 * "RangeSeriesPane" for the architectural intent and
 * docs/superpowers/specs/2026-05-23-range-series-pane-design.md for the
 * full design.
 */
export default function RangeSeriesPane<Ctx>({
  chart,
  bundle,
  axis,
  paneIndex,
  spec,
}: Props<Ctx>) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const ctx = spec.useContext ? spec.useContext() : (undefined as Ctx);
  useEffect(() => {
    const seriesList: ISeriesApi<any>[] = spec.series.map((s) => {
      const series = chart.addSeries(s.type, s.options, paneIndex);
      s.afterAdd?.(series);
      series.setData(s.data(bundle, axis, ctx));
      return series;
    });
    return () => {
      // Guard: when a sibling pane throws and ChartErrorBoundary unmounts
      // ChartStage, the parent's chart.remove() may run before this
      // cleanup, leaving the series handle dangling. lightweight-charts
      // then throws "Value is undefined" inside removeSeries. Centralised
      // here so the five former pane components no longer each maintain
      // the same try/catch.
      for (const series of seriesList) {
        try {
          chart.removeSeries(series);
        } catch {
          // chart already torn down
        }
      }
    };
  }, [chart, bundle, axis, paneIndex, spec, ctx]);
  return null;
}
```

- [ ] **Step 2: Create the failing RangeSeriesPane integration tests**

Create `frontend/tests/component/RangeSeriesPane.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LineSeries } from 'lightweight-charts';
import RangeSeriesPane, { type PaneSpec } from '../../src/chart/RangeSeriesPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

const makeMockChart = () => {
  const seriesList: Array<{ setData: ReturnType<typeof vi.fn>; createPriceLine: ReturnType<typeof vi.fn> }> = [];
  return {
    chart: {
      addSeries: vi.fn(() => {
        const s = { setData: vi.fn(), createPriceLine: vi.fn() };
        seriesList.push(s);
        return s;
      }),
      removeSeries: vi.fn(),
    } as any,
    seriesList,
  };
};

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);
const baseBundle: any = { quote_ratio: { points: [{ t: sessionOpenMs, bid_total: 100, ask_total: 200 }] } };

describe('RangeSeriesPane', () => {
  it('mounts each series on the given paneIndex and feeds projector output to setData', () => {
    const { chart, seriesList } = makeMockChart();
    const spec: PaneSpec = {
      name: 'test-one',
      stretch: 0.4,
      series: [
        {
          type: LineSeries,
          options: { color: '#aaa' },
          data: (b, ax) => b.quote_ratio.points.map((p: any) => ({ time: ax.toVirtual(p.t) / 1000, value: p.bid_total })),
        },
      ],
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={3} spec={spec} />);
    expect(chart.addSeries).toHaveBeenCalledTimes(1);
    expect(chart.addSeries.mock.calls[0][2]).toBe(3);
    expect(seriesList[0].setData).toHaveBeenCalledWith([{ time: 0, value: 100 }]);
  });

  it('mounts multiple series in order on the same paneIndex', () => {
    const { chart, seriesList } = makeMockChart();
    const spec: PaneSpec = {
      name: 'test-two',
      stretch: 0.4,
      series: [
        { type: LineSeries, options: { color: '#a' }, data: () => [{ time: 0, value: 1 }] },
        { type: LineSeries, options: { color: '#b' }, data: () => [{ time: 0, value: 2 }] },
      ],
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={2} spec={spec} />);
    expect(chart.addSeries).toHaveBeenCalledTimes(2);
    expect(seriesList[0].setData).toHaveBeenCalledWith([{ time: 0, value: 1 }]);
    expect(seriesList[1].setData).toHaveBeenCalledWith([{ time: 0, value: 2 }]);
  });

  it('calls useContext, threads result into data(), and invokes afterAdd per series', () => {
    const { chart, seriesList } = makeMockChart();
    const useCtx = vi.fn(() => ({ flag: true }));
    const dataFn = vi.fn(() => [{ time: 0, value: 1 }]);
    const afterAdd = vi.fn();
    const spec: PaneSpec<{ flag: boolean }> = {
      name: 'test-ctx',
      stretch: 0.4,
      series: [{ type: LineSeries, options: {}, data: dataFn, afterAdd }],
      useContext: useCtx,
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={1} spec={spec} />);
    expect(useCtx).toHaveBeenCalled();
    expect(dataFn).toHaveBeenCalledWith(baseBundle, axis, { flag: true });
    expect(afterAdd).toHaveBeenCalledWith(seriesList[0]);
  });

  it('removes every series on unmount via try/catch-guarded removeSeries', () => {
    const { chart, seriesList } = makeMockChart();
    const spec: PaneSpec = {
      name: 'test-cleanup',
      stretch: 0.4,
      series: [
        { type: LineSeries, options: {}, data: () => [] },
        { type: LineSeries, options: {}, data: () => [] },
      ],
    };
    const { unmount } = render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={0} spec={spec} />);
    unmount();
    expect(chart.removeSeries).toHaveBeenCalledTimes(2);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[0]);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[1]);
  });
});
```

- [ ] **Step 3: Run RangeSeriesPane tests to verify they pass**

From `frontend/`:

```bash
pnpm exec vitest run tests/component/RangeSeriesPane.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 4: Create the failing QuoteTotals projector tests**

Create `frontend/src/chart/projectors/quoteTotals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { projectBid, projectAsk } from './quoteTotals';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectBid', () => {
  it('maps quote_ratio.points to {time, bid_total} in virtual seconds', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    expect(projectBid(bundle, axis)).toEqual([
      { time: 0, value: 100 },
      { time: 1, value: 150 },
    ]);
  });

  it('drops pre-open auction points via axis.contains', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 99, ask_total: 99 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
        ],
      },
    };
    expect(projectBid(bundle, axis)).toHaveLength(1);
    expect(projectBid(bundle, axis)[0].value).toBe(100);
  });
});

describe('projectAsk', () => {
  it('maps quote_ratio.points to {time, ask_total} in virtual seconds', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    expect(projectAsk(bundle, axis)).toEqual([
      { time: 0, value: 200 },
      { time: 1, value: 180 },
    ]);
  });
});
```

- [ ] **Step 5: Verify projector tests fail (module not found)**

```bash
pnpm exec vitest run src/chart/projectors/quoteTotals.test.ts
```

Expected: FAIL with module-not-found for `'./quoteTotals'`.

- [ ] **Step 6: Implement the QuoteTotals projector**

Create `frontend/src/chart/projectors/quoteTotals.ts`:

```ts
import { LineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  bid: ['--price-up', '#DC2626'],   // 매수 호가 총합 (KRX 빨강)
  ask: ['--price-down', '#2563EB'], // 매도 호가 총합 (KRX 파랑)
} as const;

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
  minMove: 1,
};

export function projectBid(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.bid_total }));
}

export function projectAsk(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.ask_total }));
}

const { bid, ask } = resolveTokens(TOKEN_SPEC);

export const QUOTE_TOTALS_SPEC: PaneSpec = {
  name: 'quote-totals',
  stretch: 0.4,
  series: [
    {
      type: LineSeries,
      options: { color: bid, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false },
      data: projectBid,
    },
    {
      type: LineSeries,
      options: { color: ask, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false },
      data: projectAsk,
    },
  ],
};
```

- [ ] **Step 7: Verify projector tests pass**

```bash
pnpm exec vitest run src/chart/projectors/quoteTotals.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Create the paneSpecs.ts registry (one entry for now)**

Create `frontend/src/chart/paneSpecs.ts`:

```ts
import type { PaneSpec } from './RangeSeriesPane';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';

/**
 * Master registry of `PaneSpec`s rendered by ChartStage in paneIndex
 * order. `setStretchFactor(spec.stretch)` is applied after mount.
 *
 * Index = paneIndex. Reordering this array reorders chart panes;
 * lightweight-charts v5 auto-clamps a requested `paneIndex` to the
 * next-available index, so the ordering invariant lives in this
 * array's position, not in JSX.
 *
 * Migration is in progress (spec docs/superpowers/specs/2026-05-23-range-series-pane-design.md):
 * panes flip from hand-mounted components to RangeSeriesPane+spec one
 * commit at a time. Until the migration completes, this registry is
 * partial.
 */
export const PANE_SPECS: PaneSpec<any>[] = [
  // pane 0 (candle) — still hand-mounted
  // pane 1 (volume) — still hand-mounted
  // pane 2 (ratio) — still hand-mounted
  QUOTE_TOTALS_SPEC, // index 0 here, but mounted at paneIndex=3 explicitly by ChartStage during migration
  // pane 4 (fill-strength) — still hand-mounted
];
```

(Note: the explicit `paneIndex=3` in ChartStage's `<RangeSeriesPane>` call decouples the registry's array index from the actual lightweight-charts paneIndex *only during migration*. Task 6 collapses everything when all five specs land.)

- [ ] **Step 9: Modify ChartStage.tsx — swap QuoteTotalsPane mount**

Read `frontend/src/chart/ChartStage.tsx` to confirm current state, then:

Replace this block:

```tsx
import QuoteTotalsPane from './QuoteTotalsPane';
```

with:

```tsx
import RangeSeriesPane from './RangeSeriesPane';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
```

And replace this JSX block:

```tsx
          <div data-pane="quote-totals" className="hidden">
            <QuoteTotalsPane chart={chart} bundle={bundle} axis={axis} paneIndex={3} />
          </div>
```

with:

```tsx
          <div data-pane="quote-totals" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={3} spec={QUOTE_TOTALS_SPEC} />
          </div>
```

- [ ] **Step 10: Modify ChartStage.test.tsx — flip the vi.mock target**

Read `frontend/tests/component/ChartStage.test.tsx` and find the line:

```ts
vi.mock('../../src/chart/QuoteTotalsPane', () => ({ default: () => null }));
```

Replace with:

```ts
vi.mock('../../src/chart/RangeSeriesPane', () => ({ default: () => null }));
```

The other four `vi.mock` lines for CandlePane / VolumePane / RatioPane / FillStrengthPane stay until their migration commits.

- [ ] **Step 11: Delete QuoteTotalsPane.tsx and its test**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git rm frontend/src/chart/QuoteTotalsPane.tsx frontend/tests/component/QuoteTotalsPane.test.tsx
```

- [ ] **Step 12: Type-check and run all frontend tests**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS (count rises by ~3 from new RangeSeriesPane + projector tests, drops by ~3 from deleted QuoteTotalsPane.test, net ~0).

- [ ] **Step 13: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add \
  frontend/src/chart/RangeSeriesPane.tsx \
  frontend/tests/component/RangeSeriesPane.test.tsx \
  frontend/src/chart/projectors/quoteTotals.ts \
  frontend/src/chart/projectors/quoteTotals.test.ts \
  frontend/src/chart/paneSpecs.ts \
  frontend/src/chart/ChartStage.tsx \
  frontend/tests/component/ChartStage.test.tsx
git commit -m "$(cat <<'EOF'
feat(chart/RangeSeriesPane): deep module + QuoteTotals migration

Introduces the unified chart-pane lifecycle owner: RangeSeriesPane
takes a PaneSpec describing series count, options, projector, and
optional useContext hook, and runs the shared boilerplate
(addSeries × N, axis-filter, axis.toVirtual mapping, setData,
try/catch removeSeries) in one place.

QuoteTotalsPane is migrated first as the simplest consumer: two
LineSeries on bundle.quote_ratio.points, no per-render context.
Projector functions projectBid / projectAsk live in
chart/projectors/quoteTotals.ts and are unit-tested as pure
functions without React render. The QuoteTotalsPane.tsx component
and its test file are deleted.

paneSpecs.ts master registry is created with the single
QUOTE_TOTALS_SPEC entry; other four panes follow in subsequent
commits per the spec. ChartStage still hand-mounts pane 0/1/2/4 —
they migrate one per commit.

Spec: docs/superpowers/specs/2026-05-23-range-series-pane-design.md
EOF
)"
```

---

## Task 2: Volume migration

**Files:**
- Create: `frontend/src/chart/projectors/volume.ts`
- Create: `frontend/src/chart/projectors/volume.test.ts`
- Modify: `frontend/src/chart/paneSpecs.ts` (add `VOLUME_SPEC`)
- Modify: `frontend/src/chart/ChartStage.tsx` (swap mount)
- Modify: `frontend/tests/component/ChartStage.test.tsx` (remove VolumePane mock)
- Delete: `frontend/src/chart/VolumePane.tsx`
- Delete: `frontend/tests/component/VolumePane.test.tsx`

Volume's projector iterates `bundle.candles[]` and assigns per-bucket color based on candle direction (`close >= open ? up : down`).

- [ ] **Step 1: Write failing projector tests**

Create `frontend/src/chart/projectors/volume.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { projectVolume } from './volume';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectVolume', () => {
  it('emits {time, value, color} per candle; up candles get up color, down candles get down color', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 50, vol_b: 30 }, // up
        { ts_ms: sessionOpenMs + 1000, open: 110, close: 105, high: 112, low: 100, vol_a: 20, vol_b: 10 }, // down
      ],
    };
    const data = projectVolume(bundle, axis);
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBe(80); // 50 + 30
    expect(data[1].value).toBe(30); // 20 + 10
    // up color used at index 0, down color at index 1 — exact hex depends on tokens
    expect(data[0].color).not.toBe(data[1].color);
  });

  it('drops candles outside the segment via axis.contains', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs - 60_000, open: 100, close: 100, high: 100, low: 100, vol_a: 5, vol_b: 0 }, // pre-open
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 50, vol_b: 30 },
      ],
    };
    const data = projectVolume(bundle, axis);
    expect(data).toHaveLength(1);
    expect(data[0].value).toBe(80);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec vitest run src/chart/projectors/volume.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the Volume projector**

Create `frontend/src/chart/projectors/volume.ts`:

```ts
import { HistogramSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
} as const;

const { up, down } = resolveTokens(TOKEN_SPEC);

export function projectVolume(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c) => ({
      time: (axis.toVirtual(c.ts_ms) / 1000) as any,
      value: c.vol_a + c.vol_b,
      color: c.close >= c.open ? up : down,
    }));
}

export const VOLUME_SPEC: PaneSpec = {
  name: 'volume',
  stretch: 0.3,
  series: [
    {
      type: HistogramSeries,
      options: {
        priceFormat: {
          type: 'custom' as const,
          formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
          minMove: 1,
        },
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
      },
      data: projectVolume,
    },
  ],
};
```

- [ ] **Step 4: Verify projector tests pass**

```bash
pnpm exec vitest run src/chart/projectors/volume.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Add VOLUME_SPEC to paneSpecs.ts**

Modify `frontend/src/chart/paneSpecs.ts` — add import and append to `PANE_SPECS` (the registry is partial until Task 6's finalization):

```ts
import type { PaneSpec } from './RangeSeriesPane';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { VOLUME_SPEC } from './projectors/volume';

export const PANE_SPECS: PaneSpec<any>[] = [
  // pane 0 (candle) — still hand-mounted
  VOLUME_SPEC,
  // pane 2 (ratio) — still hand-mounted
  QUOTE_TOTALS_SPEC,
  // pane 4 (fill-strength) — still hand-mounted
];
```

- [ ] **Step 6: Modify ChartStage.tsx — swap VolumePane mount**

Read `ChartStage.tsx`. Replace the line:

```tsx
import VolumePane from './VolumePane';
```

(if it still exists — verify with grep first; the import may have been removed in Task 1 if the migration consolidated to a single import). Add (or augment) the `VOLUME_SPEC` import:

```tsx
import { VOLUME_SPEC } from './projectors/volume';
```

Replace the JSX block:

```tsx
          <div data-pane="volume" className="hidden">
            <VolumePane chart={chart} bundle={bundle} axis={axis} paneIndex={1} />
          </div>
```

with:

```tsx
          <div data-pane="volume" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={1} spec={VOLUME_SPEC} />
          </div>
```

- [ ] **Step 7: Update ChartStage.test.tsx — drop VolumePane mock**

Read `frontend/tests/component/ChartStage.test.tsx`. Find and delete the line:

```ts
vi.mock('../../src/chart/VolumePane', () => ({ default: () => null }));
```

The RangeSeriesPane vi.mock from Task 1 already covers Volume.

- [ ] **Step 8: Delete VolumePane.tsx and its test**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git rm frontend/src/chart/VolumePane.tsx frontend/tests/component/VolumePane.test.tsx
```

- [ ] **Step 9: Type-check and run tests**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add \
  frontend/src/chart/projectors/volume.ts \
  frontend/src/chart/projectors/volume.test.ts \
  frontend/src/chart/paneSpecs.ts \
  frontend/src/chart/ChartStage.tsx \
  frontend/tests/component/ChartStage.test.tsx
git commit -m "$(cat <<'EOF'
refactor(chart/projectors): migrate VolumePane to RangeSeriesPane+VOLUME_SPEC

Pulls VolumePane's HistogramSeries lifecycle behind RangeSeriesPane.
projectVolume sums vol_a + vol_b per candle and assigns per-bucket
color (close >= open ? up : down) — the only non-trivial bit.
VOLUME_SPEC carries the priceScaleId='right' + integer-comma
priceFormat options unchanged.

Spec: docs/superpowers/specs/2026-05-23-range-series-pane-design.md
EOF
)"
```

---

## Task 3: FillStrength migration

**Files:**
- Create: `frontend/src/chart/projectors/fillStrength.ts`
- Create: `frontend/src/chart/projectors/fillStrength.test.ts`
- Modify: `frontend/src/chart/paneSpecs.ts` (add `FILL_STRENGTH_SPEC`)
- Modify: `frontend/src/chart/ChartStage.tsx` (swap mount)
- Modify: `frontend/tests/component/ChartStage.test.tsx` (remove FillStrengthPane mock)
- Delete: `frontend/src/chart/FillStrengthPane.tsx`
- Delete: `frontend/tests/component/FillStrengthPane.test.tsx`

FillStrength has two HistogramSeries — buy positive, sell negated. The fixed `inSession` filter is applied once and shared by both projectors via the projector implementations reading independently (acceptable: filter is O(N) and called twice; per spec the priority is interface simplicity, not micro-perf).

- [ ] **Step 1: Write failing projector tests**

Create `frontend/src/chart/projectors/fillStrength.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { projectBuy, projectSell } from './fillStrength';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectBuy', () => {
  it('maps fill_strength.points to {time, buy_qty} in virtual seconds', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
          { t: sessionOpenMs + 1000, buy_qty: 40, sell_qty: 60 },
        ],
      },
    };
    expect(projectBuy(bundle, axis)).toEqual([
      { time: 0, value: 50 },
      { time: 1, value: 40 },
    ]);
  });

  it('drops pre-open points via axis.contains', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, buy_qty: 1, sell_qty: 1 },
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
        ],
      },
    };
    expect(projectBuy(bundle, axis)).toHaveLength(1);
    expect(projectBuy(bundle, axis)[0].value).toBe(50);
  });
});

describe('projectSell', () => {
  it('emits NEGATED sell_qty so the series mirrors below the 0 baseline', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
          { t: sessionOpenMs + 1000, buy_qty: 40, sell_qty: 60 },
        ],
      },
    };
    expect(projectSell(bundle, axis)).toEqual([
      { time: 0, value: -30 },
      { time: 1, value: -60 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm exec vitest run src/chart/projectors/fillStrength.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the FillStrength projector**

Create `frontend/src/chart/projectors/fillStrength.ts`:

```ts
import { HistogramSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  buy: ['--price-up', '#DC2626'],   // 체결 매수 (KRX 빨강)
  sell: ['--price-down', '#2563EB'], // 체결 매도 (KRX 파랑)
} as const;

const histOpts = {
  base: 0,
  priceFormat: {
    type: 'custom' as const,
    formatter: (v: number) => Math.round(Math.abs(v)).toLocaleString('ko-KR'),
    minMove: 1,
  },
  priceLineVisible: false,
  lastValueVisible: false,
};

export function projectBuy(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.fill_strength.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: p.buy_qty }));
}

export function projectSell(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.fill_strength.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({ time: (axis.toVirtual(p.t) / 1000) as any, value: -p.sell_qty }));
}

const { buy, sell } = resolveTokens(TOKEN_SPEC);

export const FILL_STRENGTH_SPEC: PaneSpec = {
  name: 'fill-strength',
  stretch: 0.4,
  series: [
    { type: HistogramSeries, options: { color: buy, ...histOpts }, data: projectBuy },
    { type: HistogramSeries, options: { color: sell, ...histOpts }, data: projectSell },
  ],
};
```

- [ ] **Step 4: Verify projector tests pass**

```bash
pnpm exec vitest run src/chart/projectors/fillStrength.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add FILL_STRENGTH_SPEC to paneSpecs.ts**

Modify `frontend/src/chart/paneSpecs.ts`:

```ts
import type { PaneSpec } from './RangeSeriesPane';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { VOLUME_SPEC } from './projectors/volume';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';

export const PANE_SPECS: PaneSpec<any>[] = [
  // pane 0 (candle) — still hand-mounted
  VOLUME_SPEC,
  // pane 2 (ratio) — still hand-mounted
  QUOTE_TOTALS_SPEC,
  FILL_STRENGTH_SPEC,
];
```

- [ ] **Step 6: Modify ChartStage.tsx — swap FillStrengthPane mount**

Read `ChartStage.tsx`. Drop the `import FillStrengthPane from './FillStrengthPane';` line. Add `import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';`.

Replace the JSX block:

```tsx
          <div data-pane="fill-strength" className="hidden">
            <FillStrengthPane chart={chart} bundle={bundle} axis={axis} paneIndex={4} />
          </div>
```

with:

```tsx
          <div data-pane="fill-strength" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={4} spec={FILL_STRENGTH_SPEC} />
          </div>
```

- [ ] **Step 7: Update ChartStage.test.tsx — drop FillStrengthPane mock**

Find and delete the line:

```ts
vi.mock('../../src/chart/FillStrengthPane', () => ({ default: () => null }));
```

- [ ] **Step 8: Delete FillStrengthPane.tsx and its test**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git rm frontend/src/chart/FillStrengthPane.tsx frontend/tests/component/FillStrengthPane.test.tsx
```

- [ ] **Step 9: Type-check and run tests**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add \
  frontend/src/chart/projectors/fillStrength.ts \
  frontend/src/chart/projectors/fillStrength.test.ts \
  frontend/src/chart/paneSpecs.ts \
  frontend/src/chart/ChartStage.tsx \
  frontend/tests/component/ChartStage.test.tsx
git commit -m "$(cat <<'EOF'
refactor(chart/projectors): migrate FillStrengthPane to RangeSeriesPane

Two HistogramSeries (buy positive, sell negated for mirror render
below the 0 baseline) collapse into FILL_STRENGTH_SPEC with two
series entries. The histOpts (base:0, abs-value formatter,
suppressed price-line / last-value) move into the spec's series
options. No behavior change.

Spec: docs/superpowers/specs/2026-05-23-range-series-pane-design.md
EOF
)"
```

---

## Task 4: Candle migration

**Files:**
- Create: `frontend/src/chart/projectors/candle.ts`
- Create: `frontend/src/chart/projectors/candle.test.ts`
- Modify: `frontend/src/chart/paneSpecs.ts` (add `CANDLE_SPEC`)
- Modify: `frontend/src/chart/ChartStage.tsx` (swap mount)
- Modify: `frontend/tests/component/ChartStage.test.tsx` (remove CandlePane mock)
- Delete: `frontend/src/chart/CandlePane.tsx`
- Delete: `frontend/src/chart/CandlePane.test.tsx` (note: this test file lives in `src/chart/`, NOT `tests/component/` — unique among the panes)

CandlePane's tricky bit is the per-segment muted tint for the closing Auction Window (15:20-15:30 KST). The `VirtualAxis.inClosingAuctionWindow(realMs)` predicate (added in commit `7fff7fb`) owns that threshold.

- [ ] **Step 1: Write failing projector tests**

Create `frontend/src/chart/projectors/candle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { projectCandle } from './candle';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectCandle', () => {
  it('maps OHLC and assigns up color to up candles, down color to down candles', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: sessionOpenMs + 1000, open: 110, close: 105, high: 112, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };
    const data = projectCandle(bundle, axis);
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[0].open).toBe(100);
    expect(data[0].close).toBe(110);
    expect(data[0].high).toBe(115);
    expect(data[0].low).toBe(95);
    // up vs down differ
    expect(data[0].color).not.toBe(data[1].color);
    expect(data[0].borderColor).toBe(data[0].color);
    expect(data[0].wickColor).toBe(data[0].color);
  });

  it('applies muted color to candles inside the closing Auction Window (15:20-15:30 KST)', () => {
    // sessionOpenMs = 09:00 KST. 15:20 KST = sessionOpenMs + 6h20m = sessionOpenMs + 22_800_000.
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs + 60_000, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 115, high: 116, low: 109, vol_a: 0, vol_b: 0 },
      ],
    };
    const data = projectCandle(bundle, axis);
    expect(data[0].color).not.toBe(data[1].color); // first up colored, second muted
    // muted color is the same regardless of close>=open
    const sameSlot: any = {
      candles: [
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 105, high: 116, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };
    expect(projectCandle(sameSlot, axis)[0].color).toBe(data[1].color);
  });

  it('drops candles outside the segment via axis.contains', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs - 60_000, open: 100, close: 100, high: 100, low: 100, vol_a: 0, vol_b: 0 },
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
      ],
    };
    expect(projectCandle(bundle, axis)).toHaveLength(1);
    expect(projectCandle(bundle, axis)[0].open).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm exec vitest run src/chart/projectors/candle.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the Candle projector**

Create `frontend/src/chart/projectors/candle.ts`:

```ts
import { CandlestickSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  muted: ['--fg-dim', '#94A3B8'],
} as const;

const { up, down, muted } = resolveTokens(TOKEN_SPEC);

export function projectCandle(bundle: RangeBundle, axis: VirtualAxis): any[] {
  return bundle.candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c) => {
      const inClosingAuction = axis.inClosingAuctionWindow(c.ts_ms);
      const color = inClosingAuction ? muted : c.close >= c.open ? up : down;
      return {
        time: (axis.toVirtual(c.ts_ms) / 1000) as any,
        open: c.open,
        close: c.close,
        high: c.high,
        low: c.low,
        color,
        borderColor: color,
        wickColor: color,
      };
    });
}

export const CANDLE_SPEC: PaneSpec = {
  name: 'candle',
  stretch: 1.4,
  series: [
    {
      type: CandlestickSeries,
      options: {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: {
          type: 'custom' as const,
          formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
          minMove: 1,
        },
      },
      data: projectCandle,
    },
  ],
};
```

- [ ] **Step 4: Verify projector tests pass**

```bash
pnpm exec vitest run src/chart/projectors/candle.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add CANDLE_SPEC to paneSpecs.ts**

Modify `frontend/src/chart/paneSpecs.ts`:

```ts
import type { PaneSpec } from './RangeSeriesPane';
import { CANDLE_SPEC } from './projectors/candle';
import { VOLUME_SPEC } from './projectors/volume';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';

export const PANE_SPECS: PaneSpec<any>[] = [
  CANDLE_SPEC,
  VOLUME_SPEC,
  // pane 2 (ratio) — still hand-mounted
  QUOTE_TOTALS_SPEC,
  FILL_STRENGTH_SPEC,
];
```

- [ ] **Step 6: Modify ChartStage.tsx — swap CandlePane mount**

Drop the `import CandlePane from './CandlePane';` line. Add `import { CANDLE_SPEC } from './projectors/candle';`.

Replace the JSX block:

```tsx
          <div data-pane="candle" className="hidden">
            <CandlePane chart={chart} bundle={bundle} axis={axis} paneIndex={0} />
          </div>
```

with:

```tsx
          <div data-pane="candle" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} spec={CANDLE_SPEC} />
          </div>
```

- [ ] **Step 7: Update ChartStage.test.tsx — drop CandlePane mock**

Find and delete the line:

```ts
vi.mock('../../src/chart/CandlePane', () => ({ default: () => null }));
```

- [ ] **Step 8: Delete CandlePane.tsx and its test**

`CandlePane.test.tsx` is the one outlier that lives co-located in `src/chart/`:

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git rm frontend/src/chart/CandlePane.tsx frontend/src/chart/CandlePane.test.tsx
```

- [ ] **Step 9: Type-check and run tests**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add \
  frontend/src/chart/projectors/candle.ts \
  frontend/src/chart/projectors/candle.test.ts \
  frontend/src/chart/paneSpecs.ts \
  frontend/src/chart/ChartStage.tsx \
  frontend/tests/component/ChartStage.test.tsx
git commit -m "$(cat <<'EOF'
refactor(chart/projectors): migrate CandlePane to RangeSeriesPane

projectCandle owns the per-bucket OHLC mapping plus the muted-tint
rule for candles inside the closing Auction Window (15:20-15:30
KST per segment, threshold via axis.inClosingAuctionWindow).
CANDLE_SPEC carries the integer-comma priceFormat and the
borderVisible=false/priceLineVisible=false convention unchanged.

Spec: docs/superpowers/specs/2026-05-23-range-series-pane-design.md
EOF
)"
```

---

## Task 5: Ratio migration

**Files:**
- Create: `frontend/src/chart/projectors/ratio.ts`
- Create: `frontend/src/chart/projectors/ratio.test.ts`
- Modify: `frontend/src/chart/paneSpecs.ts` (add `RATIO_SPEC`)
- Modify: `frontend/src/chart/ChartStage.tsx` (swap mount)
- Modify: `frontend/tests/component/ChartStage.test.tsx` (remove RatioPane mock)
- Delete: `frontend/src/chart/RatioPane.tsx`
- Delete: `frontend/tests/component/RatioPane.test.tsx`

RatioPane is the only spec that uses `useContext` (for `auctionWindowMask` via `useChartPrefs`) and the only one that uses `afterAdd` (for `series.createPriceLine` at the 0 baseline). It also uses BaselineSeries with gradient options and a custom imbalance label formatter.

- [ ] **Step 1: Write failing projector tests**

Create `frontend/src/chart/projectors/ratio.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { projectRatio } from './ratio';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectRatio', () => {
  it('emits {time, value} using quoteImbalance from bid_total / ask_total', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 100 }, // balanced → 0
          { t: sessionOpenMs + 1000, bid_total: 100, ask_total: 200 }, // sell-heavy → +1.0
        ],
      },
    };
    const data = projectRatio(bundle, axis, false);
    expect(data[0].time).toBe(0);
    expect(data[0].value).toBe(0);
    expect(data[1].value).toBeCloseTo(1.0, 5);
  });

  it('drops pre-open auction points via axis.contains', () => {
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 100 },
        ],
      },
    };
    expect(projectRatio(bundle, axis, false)).toHaveLength(1);
  });

  it('masks closing-auction-window values to 0 when auctionWindowMask=true', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000; // 15:20 KST
    const bundle: any = {
      quote_ratio: {
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },              // outside → imbalance kept
          { t: auctionStartMs + 60_000, bid_total: 100, ask_total: 1000 },   // inside auction window
        ],
      },
    };
    const unmasked = projectRatio(bundle, axis, false);
    const masked = projectRatio(bundle, axis, true);
    // Outside the window, masked and unmasked agree
    expect(masked[0].value).toBe(unmasked[0].value);
    // Inside the window, masked is forced to 0
    expect(masked[1].value).toBe(0);
    expect(unmasked[1].value).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
pnpm exec vitest run src/chart/projectors/ratio.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the Ratio projector**

Create `frontend/src/chart/projectors/ratio.ts`:

```ts
import { BaselineSeries } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { quoteImbalance } from '../../util/imbalance';
import { resolveTokens } from '../../util/tokens';
import { useChartPrefs } from '../ChartPrefsContext';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  ratioBid: ['--price-up', '#DC2626'],
  ratioAsk: ['--price-down', '#2563EB'],
  baseline: ['--fg-dimmer', '#64748B'],
} as const;

function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function projectRatio(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): any[] {
  return bundle.quote_ratio.points
    .filter((p) => axis.contains(p.t))
    .map((p) => ({
      time: (axis.toVirtual(p.t) / 1000) as any,
      value:
        auctionWindowMask && axis.inClosingAuctionWindow(p.t)
          ? 0
          : quoteImbalance(p.bid_total, p.ask_total),
    }));
}

const { ratioBid, ratioAsk, baseline } = resolveTokens(TOKEN_SPEC);

const useRatioContext = (): boolean => useChartPrefs().auctionWindowMask;

export const RATIO_SPEC: PaneSpec<boolean> = {
  name: 'ratio',
  stretch: 0.4,
  useContext: useRatioContext,
  series: [
    {
      type: BaselineSeries,
      options: {
        baseValue: { type: 'price', price: 0 },
        relativeGradient: true,
        topLineColor: ratioAsk,
        topFillColor1: rgba(ratioAsk, 0.55),
        topFillColor2: rgba(ratioAsk, 0.1),
        bottomLineColor: ratioBid,
        bottomFillColor1: rgba(ratioBid, 0.1),
        bottomFillColor2: rgba(ratioBid, 0.55),
        lineWidth: 3,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: {
          type: 'custom',
          formatter: (v: number) => {
            if (Math.abs(v) < 0.005) return '0';
            const r = (1 + Math.abs(v)).toFixed(1);
            return v >= 0 ? `${r}× S` : `${r}× B`;
          },
          minMove: 0.01,
        },
      },
      data: projectRatio,
      afterAdd: (series) => {
        series.createPriceLine({
          price: 0,
          color: baseline,
          lineWidth: 1,
          lineStyle: 1,
          axisLabelVisible: false,
          title: '',
        } as any);
      },
    },
  ],
};
```

- [ ] **Step 4: Verify projector tests pass**

```bash
pnpm exec vitest run src/chart/projectors/ratio.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add RATIO_SPEC to paneSpecs.ts**

Modify `frontend/src/chart/paneSpecs.ts`:

```ts
import type { PaneSpec } from './RangeSeriesPane';
import { CANDLE_SPEC } from './projectors/candle';
import { VOLUME_SPEC } from './projectors/volume';
import { RATIO_SPEC } from './projectors/ratio';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';

/**
 * Master registry of `PaneSpec`s rendered by ChartStage in paneIndex
 * order. `setStretchFactor(spec.stretch)` is applied after mount.
 *
 * Index = paneIndex. Reordering this array reorders chart panes;
 * lightweight-charts v5 auto-clamps a requested `paneIndex` to the
 * next-available index, so the ordering invariant lives in this
 * array's position, not in JSX.
 */
export const PANE_SPECS: PaneSpec<any>[] = [
  CANDLE_SPEC,         // paneIndex 0
  VOLUME_SPEC,         // paneIndex 1
  RATIO_SPEC,          // paneIndex 2
  QUOTE_TOTALS_SPEC,   // paneIndex 3
  FILL_STRENGTH_SPEC,  // paneIndex 4
];

export const PANE_STRETCH = PANE_SPECS.map((s) => s.stretch);
```

The transitional comments are gone — the registry is complete.

- [ ] **Step 6: Modify ChartStage.tsx — swap RatioPane mount**

Drop the `import RatioPane from './RatioPane';` line. Add `import { RATIO_SPEC } from './projectors/ratio';`.

Replace the JSX block:

```tsx
          <div data-pane="ratio" className="hidden">
            <RatioPane chart={chart} bundle={bundle} axis={axis} paneIndex={2} />
          </div>
```

with:

```tsx
          <div data-pane="ratio" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={2} spec={RATIO_SPEC} />
          </div>
```

- [ ] **Step 7: Update ChartStage.test.tsx — drop RatioPane mock**

Find and delete the line:

```ts
vi.mock('../../src/chart/RatioPane', () => ({ default: () => null }));
```

- [ ] **Step 8: Delete RatioPane.tsx and its test**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git rm frontend/src/chart/RatioPane.tsx frontend/tests/component/RatioPane.test.tsx
```

- [ ] **Step 9: Type-check and run tests**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add \
  frontend/src/chart/projectors/ratio.ts \
  frontend/src/chart/projectors/ratio.test.ts \
  frontend/src/chart/paneSpecs.ts \
  frontend/src/chart/ChartStage.tsx \
  frontend/tests/component/ChartStage.test.tsx
git commit -m "$(cat <<'EOF'
refactor(chart/projectors): migrate RatioPane to RangeSeriesPane

The most spec-stressing migration: BaselineSeries with relativeGradient,
the imbalance "Nx S" / "Nx B" priceFormat, the useChartPrefs subscription
for auctionWindowMask, and the 0-baseline createPriceLine all fit inside
RATIO_SPEC without growing PaneSpec beyond its agreed five slots:

- useContext: useRatioContext returns auctionWindowMask boolean
- series[0].data takes the boolean as ctx for the mask check
- series[0].afterAdd hosts createPriceLine(0)

Closes the five-pane migration; paneSpecs.ts is now complete with all
five specs in paneIndex order. ChartStage's hand-mounted blocks are
collapsed into a PANE_SPECS.map loop in the next commit.

Spec: docs/superpowers/specs/2026-05-23-range-series-pane-design.md
EOF
)"
```

---

## Task 6: ChartStage finalization

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx` (collapse five JSX blocks into PANE_SPECS.map; replace PANE_STRETCH literal)

By the start of Task 6 every pane wrapper in ChartStage's JSX reads `<div data-pane="..."><RangeSeriesPane spec={SPEC} paneIndex={N} /></div>`. The five blocks differ only in `data-pane` value, `paneIndex`, and `spec`. Task 6 collapses them into one map over `PANE_SPECS`.

- [ ] **Step 1: Read ChartStage.tsx and find the five wrapper blocks**

Inside the `chart && bundle &&` JSX, there are five `<div data-pane="..." className="hidden">` blocks. They sit between the chart container `<div ref={containerRef} ... />` and the `<div data-pane="volume-profile">` block (VolumeProfileOverlay stays unchanged).

- [ ] **Step 2: Replace the five hand-mounted blocks with a single PANE_SPECS.map**

Replace this region in `ChartStage.tsx` (5 wrapper blocks + the inline render-order comment in between them):

```tsx
          <div data-pane="candle" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} spec={CANDLE_SPEC} />
          </div>
          <div data-pane="volume" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={1} spec={VOLUME_SPEC} />
          </div>
          <div data-pane="ratio" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={2} spec={RATIO_SPEC} />
          </div>
          {/*
            Render order must match paneIndex order. lightweight-charts v5
            does not auto-create intermediate panes ...
          */}
          <div data-pane="quote-totals" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={3} spec={QUOTE_TOTALS_SPEC} />
          </div>
          <div data-pane="fill-strength" className="hidden">
            <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={4} spec={FILL_STRENGTH_SPEC} />
          </div>
```

with:

```tsx
          {/*
            Render order matches PANE_SPECS array index. The array's
            position carries the pane-index invariant: lightweight-charts
            v5 does not auto-create intermediate panes — a requested
            `paneIndex=N` while only K<N panes exist clamps to K. Mapping
            in order ensures every spec.paneIndex matches its array
            position so the clamp never fires.
          */}
          {PANE_SPECS.map((spec, paneIndex) => (
            <div key={spec.name} data-pane={spec.name} className="hidden">
              <RangeSeriesPane
                chart={chart}
                bundle={bundle}
                axis={axis}
                paneIndex={paneIndex}
                spec={spec}
              />
            </div>
          ))}
```

- [ ] **Step 3: Drop the five individual spec imports; keep the registry import**

Replace the per-spec import group:

```tsx
import { CANDLE_SPEC } from './projectors/candle';
import { VOLUME_SPEC } from './projectors/volume';
import { RATIO_SPEC } from './projectors/ratio';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';
```

with:

```tsx
import { PANE_SPECS, PANE_STRETCH } from './paneSpecs';
```

(`RangeSeriesPane` import stays. The previous `PANE_STRETCH` constant declaration below — if any — is also removed; the imported one replaces it.)

- [ ] **Step 4: Remove the local PANE_STRETCH constant if it still exists**

Search ChartStage.tsx for `const PANE_STRETCH`. If a local declaration remains:

```tsx
const PANE_STRETCH = [1.4, 0.3, 0.4, 0.4, 0.4] as const;
```

delete it. The imported `PANE_STRETCH` from `./paneSpecs` is now the source of truth.

If `PANE_STRETCH` has a multi-line jsdoc header above it, remove that too. The pane-list narrative now lives in the jsdoc at the top of `paneSpecs.ts`.

- [ ] **Step 5: Trim ChartStage.tsx's top-of-file jsdoc**

The original jsdoc block listed all five panes with stretch values. Now that the list lives in `paneSpecs.ts`, shorten the jsdoc bullet list to a one-line pointer.

Replace the bullet-list block:

```ts
 *   - Pane 0: Candle (1.4) + VolumeProfileOverlay
 *   - Pane 1: Volume (0.3)
 *   - Pane 2: Ratio (0.4)
 *   - Pane 3: Quote Totals (0.4) — bid/ask 1–10호가 total LineSeries
 *   - Pane 4: FillStrength (0.4)
```

with:

```ts
 *   See `paneSpecs.ts` for the canonical pane registry. ChartStage
 *   reads PANE_SPECS in order and mounts one `<RangeSeriesPane spec=...>`
 *   per entry. VolumeProfileOverlay (pane 0 canvas overlay) and
 *   DayBoundaryOverlay (chart-wide) remain hand-mounted alongside.
```

- [ ] **Step 6: Type-check and run tests**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3/frontend
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 7: Manual dogfood**

Start the dev server (`pnpm dev`) and open `http://localhost:5173/replay`. Load `003490`, range `2026-05-19` → `2026-05-20`, timeframe `1m`.

Verify each pane renders identically to before the refactor:
1. **Candle** (top): candles with day-boundary line at 5/20; closing-auction candles muted from 15:20 KST.
2. **Volume**: histogram with per-bucket up/down color.
3. **Ratio**: BaselineSeries with gradient; "Nx S" / "Nx B" labels; 0 baseline drawn as a thin line.
4. **Quote Totals**: bid (red) and ask (blue) lines with thousands-separator labels.
5. **FillStrength**: buy-positive / sell-negated histograms mirrored around 0.

No console errors. Right price-scale labels match the pre-refactor screenshot.

- [ ] **Step 8: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
git add frontend/src/chart/ChartStage.tsx
git commit -m "$(cat <<'EOF'
refactor(chart/ChartStage): collapse five hand-mounted panes into PANE_SPECS.map

With the five pane components migrated to RangeSeriesPane+PaneSpec,
ChartStage's render block collapses from five repeated wrapper
blocks into a single map over the PANE_SPECS registry. The
ordering invariant (lightweight-charts v5's auto-clamp behaviour
on intermediate paneIndexes) now lives in the array index of
paneSpecs.ts rather than in JSX position — adding or reordering
panes is a single-array edit.

PANE_STRETCH is imported from paneSpecs.ts as
`PANE_SPECS.map(s => s.stretch)` so the stretch values stay
synchronized with the registry by construction.

ChartStage's top-of-file jsdoc shrinks from the per-pane bullet
list to a one-line pointer at the registry. The narrative for
which pane is which lives in paneSpecs.ts.

Spec: docs/superpowers/specs/2026-05-23-range-series-pane-design.md
EOF
)"
```

---

## Verification checklist

After Task 6's commit, before declaring done:

1. `pnpm exec tsc -b` exits 0.
2. `pnpm exec vitest run` — all tests PASS. Expected count change: 5 old pane `*.test.tsx` files removed, 5 new `projectors/*.test.ts` added, 1 `RangeSeriesPane.test.tsx` added. Net test count change is small (~+5).
3. Backend tests still pass (`uv run pytest tests/` — backend unaffected; sanity-check anyway).
4. `git grep -E "CandlePane|VolumePane|RatioPane|QuoteTotalsPane|FillStrengthPane" -- frontend/`
   returns ZERO hits in code (`docs/` mentions allowed).
5. `git grep -nE "import .* from .*chart/(Candle|Volume|Ratio|QuoteTotals|FillStrength)Pane" -- frontend/`
   returns ZERO hits.
6. `/replay` for `003490` between 2026-05-19 and 2026-05-20 at 1 m renders five visually identical panes to pre-refactor. Spot-check the muted-tint behaviour at 15:20 KST and the FillStrength mirror.
7. The `data-pane="..."` selectors used by `frontend/tests/e2e/replay-smoke.spec.ts` (candle / volume / ratio / quote-totals / fill-strength) are unchanged because each `PaneSpec.name` matches the prior `data-pane` attribute verbatim.
8. CONTEXT.md `RangeSeriesPane` glossary entry stays accurate.
