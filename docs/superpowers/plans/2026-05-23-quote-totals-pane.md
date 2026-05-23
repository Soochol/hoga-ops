# Quote Totals Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the IntensityPane heatmap with QuoteTotalsPane — two LineSeries showing 매수 1–10호가 / 매도 1–10호가 quantity totals — and delete the depth_intensity pipeline end-to-end (backend feeder, wire field, frontend type, component, all 13 references).

**Architecture:** New `QuoteTotalsPane.tsx` mirrors RatioPane's shape: a single `useEffect`, no JSX, two `LineSeries` on the same `paneIndex` so they share an auto-scaled price axis. It reads from `bundle.quote_ratio.points[*].{bid_total, ask_total}` — the same wire field RatioPane derives 호가비 from. ChartStage swaps the mount and shrinks pane-3 stretch from 0.8 to 0.4 (`PANE_STRETCH = [1.4, 0.3, 0.4, 0.4, 0.4]`). All depth_intensity code, types, fixtures, and tests are deleted in the same change-set per ADR-0016.

**Tech Stack:** TypeScript + React 18, vitest + @testing-library/react, Tailwind v4, lightweight-charts v5.2.0, Python 3 + FastAPI + pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-05-23-quote-totals-pane-design.md`
**ADR:** `docs/adr/0016-retire-depth-intensity-for-quote-totals.md`

## Pre-conditions

The working tree carries two uncommitted prior-session fixes — pane reorder in `ChartStage.tsx` and `paneEl` dep + `z-10` class in `IntensityPane.tsx`. They are not part of this plan but are touched by Task 2 and erased by Task 3. The ChartStage.tsx reorder (IntensityPane before FillStrengthPane in JSX) is the foundation Task 2's mount-swap preserves; do not revert it.

Before starting Task 1, run `git status` and confirm: modified `frontend/src/chart/ChartStage.tsx`, modified `frontend/src/chart/IntensityPane.tsx`. If those are clean, the prior fixes were already committed — proceed unchanged.

---

## Task 1: Add QuoteTotalsPane component (TDD)

**Files:**
- Create: `frontend/src/chart/QuoteTotalsPane.tsx`
- Test: `frontend/tests/component/QuoteTotalsPane.test.tsx`

The component mirrors `frontend/src/chart/RatioPane.tsx`'s shape (single `useEffect`, no JSX, no anchor series). The test mirrors `frontend/tests/component/RatioPane.test.tsx`'s `makeMockChart` pattern but extends it to track *two* series instead of one. The component is not mounted in `ChartStage.tsx` yet — that swap happens in Task 2. Tests run in isolation against the mock chart, so adding the component first keeps the tree green.

- [ ] **Step 1: Write the failing test suite**

Create `frontend/tests/component/QuoteTotalsPane.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import QuoteTotalsPane from '../../src/chart/QuoteTotalsPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

const makeMockChart = () => {
  const seriesList: Array<{ setData: ReturnType<typeof vi.fn> }> = [];
  return {
    chart: {
      addSeries: vi.fn(() => {
        const s = { setData: vi.fn() };
        seriesList.push(s);
        return s;
      }),
      removeSeries: vi.fn(),
    } as any,
    seriesList,
  };
};

