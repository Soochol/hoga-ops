# Live Ask Peak Minute Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the "당일 매도 최대벽" chart overlay on D/W/M calendar timeframes while preserving its current behavior on minute timeframes.

**Architecture:** The ask-peak line is not a pane from `paneSpecsForTimeframe`; it is a candle-pane primitive mounted by `LiveChartRoot`. Add the same minute-timeframe gate used by other intraday-only overlays at the `LiveChartRoot` mount site, and cover it with a regression test that mocks the overlay component.

**Tech Stack:** React, TypeScript, Vitest, React Testing Library, lightweight-charts mocks.

---

## File Structure

- Modify `frontend/src/live/LiveChartRoot.tsx`
  - Responsibility: mounts chart panes and overlays for the active `/live` timeframe.
  - Change: render `<LiveAskPeakSegments />` only when `isMinuteTimeframe(timeframe)` is true.
- Modify `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`
  - Responsibility: verifies end-to-end timeframe/toggle wiring from store state to mounted chart children.
  - Change: mock `LiveAskPeakSegments` and assert it mounts on `1m` but not on `D`.

## Task 1: Add Regression Coverage

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`

- [ ] **Step 1: Extend hoisted test capture state**

Replace the current hoisted capture:

```tsx
const { mounted } = vi.hoisted(() => ({ mounted: [] as string[] }));
```

with:

```tsx
const { mounted, askPeakMounts } = vi.hoisted(() => ({
  mounted: [] as string[],
  askPeakMounts: [] as string[],
}));
```

- [ ] **Step 2: Mock `LiveAskPeakSegments`**

Add this mock after the existing `RangeSeriesPane` mock and before the `lightweight-charts` mock:

```tsx
vi.mock('./LiveAskPeakSegments', () => ({
  default: () => {
    askPeakMounts.push('mounted');
    return null;
  },
}));
```

- [ ] **Step 3: Reset ask-peak mount captures in `beforeEach`**

In the existing `beforeEach`, add:

```tsx
askPeakMounts.length = 0;
```

The beginning of the block should look like:

```tsx
beforeEach(() => {
  mounted.length = 0;
  askPeakMounts.length = 0;
  // Deterministic baseline: all togglable panes ON, investor OFF.
  useLivePageStore.setState({
    historicalFromDate: null,
```

- [ ] **Step 4: Add the failing regression tests**

Append these tests inside `describe('LiveChartRoot — pane 토글 배선 ...')`:

```tsx
it('1m → 당일 매도 최대벽 오버레이 마운트', () => {
  renderAt('1m');
  expect(askPeakMounts).toEqual(['mounted']);
});

it('calendar(D) → 당일 매도 최대벽 오버레이 미마운트', () => {
  renderAt('D');
  expect(askPeakMounts).toEqual([]);
});
```

- [ ] **Step 5: Run the focused test and verify it fails**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected before implementation:

```text
FAIL src/live/LiveChartRoot.paneToggles.test.tsx
calendar(D) → 당일 매도 최대벽 오버레이 미마운트
expected [ 'mounted' ] to deeply equal []
```

## Task 2: Gate Ask-Peak Overlay to Minute Timeframes

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`

- [ ] **Step 1: Replace unconditional ask-peak overlay render**

Replace:

```tsx
<LiveAskPeakSegments
  paneSeries={paneSeries}
  axis={axis}
  dayAskPeaks={dayAskPeaks}
  segments={cb.segments}
  candles={cb.candles}
  todayKst={todayKst}
/>
```

with:

```tsx
{isMinuteTimeframe(timeframe) && (
  <LiveAskPeakSegments
    paneSeries={paneSeries}
    axis={axis}
    dayAskPeaks={dayAskPeaks}
    segments={cb.segments}
    candles={cb.candles}
    todayKst={todayKst}
  />
)}
```

No new import is needed because `LiveChartRoot.tsx` already imports `isMinuteTimeframe`.

- [ ] **Step 2: Run the focused regression test**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected:

```text
PASS src/live/LiveChartRoot.paneToggles.test.tsx
```

- [ ] **Step 3: Run adjacent ask-peak pure tests**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveAskPeakSegments.test.tsx
```

Expected:

```text
PASS src/live/LiveAskPeakSegments.test.tsx
```

## Task 3: Broader Verification

**Files:**
- No code changes.

- [ ] **Step 1: Run the live chart test subset**

Run:

```bash
cd frontend
npm test -- --run src/live/LiveChartRoot.paneToggles.test.tsx src/live/LiveAskPeakSegments.test.tsx src/live/paneSpecsForTimeframe.test.ts
```

Expected:

```text
PASS src/live/LiveChartRoot.paneToggles.test.tsx
PASS src/live/LiveAskPeakSegments.test.tsx
PASS src/live/paneSpecsForTimeframe.test.ts
```

- [ ] **Step 2: Type-check the frontend if the repo script exists**

Check available scripts:

```bash
cd frontend
npm run
```

If `typecheck` exists, run:

```bash
npm run typecheck
```

If this repo uses another validation script such as `check`, run that instead:

```bash
npm run check
```

Expected:

```text
0 TypeScript errors
```

- [ ] **Step 3: Inspect the diff**

Run:

```bash
git diff -- frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected diff characteristics:

```text
LiveChartRoot.tsx: only wraps LiveAskPeakSegments with isMinuteTimeframe(timeframe)
LiveChartRoot.paneToggles.test.tsx: only adds mock/captures/tests for ask-peak overlay mount behavior
```

## Task 4: Manual QA

**Files:**
- No code changes.

- [ ] **Step 1: Start the frontend dev server**

Run the project-standard dev command from `frontend/package.json`, usually:

```bash
cd frontend
npm run dev
```

Expected:

```text
Local: http://localhost:<port>/
```

- [ ] **Step 2: Verify minute timeframe behavior**

Open `/live`, select a stock with ask-peak data, enable `지표 → 호가 지표 → 당일 매도 최대벽`, and switch to `1m`.

Expected:

```text
The 당일 매도 최대벽 line appears on the minute chart when enabled.
```

- [ ] **Step 3: Verify calendar timeframe behavior**

Switch the same chart to `D`.

Expected:

```text
The 당일 매도 최대벽 line is not visible on the daily chart.
The indicator toggle can remain enabled in the modal; it simply has no D/W/M render effect.
```

- [ ] **Step 4: Verify return to minute timeframe**

Switch back to `1m`.

Expected:

```text
The 당일 매도 최대벽 line appears again without requiring the user to re-toggle the indicator.
```

## Commit

- [ ] **Step 1: Commit the focused change**

Run:

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.paneToggles.test.tsx
git commit -m "fix: hide ask peak overlay on calendar timeframes"
```

Expected:

```text
[branch-name <sha>] fix: hide ask peak overlay on calendar timeframes
```

## Self-Review Checklist

- [ ] The ask-peak overlay is hidden on D/W/M by mount condition, not by deleting data or changing backend behavior.
- [ ] Minute timeframe behavior remains unchanged.
- [ ] Tests fail before the implementation and pass after it.
- [ ] No unrelated indicator pane behavior changes.
- [ ] No persistence/default setting changes.
