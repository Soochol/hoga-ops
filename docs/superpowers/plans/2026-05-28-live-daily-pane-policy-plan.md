# `/live` D/W/M pane policy + visible-range normalization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: frontend
```

**Goal:** On `/live`, mount only candle + volume panes when the LiveTimeframe is D/W/M (current 5-pane mount stays for 1m–30m), and switch the initial visible-range policy from a size-based `totalBars < 50` branch to a timeframe-based `isMinute ? setVisibleLogicalRange(target=300) : fitContent()` branch. Removing the empty hoga panes recovers vertical space, and `fitContent()` then renders D/W/M candles at normal apparent width without per-timeframe magic targets.

**Architecture:** Two coupled changes inside `frontend/src/live/LiveChartRoot.tsx`:
1. Pane list source moves from the unconditional `PANE_SPECS` import to a small pure helper `paneSpecsForTimeframe(tf)` that returns `PANE_SPECS` for minute timeframes and `[CANDLE_SPEC, VOLUME_SPEC]` for D/W/M. React keys stay `spec.name` so only the panes that actually leave the set (ratio / quote-totals / fill-strength) unmount on timeframe toggle.
2. Initial-view effect's `totalBars < 50` size branch becomes `isMinute(timeframe) ? setVisibleLogicalRange : fitContent`. Same `try { ... } catch` shape.

**Tech Stack:** React 18, lightweight-charts v5, Zustand store (`useLivePageStore`), Vitest, Playwright.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-28-live-daily-pane-policy-design.md`
- ADR-0041: `docs/adr/0041-live-calendar-timeframe-panes.md`
- CONTEXT.md: **LiveTimeframe** entry (new)

---

## File Structure

**Create:**
- `frontend/src/live/paneSpecsForTimeframe.ts` — single pure function `paneSpecsForTimeframe(tf: LiveTimeframe): BoundPaneSpec[]`. Co-located with the other `live/` helpers (`liveDateTime`, `bucketHogaSeries`, etc.) instead of being a private const inside `LiveChartRoot.tsx`, so the unit test gets a clean import target and future consumers (e.g. a per-timeframe Settings preview) can reuse it.
- `frontend/src/live/paneSpecsForTimeframe.test.ts` — unit tests for the helper.

**Modify:**
- `frontend/src/live/LiveChartRoot.tsx`:
  - Replace `import { PANE_SPECS, PANE_STRETCH } from '../chart/paneSpecs'` consumer with `paneSpecsForTimeframe(timeframe)` at the render site (line ~276).
  - Inside the initial-view effect (lines 104–122), replace the `totalBars < 50 ? fitContent() : setVisibleLogicalRange(...)` branch with `isMinuteLiveTimeframe(timeframe) ? setVisibleLogicalRange(...) : fitContent()`.
  - Import the new helper.

**No changes:**
- `frontend/src/chart/paneSpecs.ts` (the canonical 5-pane registry stays the source of truth for `/replay` and the minute-timeframe path on `/live`).
- `frontend/src/chart/RangeSeriesPane.tsx` (cleanup useEffect already handles dynamic unmount with try/catch around `removeSeries`).
- `frontend/src/live/useLiveBundle.ts` (`enableRange = isMinute` rule was already aligned with this decision in the prior session).
- `frontend/src/state/livePage.ts` (LiveTimeframe union already lists all 9 values).

---

## Task 1: Add `paneSpecsForTimeframe` helper with TDD

**Files:**
- Create: `frontend/src/live/paneSpecsForTimeframe.ts`
- Test: `frontend/src/live/paneSpecsForTimeframe.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `frontend/src/live/paneSpecsForTimeframe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
import { PANE_SPECS } from '../chart/paneSpecs';
import { CANDLE_SPEC } from '../chart/projectors/candle';
import { VOLUME_SPEC } from '../chart/projectors/volume';