describe('QuoteTotalsPane', () => {
  it('adds two LineSeries on the same paneIndex and maps bid/ask totals', () => {
    const { chart, seriesList } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    render(
      <QuoteTotalsPane
        chart={chart}
        bundle={bundle}
        paneIndex={3}
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
          },
        ])}
      />,
    );
    expect(chart.addSeries).toHaveBeenCalledTimes(2);
    expect(chart.addSeries.mock.calls[0][2]).toBe(3);
    expect(chart.addSeries.mock.calls[1][2]).toBe(3);
    const bidData = seriesList[0].setData.mock.calls[0][0];
    const askData = seriesList[1].setData.mock.calls[0][0];
    expect(bidData.map((d: any) => d.value)).toEqual([100, 150]);
    expect(askData.map((d: any) => d.value)).toEqual([200, 180]);
    // Time is mapped to virtual seconds; first point at virtualMs=0 → 0
    expect(bidData[0].time).toBe(0);
    expect(askData[0].time).toBe(0);
    expect(bidData[1].time).toBe(1);
  });

  it('drops pre-open auction quote_ratio points via axis.contains', () => {
    const { chart, seriesList } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 99, ask_total: 99 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    render(
      <QuoteTotalsPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
          },
        ])}
      />,
    );
    const bidData = seriesList[0].setData.mock.calls[0][0];
    const askData = seriesList[1].setData.mock.calls[0][0];
    expect(bidData).toHaveLength(2);
    expect(askData).toHaveLength(2);
    expect(bidData[0].value).toBe(100);
    expect(askData[0].value).toBe(200);
  });

  it('removes both series on unmount', () => {
    const { chart, seriesList } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [{ t: sessionOpenMs, bid_total: 100, ask_total: 200 }],
      },
    };
    const { unmount } = render(
      <QuoteTotalsPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
          },
        ])}
      />,
    );
    unmount();
    expect(chart.removeSeries).toHaveBeenCalledTimes(2);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[0]);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[1]);
  });
});
```

- [ ] **Step 2: Run the test suite and confirm it fails**

Run from `frontend/`:

```bash
pnpm exec vitest run tests/component/QuoteTotalsPane.test.tsx
```

Expected: FAIL with module-not-found for `'../../src/chart/QuoteTotalsPane'`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/chart/QuoteTotalsPane.tsx`:

```tsx
import { useEffect } from 'react';
import { LineSeries, type IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = {
  up: ['--up', '#22C55E'],
  down: ['--down', '#F43F5E'],
} as const;

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  /** Pane index for multi-pane split. Defaults to 0. */
  paneIndex?: number;
};

/**
 * QuoteTotalsPane — paints the 매수 1–10호가 / 매도 1–10호가 quantity
 * totals as two LineSeries on the shared chart. Reads from
 * bundle.quote_ratio.points (the same wire field RatioPane derives 호가비
 * from); the field's name reflects the derived view but carries the raw
 * totals too — see CONTEXT.md "Quote Totals".
 */
export default function QuoteTotalsPane({
  chart,
  bundle,
  axis,
  paneIndex = 0,
}: Props) {
  useEffect(() => {
    const { up, down } = resolveTokens(TOKEN_SPEC);
    const priceFormat = {
      type: 'custom' as const,
      formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
      minMove: 1,
    };
    const bidSeries = chart.addSeries(
      LineSeries,
      { color: up, lineWidth: 1, priceFormat } as any,
      paneIndex,
    );
    const askSeries = chart.addSeries(
      LineSeries,
      { color: down, lineWidth: 1, priceFormat } as any,
      paneIndex,
    );
    const inSession = bundle.quote_ratio.points.filter((p) => axis.contains(p.t));
    bidSeries.setData(
      inSession.map((p) => ({
        time: (axis.toVirtual(p.t) / 1000) as any,
        value: p.bid_total,
      })),
    );
    askSeries.setData(
      inSession.map((p) => ({
        time: (axis.toVirtual(p.t) / 1000) as any,
        value: p.ask_total,
      })),
    );
    return () => {
      try {
        chart.removeSeries(bidSeries);
      } catch {
        // chart already torn down
      }
      try {
        chart.removeSeries(askSeries);
      } catch {
        // chart already torn down
      }
    };
  }, [chart, bundle, axis, paneIndex]);
  return null;
}
```

- [ ] **Step 4: Run the test suite and confirm it passes**

```bash
pnpm exec vitest run tests/component/QuoteTotalsPane.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Type-check**

```bash
pnpm exec tsc -b
```

Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/QuoteTotalsPane.tsx frontend/tests/component/QuoteTotalsPane.test.tsx
git commit -m "$(cat <<'EOF'
feat(chart/QuoteTotalsPane): two-line bid/ask total qty pane

New component for the Replay Viewer's pane 3. Renders bid_total (green)
and ask_total (red) LineSeries from bundle.quote_ratio.points — the same
wire field RatioPane derives 호가비 from. Both series on the same
paneIndex share an auto-scaled price axis so the cursor reads both
values at once.

Not yet mounted; ChartStage wiring follows in the next commit.
EOF
)"
```

---

## Task 2: Wire QuoteTotalsPane into ChartStage; drop pane-3 stretch to 0.4

**Files:**
- Modify: `frontend/src/chart/ChartStage.tsx` (lines ~47-77 jsdoc + PANE_STRETCH; lines ~287-310 mount block)
- Modify: `frontend/tests/component/ChartStage.test.tsx` (line 54 vi.mock)

The pane-reorder fix from the prior session (IntensityPane `data-pane="intensity"` rendered before `data-pane="fill-strength"` in JSX) stays in place — Task 2 just renames the slot's contents and shrinks the stretch factor. `IntensityPane.tsx` still exists at this point; Task 3 deletes it. The pre-existing `vi.mock('../../src/chart/IntensityPane', …)` in `ChartStage.test.tsx` needs to switch to the new module path; the test fixture's `depth_intensity_by_day: []` is left untouched here and stripped in Task 4.

- [ ] **Step 1: Update the file-level jsdoc bullet list**

In `frontend/src/chart/ChartStage.tsx`, find the jsdoc block before `export default function ChartStage`. Replace the bullet list and the IntensityPane paragraph.

OLD (lines ~47-71):

```ts
/**
 * ChartStage — owns the single `lightweight-charts` instance for the replay
 * viewer and mounts the 5 pane children (candles / volume / ratio / intensity
 * / fill-strength) plus the VolumeProfileOverlay once the chart is ready and
 * a `RangeBundle` is available.
 *
 * Multi-pane split: each pane component receives a `paneIndex` so its series
 * register on a distinct lightweight-charts pane. Pane heights are set via
 * `IPaneApi.setStretchFactor` after mount with the ratios from DESIGN.md /
 * spec §6.3:
 *   - Pane 0: Candle (1.4) + VolumeProfileOverlay
 *   - Pane 1: Volume (0.3)
 *   - Pane 2: Ratio (0.4)
 *   - Pane 3: Intensity overlay (0.8)
 *   - Pane 4: FillStrength (0.4)
 *
 * IntensityPane has no series of its own (canvas heatmap), so we mount an
 * invisible histogram on pane 3 to force the pane to exist, then portal the
 * canvas into that pane's DOM element via `getHTMLElement()`. The `data-pane`
 * wrappers remain for E2E selectors.
 *
 * Viewport publisher: subscribes to the chart's visible-range and writes
 * (fromMs, toMs) into `useViewportStore` so sibling components like
 * PriceStrip can read viewport state without prop-drilling (Task 6.5).
 */
```

NEW:

```ts
/**
 * ChartStage — owns the single `lightweight-charts` instance for the replay
 * viewer and mounts the 5 pane children (candles / volume / ratio /
 * quote-totals / fill-strength) plus the VolumeProfileOverlay once the
 * chart is ready and a `RangeBundle` is available.
 *
 * Multi-pane split: each pane component receives a `paneIndex` so its series
 * register on a distinct lightweight-charts pane. Pane heights are set via
 * `IPaneApi.setStretchFactor` after mount with the ratios from DESIGN.md /
 * spec §6.3:
 *   - Pane 0: Candle (1.4) + VolumeProfileOverlay
 *   - Pane 1: Volume (0.3)
 *   - Pane 2: Ratio (0.4)
 *   - Pane 3: Quote Totals (0.4) — bid/ask 1–10호가 total LineSeries
 *   - Pane 4: FillStrength (0.4)
 *
 * Viewport publisher: subscribes to the chart's visible-range and writes
 * (fromMs, toMs) into `useViewportStore` so sibling components like
 * PriceStrip can read viewport state without prop-drilling (Task 6.5).
 */
```