describe('paneSpecsForTimeframe', () => {
  it.each(['1m', '3m', '5m', '10m', '15m', '30m'] as const)(
    'minute timeframe %s → full 5-pane registry (PANE_SPECS identity)',
    (tf) => {
      expect(paneSpecsForTimeframe(tf)).toBe(PANE_SPECS);
    },
  );

  it.each(['D', 'W', 'M'] as const)(
    'calendar timeframe %s → only candle + volume',
    (tf) => {
      const result = paneSpecsForTimeframe(tf);
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(CANDLE_SPEC);
      expect(result[1]).toBe(VOLUME_SPEC);
    },
  );

  it('minute timeframes share the SAME array reference (memoization)', () => {
    // Identity equality matters: RangeSeriesPane's useEffect deps include
    // `spec` and a fresh array per call would churn series mounts.
    expect(paneSpecsForTimeframe('1m')).toBe(paneSpecsForTimeframe('5m'));
  });

  it('calendar timeframes share the SAME array reference (memoization)', () => {
    expect(paneSpecsForTimeframe('D')).toBe(paneSpecsForTimeframe('W'));
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
cd frontend && npx vitest run src/live/paneSpecsForTimeframe.test.ts
```

Expected: FAIL with `Cannot find module './paneSpecsForTimeframe'` or similar.

- [ ] **Step 1.3: Write the helper**

Create `frontend/src/live/paneSpecsForTimeframe.ts`:

```ts
import type { LiveTimeframe } from '../state/livePage';
import { PANE_SPECS, type BoundPaneSpec } from '../chart/paneSpecs';
import { CANDLE_SPEC } from '../chart/projectors/candle';
import { VOLUME_SPEC } from '../chart/projectors/volume';

/**
 * Module-frozen "calendar" pane set: D/W/M timeframes mount only candle +
 * volume because the three hoga panes (RatioPane, QuoteTotalsPane,
 * FillStrength) have no source data outside the minute timeframes — `/live`
 * never calls `/api/range` for D/W/M (see useLiveBundle's `enableRange`
 * gate). Empty stripes squeezed the candle pane vertically; removing them
 * also restores the candle's apparent horizontal width under `fitContent`.
 *
 * See ADR-0041 — `/live` calendar timeframes mount candle + volume only.
 */
const CALENDAR_PANE_SPECS: readonly BoundPaneSpec[] = Object.freeze([
  CANDLE_SPEC,
  VOLUME_SPEC,
]) as readonly BoundPaneSpec[];

/**
 * Pick the pane spec list to mount in `LiveChartRoot` for a given
 * **LiveTimeframe**. Returns the same array reference across calls (so the
 * `RangeSeriesPane` useEffect deps that include `spec` don't churn).
 */
export function paneSpecsForTimeframe(tf: LiveTimeframe): readonly BoundPaneSpec[] {
  return tf === 'D' || tf === 'W' || tf === 'M' ? CALENDAR_PANE_SPECS : PANE_SPECS;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
cd frontend && npx vitest run src/live/paneSpecsForTimeframe.test.ts
```

Expected: PASS, 4 tests (6 + 3 from `it.each` + 2 identity = 11 cases collapsing into 4 logical tests; vitest reports per-`it.each` row so it'll print as `9 + 1 + 1 = 11 passed`).

- [ ] **Step 1.5: Commit**

```bash
git add frontend/src/live/paneSpecsForTimeframe.ts frontend/src/live/paneSpecsForTimeframe.test.ts
git commit -m "feat(live): paneSpecsForTimeframe helper — D/W/M = candle+volume only

Per ADR-0041, the /live chart should mount only the candle and volume
panes when the active LiveTimeframe is D/W/M; the three hoga panes
(ratio, quote-totals, fill-strength) carry no data outside minute
timeframes (no /api/range call) and their empty stripes both create
visual noise and vertically compress the candle pane.

This commit adds the pure helper. The next commit wires LiveChartRoot
to consume it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire `LiveChartRoot` to the helper

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (import + render-site swap)

- [ ] **Step 2.1: Update import block**

Open `frontend/src/live/LiveChartRoot.tsx`. Find the existing import:

```tsx
import { PANE_SPECS, PANE_STRETCH } from '../chart/paneSpecs';
```

If `PANE_STRETCH` is also unused after this change, remove it from the import. Check current usages first:

```bash
grep -n "PANE_STRETCH\|PANE_SPECS" frontend/src/live/LiveChartRoot.tsx
```

Replace the import line with:

```tsx
import { PANE_STRETCH } from '../chart/paneSpecs';
import { paneSpecsForTimeframe } from './paneSpecsForTimeframe';
```

(If `grep` shows `PANE_STRETCH` has no remaining uses, drop that import entirely.)

- [ ] **Step 2.2: Swap the render site**

Find the JSX block around line 276:

```tsx
{PANE_SPECS.map((spec, i) => (
  <RangeSeriesPane
    key={spec.name}
    chart={chart}
    bundle={bundle}
    axis={axis}
    paneIndex={i}
    spec={spec}
  />
))}
```

Replace `PANE_SPECS.map` with `paneSpecsForTimeframe(timeframe).map`:

```tsx
{paneSpecsForTimeframe(timeframe).map((spec, i) => (
  <RangeSeriesPane
    key={spec.name}
    chart={chart}
    bundle={bundle}
    axis={axis}
    paneIndex={i}
    spec={spec}
  />
))}
```

- [ ] **Step 2.3: Build to catch type errors**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2.4: Manual smoke in browser**

If a dev server is already running, switch the `/live` page to D, then W, then M, then back to 1m. Confirm: D/W/M shows candle + volume only; 1m shows all 5 panes; no React console errors about removed series.

If no dev server is running, skip this step — the e2e smoke test in Task 4 covers regression.

- [ ] **Step 2.5: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -m "refactor(live): mount panes via paneSpecsForTimeframe(tf)

Replace the unconditional PANE_SPECS.map at the LiveChartRoot render
site with paneSpecsForTimeframe(timeframe). For minute timeframes the
result is the same PANE_SPECS reference (no churn), for D/W/M it
trims the array to [CANDLE_SPEC, VOLUME_SPEC] so the three empty
hoga panes unmount cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Replace size-based initial-view branch with timeframe-based branch

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (initial-view effect, lines 104–122)

- [ ] **Step 3.1: Read the current effect**

Confirm the current shape at `LiveChartRoot.tsx:104-122`:

```tsx
useEffect(() => {
  if (!chart || !bundle || bundle.candles.length === 0) return;
  if (didInitialViewRef.current) return;
  if (useLivePageStore.getState().historicalFromDate !== null) return;
  const ts = chart.timeScale();
  const totalBars = bundle.candles.length;
  // ... 300-bar window / fitContent comment ...
  const target = 300;
  try {
    if (totalBars < 50) {
      ts.fitContent();
    } else {
      const from = Math.max(0, totalBars - target);
      const to = totalBars + 5; // 5-bar right padding
      ts.setVisibleLogicalRange({ from, to });
    }
    didInitialViewRef.current = true;
  } catch {
    // chart torn down between effect runs
  }
}, [chart, bundle]);
```

- [ ] **Step 3.2: Add the deps the new branch needs**

The new branch keys off `timeframe` (a prop of `LiveChartRoot`). Add `timeframe` to the effect's dependency array AND to the timeframe-reset effect's reset rule (already present at line 101–103 — verify `timeframe` is in those deps).

If `timeframe` is not yet in `[chart, bundle]`, append it: `[chart, bundle, timeframe]`. The eslint react-hooks rule will flag this if missed.

- [ ] **Step 3.3: Replace the branch body**

Replace the `try { if (totalBars < 50) { ... } else { ... } }` block with:

```tsx
  // Branch by timeframe, not bundle size. Minute timeframes carry ~5000
  // 1m bars and need the 300-bar windowing to stay legible; D/W/M carry
  // a few dozen bars at most and look right under fitContent now that
  // the hoga panes are gone (no vertical compression of candles). See
  // ADR-0041 + the 2026-05-28 spec.
  const target = 300;
  const isMinute =
    timeframe === '1m' ||
    timeframe === '3m' ||
    timeframe === '5m' ||
    timeframe === '10m' ||
    timeframe === '15m' ||
    timeframe === '30m';
  try {
    if (isMinute) {
      const totalBars = bundle.candles.length;
      const from = Math.max(0, totalBars - target);
      const to = totalBars + 5; // 5-bar right padding
      ts.setVisibleLogicalRange({ from, to });
    } else {
      ts.fitContent();
    }
    didInitialViewRef.current = true;
  } catch {
    // chart torn down between effect runs
  }
```

Note: the `const totalBars` declaration moves *inside* the `isMinute` branch since `fitContent` doesn't use it. Remove the outer `const totalBars = bundle.candles.length;` line.

- [ ] **Step 3.4: Build to catch type errors**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3.5: Run all frontend tests**

```bash
cd frontend && npx vitest run
```

Expected: PASS, including the existing `useLiveBundle.test.ts` and the new `paneSpecsForTimeframe.test.ts`. No new failures.

- [ ] **Step 3.6: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -m "fix(live): initial visible range by timeframe, not bundle size

The 'totalBars < 50 → fitContent / else windowed' branch was a
proxy for what we actually mean: D/W/M bundles are sparse and want
fitContent; minute bundles are dense and want a windowed view. With
ADR-0041 removing the empty hoga panes for D/W/M, fitContent's
candle width now looks right and no magic per-timeframe target
table is needed. The branch keys off timeframe directly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: e2e smoke for D/W/M pane count + e2e regression run

**Files:**
- Modify: `frontend/tests/e2e/live-smoke.spec.ts` (add one test)

- [ ] **Step 4.1: Add a regression test that asserts pane visibility per timeframe**

The existing `live-smoke.spec.ts` already covers the empty-state happy path and the defect banner. Add a third test that flips the toolbar to `D` and asserts the chart still renders without console errors (lightweight-charts pane unmount safety) AND the `live-chart-root` is mounted (no React error boundary fallback).

Open `frontend/tests/e2e/live-smoke.spec.ts`. Append inside the `describe` block, after the S2 test:

```ts
  test('S3: timeframe D unmounts hoga panes without console errors (ADR-0041)', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await installLiveMocks(page);
    await page.goto('/live');

    // Select the only watchlist symbol.
    await page.getByRole('button', { name: /관심종목 패널 토글/ }).click();
    await page.getByText('098460', { exact: true }).first().click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // Toggle to D and re-assert chart root mounts. No assertion on pane DOM
    // (lightweight-charts canvases don't carry stable selectors); the
    // chart-root presence + clean console is the regression guard for
    // RangeSeriesPane's dynamic unmount cleanup.
    await page.getByRole('button', { name: 'D', exact: true }).click();
    await expect(page.locator('[data-testid="live-chart-root"]')).toBeVisible();

    // No "data must be asc ordered by time", no "removeSeries", no React
    // boundary catch — the noise we'd see if pane unmount went wrong.
    expect(
      consoleErrors.filter(
        (e) =>
          e.includes('asc ordered by time') ||
          e.includes('removeSeries') ||
          e.includes('The above error occurred'),
      ),
    ).toEqual([]);
  });
```

- [ ] **Step 4.2: Run the new e2e test**

```bash
cd frontend && npx playwright test live-smoke.spec.ts --reporter=line
```

Expected: PASS, 3 tests (S1 + S2 + S3).

- [ ] **Step 4.3: Commit**

```bash
git add frontend/tests/e2e/live-smoke.spec.ts
git commit -m "test(e2e): S3 — /live D toggle preserves chart-root mount

Regression guard for ADR-0041: when LiveChartRoot switches its pane
list from PANE_SPECS to [CANDLE_SPEC, VOLUME_SPEC], the three hoga
RangeSeriesPane instances unmount and their useEffect cleanup calls
chart.removeSeries. The existing try/catch in RangeSeriesPane.tsx
already guards the ChartErrorBoundary race; this test exercises the
same code path on a normal user action and asserts no console noise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Manual visual sanity check + close out

**Files:** none (no code change unless visual regression appears)

- [ ] **Step 5.1: Capture before/after screenshots**

With a dev server running:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B viewport 1440x900
$B goto http://localhost:5173/live
sleep 5
# select 098460 via toolbar toggle
$B click "$($B snapshot -i 2>&1 | grep '관심종목 패널 토글' | grep -oE '@e[0-9]+' | head -1)" >/dev/null
sleep 1
$B click "$($B snapshot -i 2>&1 | grep -E '@c[0-9]+ \[cursor:pointer\] "098460"' | grep -oE '@c[0-9]+' | head -1)" >/dev/null
sleep 4
# D
$B click "$($B snapshot -i 2>&1 | grep -E '@e[0-9]+ \[button\] "D"' | grep -oE '@e[0-9]+' | head -1)" >/dev/null
sleep 2
$B screenshot /tmp/live-D-after.png --viewport
# W
$B click "$($B snapshot -i 2>&1 | grep -E '@e[0-9]+ \[button\] "W"' | grep -oE '@e[0-9]+' | head -1)" >/dev/null
sleep 2
$B screenshot /tmp/live-W-after.png --viewport
# M (via JS to avoid 'M' selector collision)
$B js "[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'M')[0].click()"
sleep 2
$B screenshot /tmp/live-M-after.png --viewport
```

- [ ] **Step 5.2: Verify visually**

Open each PNG and confirm:

- **D**: candle + volume panes only. No empty ratio/quote-totals/fill-strength stripes. Candles span the visible width comfortably (`fitContent`).
- **W**: same pane structure, 4 weekly candles distributed.
- **M**: same pane structure, 1 monthly candle (only one calendar month of data).

If a screenshot looks wrong, file a follow-up: do NOT block the plan unless a regression has been introduced. The spec already documents the per-timeframe `target` table as a known fallback knob.

- [ ] **Step 5.3: Push and open PR (via /ship in the wrapping full-flow), or stop here for review**

This task is a no-commit checkpoint; the wrapping `/full-flow` command will run the verification gate and follow-up steps (architecture review, simplify, code review) before landing.

---

## Self-review (done by the author of this plan — already applied)

1. **Spec coverage:**
   - D1 (pane set by timeframe) — Tasks 1 + 2.
   - D2 (visible-range policy) — Task 3.
   - D3 (banner auto-hidden, no code change) — explicitly out of scope; verified by Task 4's clean console.
   - D4 (replay unaffected, useLiveBundle unchanged) — no task touches those files.
2. **Placeholder scan:** no TBDs, no "implement later", every code step has runnable code.
3. **Type consistency:** `paneSpecsForTimeframe(tf: LiveTimeframe): readonly BoundPaneSpec[]` matches the consumer at the render site (`spec` and `paneIndex` use `BoundPaneSpec.name` / index).

---

## Execution Handoff

Wrapping command (`/full-flow`) drives execution via `superpowers:subagent-driven-development` next.