- [ ] **Step 2: Update PANE_STRETCH and its comment**

In the same file, find the `PANE_STRETCH` declaration (a few lines below the jsdoc).

OLD:

```ts
/**
 * Pane stretch factors (DESIGN.md / spec §6.3). Indexes:
 *   0 = candle, 1 = volume, 2 = ratio, 3 = intensity, 4 = fill-strength.
 * Total = 3.3; lightweight-charts treats these as proportional weights.
 */
const PANE_STRETCH = [1.4, 0.3, 0.4, 0.8, 0.4] as const;
```

NEW:

```ts
/**
 * Pane stretch factors (DESIGN.md / spec §6.3). Indexes:
 *   0 = candle, 1 = volume, 2 = ratio, 3 = quote-totals, 4 = fill-strength.
 * Total = 2.9; lightweight-charts treats these as proportional weights.
 * Candle share rises ~42% → ~48% vs the prior heatmap layout — intentional;
 * two lines do not need the vertical budget the heatmap consumed.
 */
const PANE_STRETCH = [1.4, 0.3, 0.4, 0.4, 0.4] as const;
```

- [ ] **Step 3: Swap the import**

Near the top of `ChartStage.tsx`, replace the IntensityPane import.

OLD:

```ts
import IntensityPane from './IntensityPane';
```

NEW:

```ts
import QuoteTotalsPane from './QuoteTotalsPane';
```

- [ ] **Step 4: Swap the mount block and rewrite the ordering comment**

Find the block inside the JSX between `<RatioPane …/>` and `<FillStrengthPane …/>`.

OLD:

```tsx
          {/*
            Render order must match paneIndex order. lightweight-charts v5 does
            not auto-create intermediate panes: `addSeries(..., paneIndex=4)`
            while only panes 0-2 exist lands the first series on pane 3 (next
            available index), not pane 4. Mounting FillStrengthPane before
            IntensityPane therefore splits its buy/sell histograms across pane
            3 (Intensity slot) and pane 4. IntensityPane's anchor LineSeries
            must claim pane 3 first so FillStrengthPane's pair both land on 4.

            Canvas overlay panes (intensity, volume-profile) are portaled into
            their target pane's DOM via `chart.panes()[paneIndex].getHTMLElement()`.
            The wrappers here are kept for E2E selectors but no longer host the
            canvases themselves.
          */}
          <div data-pane="intensity" className="hidden">
            <IntensityPane chart={chart} bundle={bundle} axis={axis} paneIndex={3} />
          </div>
          <div data-pane="fill-strength" className="hidden">
            <FillStrengthPane chart={chart} bundle={bundle} axis={axis} paneIndex={4} />
          </div>
```

NEW:

```tsx
          {/*
            Render order must match paneIndex order. lightweight-charts v5
            does not auto-create intermediate panes: `addSeries(...,
            paneIndex=4)` while only panes 0-2 exist lands the first series
            on pane 3 (next available index), not pane 4. Mounting
            FillStrengthPane before QuoteTotalsPane therefore splits its
            buy/sell histograms across pane 3 (Quote Totals slot) and pane 4.
            QuoteTotalsPane's two LineSeries claim pane 3 first so
            FillStrengthPane's pair both land on 4.

            VolumeProfileOverlay below is still a canvas-overlay pane portaled
            into its target pane's DOM via `chart.panes()[0].getHTMLElement()`;
            the `data-pane` wrapper is kept for E2E selectors but no longer
            hosts the canvas itself.
          */}
          <div data-pane="quote-totals" className="hidden">
            <QuoteTotalsPane chart={chart} bundle={bundle} axis={axis} paneIndex={3} />
          </div>
          <div data-pane="fill-strength" className="hidden">
            <FillStrengthPane chart={chart} bundle={bundle} axis={axis} paneIndex={4} />
          </div>
```

- [ ] **Step 5: Swap the ChartStage test mock**

In `frontend/tests/component/ChartStage.test.tsx`, find line 54:

OLD:

```ts
vi.mock('../../src/chart/IntensityPane', () => ({ default: () => null }));
```

NEW:

```ts
vi.mock('../../src/chart/QuoteTotalsPane', () => ({ default: () => null }));
```

- [ ] **Step 6: Run tests and type-check**

From `frontend/`:

```bash
pnpm exec tsc -b
pnpm exec vitest run tests/component/ChartStage.test.tsx tests/component/QuoteTotalsPane.test.tsx
```

Expected: tsc exit 0; both test files PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/chart/ChartStage.tsx frontend/tests/component/ChartStage.test.tsx
git commit -m "$(cat <<'EOF'
refactor(chart/ChartStage): mount QuoteTotalsPane in pane 3; stretch → 0.4

Replaces the IntensityPane mount with QuoteTotalsPane and updates
PANE_STRETCH from [1.4, 0.3, 0.4, 0.8, 0.4] to [1.4, 0.3, 0.4, 0.4, 0.4]
(total 3.3 → 2.9; candle share ~42% → ~48% as a side effect of
collapsing the heatmap's space allocation). The pane-3-before-pane-4
JSX ordering established by the prior crosshair-fix session remains —
QuoteTotalsPane inherits the same slot constraint. IntensityPane.tsx
itself is removed in the next commit.
EOF
)"
```

---

## Task 3: Delete IntensityPane component and its test

**Files:**
- Delete: `frontend/src/chart/IntensityPane.tsx`
- Delete: `frontend/tests/component/IntensityPane.test.tsx`

By this point ChartStage no longer references IntensityPane, so the file becomes orphan. The `DepthIntensity` type and the `depth_intensity_by_day` field still exist in `frontend/src/api/types.ts` and the backend — they're cleaned up in Tasks 4-7.

- [ ] **Step 1: Verify no remaining frontend reference to IntensityPane**

```bash
git grep -n "IntensityPane" -- frontend/
```

Expected output: zero lines (the only previous matches were `ChartStage.tsx` and `ChartStage.test.tsx`, both updated in Task 2).

- [ ] **Step 2: Delete the files**

```bash
git rm frontend/src/chart/IntensityPane.tsx frontend/tests/component/IntensityPane.test.tsx
```

- [ ] **Step 3: Run type-check + the rest of the chart test suite**

```bash
pnpm exec tsc -b
pnpm exec vitest run tests/component/
```

Expected: tsc exit 0; all component tests PASS (the strip-fixture work in Task 4 hasn't happened yet, but the field is optional reading — IntensityPane.tsx was the only consumer that read it).

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(chart): delete IntensityPane and its test

The heatmap component and its test file are removed; ChartStage no
longer mounts them after the previous commit. The depth_intensity wire
field, frontend type, and backend feeder are cleaned up in follow-on
commits per ADR-0016.
EOF
)"
```

---

## Task 4: Strip depth_intensity_by_day from all five frontend test fixtures

**Files:**
- Modify: `frontend/tests/component/ChartStage.test.tsx` (line 92)
- Modify: `frontend/tests/component/Workarea.test.tsx` (line 31)
- Modify: `frontend/src/api/range.test.tsx` (line 21)
- Modify: `frontend/src/replay/Workarea.test.tsx` (line 42)
- Modify: `frontend/src/chart/CandlePane.test.tsx` (line 44)

Each fixture has a single line `depth_intensity_by_day: [],`. Delete it. The fixtures are typed `as any`, so removing the line does not change type-check behavior; Task 5 removes the type itself.

- [ ] **Step 1: Strip the field from each fixture**

For each of the five files, delete the line containing `depth_intensity_by_day: [],`. Use exact `Edit` operations — do not use `sed -i` because the surrounding indentation may differ slightly per file. Confirm by re-reading each file after editing.

- [ ] **Step 2: Verify the field is gone from frontend fixtures**

```bash
git grep -n "depth_intensity_by_day" -- frontend/
```

Expected: zero lines.

- [ ] **Step 3: Run type-check + frontend tests**

```bash
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/component/ChartStage.test.tsx frontend/tests/component/Workarea.test.tsx frontend/src/api/range.test.tsx frontend/src/replay/Workarea.test.tsx frontend/src/chart/CandlePane.test.tsx
git commit -m "$(cat <<'EOF'
test(fixtures): drop depth_intensity_by_day from frontend bundle stubs

Five test fixtures previously included an empty depth_intensity_by_day
array to satisfy the RangeBundle type. With IntensityPane gone the
field is unused; Task 5 deletes the type definition itself.
EOF
)"
```

---

## Task 5: Remove DepthIntensity type and the RangeBundle field from frontend `api/types.ts`

**Files:**
- Modify: `frontend/src/api/types.ts`

Two changes: delete the `DepthIntensity` type declaration and remove `depth_intensity_by_day` from the `RangeBundle` type.

- [ ] **Step 1: Read the current shape of `frontend/src/api/types.ts`**

Open the file and locate the `DepthIntensity` declaration and the `depth_intensity_by_day` field on `RangeBundle`. Their exact line numbers may have shifted; use `grep -n DepthIntensity frontend/src/api/types.ts` to find them.

- [ ] **Step 2: Delete the `DepthIntensity` declaration**

Remove the entire `export type DepthIntensity = { … };` (or `export interface DepthIntensity { … }`) block. Include any JSDoc directly above it that exclusively documents `DepthIntensity`.

- [ ] **Step 3: Drop the `depth_intensity_by_day` field on `RangeBundle`**

Inside the `RangeBundle` type declaration, delete the line:

```ts
depth_intensity_by_day: DepthIntensity[];
```

(The exact name may be `depth_intensity_by_day: Array<DepthIntensity>;` — match what is there.)

- [ ] **Step 4: Verify no remaining references in frontend**

```bash
git grep -nE "DepthIntensity|depth_intensity" -- frontend/
```

Expected: zero lines.

- [ ] **Step 5: Run type-check + frontend tests**

```bash
pnpm exec tsc -b
pnpm exec vitest run
```

Expected: tsc exit 0; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "$(cat <<'EOF'
refactor(api/types): drop DepthIntensity and the bundle field

The frontend's RangeBundle no longer carries depth_intensity_by_day.
Backend removal follows in the next commits.
EOF
)"
```

---

## Task 6: Strip depth_intensity / DepthIntensity from backend tests

**Files:**
- Modify: `tests/test_api_range.py`
- Modify: `tests/hoga/api/test_range_models.py`
- Modify: `tests/hoga/api/test_bundle.py`

Each backend test still imports `DepthIntensity` from `hoga.api.models`, constructs `depth_intensity_by_day=[DepthIntensity(…)]` payloads, and asserts on the field. After Task 7 the symbol is gone, so stripping these references first keeps each commit green.

- [ ] **Step 1: Edit `tests/test_api_range.py`**

Make three changes:

1. Remove `DepthIntensity,` from the import line `from hoga.api.models import (…)`.
2. Delete the `depth_intensity_by_day=[…]` argument and its inline `DepthIntensity(…)` literal from the test fixture (around line 30).
3. Delete the assertion `assert "depth_intensity_by_day" in body` (around line 69).

- [ ] **Step 2: Edit `tests/hoga/api/test_range_models.py`**

1. Remove `DepthIntensity,` from the import line.
2. Delete the `depth_intensity_by_day=[DepthIntensity(…)]` block from the fixture (around line 54).
3. Delete the assertion `assert len(bundle.depth_intensity_by_day) == 1` (around line 85).

- [ ] **Step 3: Edit `tests/hoga/api/test_bundle.py`**

1. Remove `DepthIntensity,` from the import line.
2. Delete the `di = DepthIntensity(…)` fixture and its construction (around line 162).
3. Delete the `patch.object(bundle_mod, "build_depth_intensity_slice", return_value=di),` line (around line 172) — leave the surrounding `with` context manager and other `patch.object` lines untouched.
4. Delete the two `assert len(rb.depth_intensity_by_day) ==` lines (around lines 208 and 229).

- [ ] **Step 4: Verify no backend test references remain**

```bash
git grep -nE "depth_intensity|DepthIntensity" -- tests/
```

Expected: zero lines.

- [ ] **Step 5: Run backend tests**

From repo root:

```bash
python -m pytest tests/ -x
```

Expected: all tests PASS. (At this point `build_depth_intensity_slice` and `DepthIntensity` still exist in the production code — Task 7 removes them. Tests just no longer touch them.)

- [ ] **Step 6: Commit**

```bash
git add tests/test_api_range.py tests/hoga/api/test_range_models.py tests/hoga/api/test_bundle.py
git commit -m "$(cat <<'EOF'
test(api): drop DepthIntensity references from backend tests

Prepares for removal of build_depth_intensity_slice and the DepthIntensity
model. Production code is removed in the next commit.
EOF
)"
```

---

## Task 7: Remove DepthIntensity model, RangeBundle field, builder, and caller from backend

**Files:**
- Modify: `hoga/api/bundle.py` (function `build_depth_intensity_slice`, its caller in `build_range_bundle`'s per-day loop, and the assembly key in the final `RangeBundle(…)` constructor)
- Modify: `hoga/api/models.py` (class `DepthIntensity`, field `depth_intensity_by_day` on `RangeBundle`)

These two files change atomically — neither half is meaningful alone.

- [ ] **Step 1: Edit `hoga/api/bundle.py` — remove the builder and caller**

1. Delete the entire `def build_depth_intensity_slice(…)` function (around line 185 onward — locate via `grep -n "def build_depth_intensity_slice" hoga/api/bundle.py`). Include the docstring and any module-level helpers used only by that function (e.g., the 20-row UNPIVOT helper around line 166 may be shared with `build_quote_ratio_slice` — verify by greping; if shared, leave it).
2. Inside `build_range_bundle`, find the per-day loop (around lines 471-475 from the previous grep). Delete the line:

```python
di_d = build_depth_intensity_slice(
    engine, code=code, date=d, bucket_ms=bucket_ms,
)
```

and any subsequent `intensity_by_day.append(di_d)` (or equivalent name) inside the loop. Also delete the `intensity_by_day = []` initialisation above the loop if it exists.

3. In the final `RangeBundle(…)` constructor (around line 498-500), delete the line:

```python
depth_intensity_by_day=intensity_by_day,
```

- [ ] **Step 2: Edit `hoga/api/models.py` — remove the class and the field**

1. Delete the entire `class DepthIntensity(BaseModel): …` block (around line 87, per the prior grep).
2. Inside the `RangeBundle` class declaration, delete the field:

```python
depth_intensity_by_day: list[DepthIntensity]
```

(or whatever the exact spelling is — `Optional[…]`, `Sequence[…]`, etc. — match what is there).

- [ ] **Step 3: Verify zero remaining references repo-wide**

```bash
git grep -nE "depth_intensity|DepthIntensity|build_depth_intensity_slice" -- hoga/ frontend/ tests/
```

Expected: zero lines.

The only allowed remaining matches are inside `docs/adr/0013-rangebundle-single-read-path.md`, `docs/adr/0016-retire-depth-intensity-for-quote-totals.md`, and `docs/superpowers/specs/2026-05-23-quote-totals-pane-design.md` — these are historical records, not code.

- [ ] **Step 4: Run backend tests + a sample backend integration**

```bash
python -m pytest tests/ -x
```

Expected: all tests PASS.

If the project has an integration runner that hits `/api/range`, also run it (or skip if not present — manual dogfood in Task 8 covers it).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/bundle.py hoga/api/models.py
git commit -m "$(cat <<'EOF'
refactor(api): drop depth_intensity from RangeBundle wire and builder

Removes DepthIntensity, the per-day depth_intensity_by_day field on
RangeBundle, and build_depth_intensity_slice. The Quote Totals raw
signal continues to ship via the existing quote_ratio.points
bid_total/ask_total pair (no new wire field — see CONTEXT.md
"Quote Totals" and ADR-0016).
EOF
)"
```

---

## Task 8: End-to-end verification

**Files:** none modified.

This task is a checklist run. It produces no commit; if it fails, fix the offending earlier commit (do not amend — make a follow-on commit).

- [ ] **Step 1: Type-check frontend**

From `frontend/`:

```bash
pnpm exec tsc -b
```

Expected: exit 0, no output.

- [ ] **Step 2: Run full frontend test suite**

```bash
pnpm exec vitest run
```

Expected: all tests PASS. Note the count of `QuoteTotalsPane` tests (3) and the absence of `IntensityPane` tests.

- [ ] **Step 3: Run full backend test suite**

From repo root:

```bash
python -m pytest tests/ -x
```

Expected: all tests PASS.

- [ ] **Step 4: Repo-wide grep guard**

```bash
git grep -nE "depth_intensity|DepthIntensity|IntensityPane|build_depth_intensity_slice" -- hoga/ frontend/ tests/
```

Expected: zero lines outside of `docs/adr/` and `docs/superpowers/`.

- [ ] **Step 5: Manual dogfood**

Start the dev servers (frontend `pnpm dev` from `frontend/`, backend per project convention). Open `http://localhost:5173/replay`. Select code `003490`, date range `2026-05-19` → `2026-05-20`, timeframe `1m`. Click 데이터 불러오기 / Reload.

Verify each pane:

1. **Pane 0 — Candle**: candles render with day-boundary dotted line crossing.
2. **Pane 1 — Volume**: green/red histogram per bucket.
3. **Pane 2 — Ratio**: teal 호가비 line with crosshair labels like `7.1× B`.
4. **Pane 3 — Quote Totals** (NEW): green bid line + red ask line, both positive, auto-scaled price axis. Crosshair hover shows both values formatted with thousands separators (`12,345`).
5. **Pane 4 — FillStrength**: mirrored histogram, buy (green) above 0, sell (red) below. Confirm pane 3 does NOT contain a stray FillStrength buy histogram (regression check for the prior-session pane-leak bug).

Open the browser console: no errors. The crosshair time chip at the bottom of the x-axis reads in `MM/DD HH:MM` KST format (not `1월'70`).

- [ ] **Step 6: Visual screenshot for the PR description (optional)**

If shipping via a PR, capture a full-page screenshot of `/replay` with the same fixture (003490, 2026-05-19→05-20, 1m) and attach it to the PR body.

---

## Self-Review Notes (writer's checklist — completed)

- **Spec coverage:** Each section in `2026-05-23-quote-totals-pane-design.md` maps to one or more tasks: Architecture → Tasks 1-2; Component → Task 1; Data flow → reused as-is (no task needed); Removals (production code) → Tasks 2-3, 5, 7; Removals (tests) → Tasks 4, 6; Removals (documentation) → already committed in grill session (commit `c8bcf08`); Testing → Tasks 1 and 8; Cross-references → already committed in grill session.
- **Placeholder scan:** No "TBD", "TODO", "implement later", "Add appropriate error handling", or "Similar to Task N" patterns. Every code-change step has the actual code or the exact line to delete.
- **Type / name consistency:** `QuoteTotalsPane` (component), `data-pane="quote-totals"` (selector), `bidSeries` / `askSeries` (locals), `PANE_STRETCH = [1.4, 0.3, 0.4, 0.4, 0.4]` (constant) — used identically in Tasks 1, 2, and 8.
- **Ordering:** Each task ends green: tests pass, tsc passes. The order — add → wire → delete → strip fixtures → strip frontend type → strip backend tests → strip backend code → verify — keeps the tree compilable and testable at every commit boundary.
