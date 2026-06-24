# Ask Peak Visible Max Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the `/live` day ask peak overlay, highlight the single largest ask-wall segment currently visible in the candle chart area with a third user-configurable style.

**Architecture:** Keep backend ask peak data unchanged. The frontend already builds baseline and all-price ask peak segments, so the new behavior should add comparison metadata (`qty`) to those segments, derive the visible x-range from the chart time scale, and override the style for the largest segment whose time interval intersects that visible range. Persist the third style alongside existing ask peak indicator styles.

**Tech Stack:** React, TypeScript, Zustand, lightweight-charts custom series primitive, Vitest, Testing Library.

## Global Constraints

- Read and follow `DESIGN.md` before visual changes; preserve the dark, dense, trading-tool UI.
- Do not introduce backend/API changes; the existing `AskPeak` and `AskPeakCandidate` payloads already contain the required quantities.
- Keep existing two ask peak styles intact: `체결가격 기준 최대벽` and `미체결 포함 최대벽`.
- Add exactly one combined visible-max highlight across both ask peak families.
- The highlight applies only among segments that intersect the current visible candle chart time range.
- Default visible-max highlight color: `#EAB308`; default line width: `3`.
- Store new style fields in `localStorage["live.indicators.v1"]` through the existing live indicator persistence flow.
- Do not apply this change to bid peak unless a separate request asks for it.

---

## File Structure

- Modify `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
  - Add a `qty` field to `AskPeakSegment`.
  - Continue rendering only from segment display fields; `qty` is comparison metadata.

- Modify `frontend/src/live/LiveAskPeakSegments.tsx`
  - Populate `qty` when building segments.
  - Add pure helpers for visible-range overlap and max selection.
  - Subscribe to lightweight-charts visible logical range changes and recompute highlighted segments.
  - Read and apply the new visible-max style from `useLivePageStore`.

- Modify `frontend/src/state/liveIndicatorsPersistence.ts`
  - Add constants, persisted fields, validation, defaults, and merge behavior for visible-max style.

- Modify `frontend/src/state/livePage.ts`
  - Add the new fields to persistence snapshots.
  - Add `setAskPeakVisibleMaxStyle`.

- Modify `frontend/src/live/indicators/AskPeakConfig.tsx`
  - Add the third `MAStylePicker` row labeled `보이는 영역 최대벽`.

- Modify tests:
  - `frontend/src/live/LiveAskPeakSegments.test.tsx`
  - `frontend/src/state/liveIndicatorsPersistence.test.ts`
  - `frontend/src/state/livePage.test.ts`
  - `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx`
  - `frontend/src/live/indicators/IndicatorPanel.test.tsx`

---

### Task 1: Persist the Third Ask Peak Style

**Files:**
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/state/livePage.ts`
- Test: `frontend/src/state/liveIndicatorsPersistence.test.ts`
- Test: `frontend/src/state/livePage.test.ts`

**Interfaces:**
- Produces:
  - `ASK_PEAK_VISIBLE_MAX_DEFAULT_COLOR: '#EAB308'`
  - `ASK_PEAK_VISIBLE_MAX_DEFAULT_WIDTH: 1 | 2 | 3 | 4`
  - `PersistedIndicators.askPeakVisibleMaxColor: string`
  - `PersistedIndicators.askPeakVisibleMaxLineWidth: 1 | 2 | 3 | 4`
  - `useLivePageStore.getState().setAskPeakVisibleMaxStyle(patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 })`

- [ ] **Step 1: Write failing persistence tests**

Add the new default assertions to the existing `returns defaults for undefined input` test in `frontend/src/state/liveIndicatorsPersistence.test.ts`:

```ts
expect(mergeLiveIndicatorPrefs(undefined)).toEqual({
  movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
  movingAverageEnabled: true,
  foreignNetEnabled: false,
  institutionNetEnabled: false,
  volumeEnabled: true,
  movingAverageHidden: false,
  askPeakEnabled: false,
  askPeakColor: '#1D4ED8',
  askPeakLineWidth: 2,
  askPeakAllPriceColor: '#F97316',
  askPeakAllPriceLineWidth: 1,
  askPeakVisibleMaxColor: '#EAB308',
  askPeakVisibleMaxLineWidth: 3,
  bidPeakEnabled: false,
  bidPeakColor: '#DC2626',
  bidPeakLineWidth: 2,
  bidPeakAllPriceColor: '#F97316',
  bidPeakAllPriceLineWidth: 1,
  quoteTotalsEnabled: true,
  ratioEnabled: true,
  fillStrengthEnabled: true,
  dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
  dailyMovingAverageEnabled: false,
  dailyMovingAverageHidden: false,
});
```

Extend the `mergeLiveIndicatorPrefs — askPeak` tests:

```ts
it('레거시(필드 없음): visible max 기본 #EAB308/3', () => {
  const m = mergeLiveIndicatorPrefs(undefined);
  expect(m.askPeakVisibleMaxColor).toBe('#EAB308');
  expect(m.askPeakVisibleMaxLineWidth).toBe(3);
});

it('visible max 유효값 보존', () => {
  const m = mergeLiveIndicatorPrefs({
    askPeakVisibleMaxColor: '#A855F7',
    askPeakVisibleMaxLineWidth: 4,
  });
  expect(m.askPeakVisibleMaxColor).toBe('#A855F7');
  expect(m.askPeakVisibleMaxLineWidth).toBe(4);
});

it('visible max 이상값 폴백', () => {
  const m = mergeLiveIndicatorPrefs({
    askPeakVisibleMaxColor: 'yellow',
    askPeakVisibleMaxLineWidth: 9,
  });
  expect(m.askPeakVisibleMaxColor).toBe('#EAB308');
  expect(m.askPeakVisibleMaxLineWidth).toBe(3);
});
```

- [ ] **Step 2: Write failing livePage store tests**

Add this describe block to `frontend/src/state/livePage.test.ts` near the existing ask peak style tests:

```ts
describe('useLivePageStore.askPeakVisibleMaxStyle', () => {
  beforeEach(() => {
    localStorage.removeItem('live.indicators.v1');
    useLivePageStore.setState({
      askPeakVisibleMaxColor: '#EAB308',
      askPeakVisibleMaxLineWidth: 3,
    });
  });

  it('setAskPeakVisibleMaxStyle updates color and width independently', () => {
    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ color: '#A855F7' });
    expect(useLivePageStore.getState().askPeakVisibleMaxColor).toBe('#A855F7');
    expect(useLivePageStore.getState().askPeakVisibleMaxLineWidth).toBe(3);

    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ lineWidth: 4 });
    expect(useLivePageStore.getState().askPeakVisibleMaxColor).toBe('#A855F7');
    expect(useLivePageStore.getState().askPeakVisibleMaxLineWidth).toBe(4);
  });

  it('persists visible max style fields in the indicator snapshot', () => {
    useLivePageStore.getState().setAskPeakVisibleMaxStyle({ color: '#A855F7', lineWidth: 4 });
    const raw = JSON.parse(localStorage.getItem('live.indicators.v1') ?? '{}');
    expect(raw.askPeakVisibleMaxColor).toBe('#A855F7');
    expect(raw.askPeakVisibleMaxLineWidth).toBe(4);
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/livePage.test.ts
```

Expected: FAIL because the new fields and setter do not exist.

- [ ] **Step 4: Implement persistence fields**

In `frontend/src/state/liveIndicatorsPersistence.ts`, add constants next to existing ask peak constants:

```ts
export const ASK_PEAK_VISIBLE_MAX_DEFAULT_COLOR = '#EAB308';
export const ASK_PEAK_VISIBLE_MAX_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 3;
```

Add fields to `PersistedIndicators` after `askPeakAllPriceLineWidth`:

```ts
/** 현재 보이는 캔들 영역 안에서 가장 큰 매도 최대벽 강조 색(hex). 기본 #EAB308(노랑). */
askPeakVisibleMaxColor: string;
/** 현재 보이는 캔들 영역 안에서 가장 큰 매도 최대벽 강조 두께. 기본 3. */
askPeakVisibleMaxLineWidth: 1 | 2 | 3 | 4;
```

Add merge validation after `apAllWidth`:

```ts
const apVisibleMaxColor = typeof obj?.askPeakVisibleMaxColor === 'string'
  && HEX_COLOR.test(obj.askPeakVisibleMaxColor as string)
  ? (obj.askPeakVisibleMaxColor as string) : ASK_PEAK_VISIBLE_MAX_DEFAULT_COLOR;
const apVisibleMaxWidth = VALID_LINE_WIDTHS.has(obj?.askPeakVisibleMaxLineWidth as number)
  ? (obj!.askPeakVisibleMaxLineWidth as 1 | 2 | 3 | 4) : ASK_PEAK_VISIBLE_MAX_DEFAULT_WIDTH;
```

Return the fields from `build` after `askPeakAllPriceLineWidth`:

```ts
askPeakVisibleMaxColor: apVisibleMaxColor,
askPeakVisibleMaxLineWidth: apVisibleMaxWidth,
```

- [ ] **Step 5: Implement livePage store fields**

In `frontend/src/state/livePage.ts`, add the setter to `Store` after `setAskPeakAllPriceStyle`:

```ts
setAskPeakVisibleMaxStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
```

Add fields to `snapshotIndicators(get)` after `askPeakAllPriceLineWidth`:

```ts
askPeakVisibleMaxColor: s.askPeakVisibleMaxColor,
askPeakVisibleMaxLineWidth: s.askPeakVisibleMaxLineWidth,
```

Add the setter after `setAskPeakAllPriceStyle`:

```ts
setAskPeakVisibleMaxStyle: (patch) => {
  set((s) => ({
    askPeakVisibleMaxColor: patch.color ?? s.askPeakVisibleMaxColor,
    askPeakVisibleMaxLineWidth: patch.lineWidth ?? s.askPeakVisibleMaxLineWidth,
  }));
  persistIndicators(snapshotIndicators(get));
},
```

- [ ] **Step 6: Run tests and verify they pass**

Run:

```bash
cd frontend && npx vitest run src/state/liveIndicatorsPersistence.test.ts src/state/livePage.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/state/liveIndicatorsPersistence.ts frontend/src/state/livePage.ts frontend/src/state/liveIndicatorsPersistence.test.ts frontend/src/state/livePage.test.ts
git commit -m "feat: persist ask peak visible max style"
```

---

### Task 2: Add the Third Style Control to AskPeakConfig

**Files:**
- Modify: `frontend/src/live/indicators/AskPeakConfig.tsx`
- Test: `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Consumes:
  - `askPeakVisibleMaxColor`
  - `askPeakVisibleMaxLineWidth`
  - `setAskPeakVisibleMaxStyle`
- Produces:
  - A third style row labeled `보이는 영역 최대벽`
  - A style picker button with accessible name `보이는 영역 최대벽 스타일 선택`

- [ ] **Step 1: Write failing component tests**

In `frontend/src/live/indicators/IntraMaxConfigRows.test.tsx`, update the ask peak style test:

```ts
it('AskPeakConfig에 세 매도 최대벽 스타일 컨트롤', () => {
  render(<AskPeakConfig />);
  expect(screen.getByText('체결가격 기준 최대벽')).toBeTruthy();
  expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByText('미체결 포함 최대벽')).toBeTruthy();
  expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByText('보이는 영역 최대벽')).toBeTruthy();
  expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
});
```

In `frontend/src/live/indicators/IndicatorPanel.test.tsx`, update the ask peak panel test:

```ts
it('매도 최대벽 선택 시 스타일 pane(MAStylePicker) 표시', () => {
  render(<IndicatorPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽' }));
  expect(screen.getByRole('button', { name: '체결가격 기준 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '미체결 포함 최대벽 스타일 선택' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '보이는 영역 최대벽 스타일 선택' })).toBeTruthy();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/indicators/IntraMaxConfigRows.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: FAIL because the third row does not exist.

- [ ] **Step 3: Implement AskPeakConfig UI**

In `frontend/src/live/indicators/AskPeakConfig.tsx`, read the new style values:

```ts
const visibleMaxColor = useLivePageStore((s) => s.askPeakVisibleMaxColor);
const visibleMaxLineWidth = useLivePageStore((s) => s.askPeakVisibleMaxLineWidth);
const setVisibleMaxStyle = useLivePageStore((s) => s.setAskPeakVisibleMaxStyle);
```

Add this row after the `미체결 포함 최대벽` row:

```tsx
<div className="flex items-center gap-2">
  <span className="text-sm text-fg">보이는 영역 최대벽</span>
  <MAStylePicker
    color={visibleMaxColor}
    lineWidth={visibleMaxLineWidth}
    onChange={setVisibleMaxStyle}
    label="보이는 영역 최대벽"
  />
</div>
```

- [ ] **Step 4: Run tests and verify they pass**

Run:

```bash
cd frontend && npx vitest run src/live/indicators/IntraMaxConfigRows.test.tsx src/live/indicators/IndicatorPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indicators/AskPeakConfig.tsx frontend/src/live/indicators/IntraMaxConfigRows.test.tsx frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "feat: add visible ask peak style control"
```

---

### Task 3: Add Segment Metadata and Visible-Max Style Selection

**Files:**
- Modify: `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Test: `frontend/src/live/LiveAskPeakSegments.test.tsx`

**Interfaces:**
- Produces:
  - `AskPeakSegment.qty: number`
  - `styleVisibleMaxAskPeakSegments(segments, visibleRange, style): AskPeakSegment[]`
- Consumes:
  - `baselineStyle`
  - `allPriceStyle`
  - new `visibleMaxStyle`

- [ ] **Step 1: Write failing pure helper tests**

Update the import in `frontend/src/live/LiveAskPeakSegments.test.tsx`:

```ts
import {
  buildAskPeakSegments,
  buildAskPeakOverlaySegments,
  styleVisibleMaxAskPeakSegments,
} from './LiveAskPeakSegments';
```

Add assertions to an existing `buildAskPeakSegments` test:

```ts
expect(today.qty).toBe(153125);
```

Add this describe block:

```ts
describe('styleVisibleMaxAskPeakSegments', () => {
  const baseSeg = (overrides: Partial<ReturnType<typeof buildAskPeakSegments>[number]> = {}) => ({
    time0: 10 as ReturnType<typeof buildAskPeakSegments>[number]['time0'],
    time1: 20 as ReturnType<typeof buildAskPeakSegments>[number]['time1'],
    peakTime: 15 as ReturnType<typeof buildAskPeakSegments>[number]['peakTime'],
    price: 100,
    qty: 100,
    label: '100, 0.1k',
    color: '#1D4ED8',
    lineWidth: 2,
    live: false,
    ...overrides,
  });

  it('visible range와 겹치는 세그먼트 중 qty 1개만 강조한다', () => {
    const out = styleVisibleMaxAskPeakSegments(
      [
        baseSeg({ time0: 0 as never, time1: 5 as never, qty: 1000, color: '#1D4ED8' }),
        baseSeg({ time0: 10 as never, time1: 20 as never, qty: 300, color: '#1D4ED8' }),
        baseSeg({ time0: 15 as never, time1: 25 as never, qty: 500, color: '#F97316', lineWidth: 1 }),
      ],
      { from: 12, to: 22 },
      { color: '#EAB308', lineWidth: 3 },
    );

    expect(out.map((s) => ({ qty: s.qty, color: s.color, lineWidth: s.lineWidth }))).toEqual([
      { qty: 1000, color: '#1D4ED8', lineWidth: 2 },
      { qty: 300, color: '#1D4ED8', lineWidth: 2 },
      { qty: 500, color: '#EAB308', lineWidth: 3 },
    ]);
  });

  it('visible range가 없으면 원래 스타일을 유지한다', () => {
    const input = [baseSeg({ qty: 500 })];
    const out = styleVisibleMaxAskPeakSegments(input, null, { color: '#EAB308', lineWidth: 3 });
    expect(out).toEqual(input);
  });

  it('동률이면 먼저 나온 visible 세그먼트를 강조한다', () => {
    const out = styleVisibleMaxAskPeakSegments(
      [
        baseSeg({ time0: 10 as never, time1: 20 as never, qty: 500, price: 100 }),
        baseSeg({ time0: 12 as never, time1: 22 as never, qty: 500, price: 110 }),
      ],
      { from: 10, to: 22 },
      { color: '#EAB308', lineWidth: 3 },
    );
    expect(out[0]).toMatchObject({ color: '#EAB308', lineWidth: 3, price: 100 });
    expect(out[1]).toMatchObject({ color: '#1D4ED8', lineWidth: 2, price: 110 });
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx
```

Expected: FAIL because `qty` and `styleVisibleMaxAskPeakSegments` do not exist.

- [ ] **Step 3: Add `qty` to segment type and builder**

In `frontend/src/chart/AskPeakSegmentsPrimitive.ts`, add to `AskPeakSegment`:

```ts
/** 비교용 물량. 현재 보이는 영역 내 최대벽 강조 선택에 사용하며 직접 렌더링하지 않는다. */
qty: number;
```

In `frontend/src/live/LiveAskPeakSegments.tsx`, add `qty` to the object pushed by `buildAskPeakSegments`:

```ts
qty: peakQty,
```

- [ ] **Step 4: Add pure visible max styler**

In `frontend/src/live/LiveAskPeakSegments.tsx`, add these types and helpers near `AskPeakLineStyle`:

```ts
type VisibleTimeRange = { from: number; to: number } | null;

function segmentOverlapsVisibleRange(segment: AskPeakSegment, visibleRange: VisibleTimeRange): boolean {
  if (!visibleRange) return false;
  const from = Math.min(visibleRange.from, visibleRange.to);
  const to = Math.max(visibleRange.from, visibleRange.to);
  const s0 = segment.time0 as unknown as number;
  const s1 = segment.time1 as unknown as number;
  return Math.max(s0, from) <= Math.min(s1, to);
}

export function styleVisibleMaxAskPeakSegments(
  segments: readonly AskPeakSegment[],
  visibleRange: VisibleTimeRange,
  style: AskPeakLineStyle,
): AskPeakSegment[] {
  if (!visibleRange || segments.length === 0) return [...segments];
  let bestIndex = -1;
  let bestQty = Number.NEGATIVE_INFINITY;
  segments.forEach((segment, index) => {
    if (!segmentOverlapsVisibleRange(segment, visibleRange)) return;
    if (segment.qty > bestQty) {
      bestQty = segment.qty;
      bestIndex = index;
    }
  });
  if (bestIndex === -1) return [...segments];
  return segments.map((segment, index) => (
    index === bestIndex
      ? { ...segment, color: style.color, lineWidth: style.lineWidth }
      : segment
  ));
}
```

- [ ] **Step 5: Run tests and verify they pass**

Run:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/AskPeakSegmentsPrimitive.ts frontend/src/live/LiveAskPeakSegments.tsx frontend/src/live/LiveAskPeakSegments.test.tsx
git commit -m "feat: select visible max ask peak segment"
```

---

### Task 4: Wire Visible Range Updates Into the Live Overlay

**Files:**
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Test: run existing live chart tests

**Interfaces:**
- Consumes:
  - `AskPeakSegmentsPrimitive.chartApi()`
  - `chart.timeScale().getVisibleRange()`
  - `chart.timeScale().subscribeVisibleLogicalRangeChange(...)`
  - `styleVisibleMaxAskPeakSegments(...)`

- [ ] **Step 1: Refactor update calculation into a local callback**

In `frontend/src/live/LiveAskPeakSegments.tsx`, update imports:

```ts
import { memo, useCallback, useEffect, useRef } from 'react';
```

Inside `LiveAskPeakSegments`, read the new store fields:

```ts
const visibleMaxColor = useLivePageStore((s) => s.askPeakVisibleMaxColor);
const visibleMaxLineWidth = useLivePageStore((s) => s.askPeakVisibleMaxLineWidth);
```

Add this callback before the update effect:

```ts
const updateSegments = useCallback(() => {
  const prim = primRef.current;
  if (!prim) return;
  if (!enabled) {
    prim.setSegments([]);
    return;
  }
  const rawSegments = buildAskPeakOverlaySegments({
    dayAskPeaks,
    todayAllPriceAskPeak,
    segments,
    candles,
    axis,
    todayKst,
    baselineStyle: { color, lineWidth },
    allPriceStyle: { color: allPriceColor, lineWidth: allPriceLineWidth },
    intraMax,
    showAllPrices,
    allPriceRankLimit: allPriceRankLimit as 1 | 2 | 3,
  });
  const visibleRange = prim.chartApi()?.timeScale().getVisibleRange() ?? null;
  prim.setSegments(styleVisibleMaxAskPeakSegments(
    rawSegments,
    visibleRange,
    { color: visibleMaxColor, lineWidth: visibleMaxLineWidth },
  ));
}, [
  dayAskPeaks,
  todayAllPriceAskPeak,
  segments,
  candles,
  axis,
  todayKst,
  color,
  lineWidth,
  allPriceColor,
  allPriceLineWidth,
  visibleMaxColor,
  visibleMaxLineWidth,
  enabled,
  intraMax,
  showAllPrices,
  allPriceRankLimit,
]);
```

- [ ] **Step 2: Replace the existing update effect**

Replace the current “갱신” effect body with:

```ts
useEffect(() => {
  updateSegments();
}, [updateSegments, series]);
```

- [ ] **Step 3: Subscribe to visible range changes**

Add this effect after the update effect:

```ts
useEffect(() => {
  const prim = primRef.current;
  const chart = prim?.chartApi();
  if (!chart) return;
  const timeScale = chart.timeScale();
  const handler = () => {
    updateSegments();
  };
  timeScale.subscribeVisibleLogicalRangeChange(handler);
  updateSegments();
  return () => {
    timeScale.unsubscribeVisibleLogicalRangeChange(handler);
  };
}, [series, updateSegments]);
```

Use `subscribeVisibleLogicalRangeChange` as the notification source because the app already reasons about visible logical range for chart viewport changes. Use `getVisibleRange()` inside the handler because `AskPeakSegment.time0/time1` are actual chart `Time` values, not logical indexes.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd frontend && npx vitest run src/live/LiveAskPeakSegments.test.tsx src/live/LiveChartRoot.test.tsx src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveAskPeakSegments.tsx
git commit -m "feat: update ask peak highlight on viewport changes"
```

---

### Task 5: Final Verification and Build

**Files:**
- No source edits unless verification finds a regression.

**Interfaces:**
- Consumes all prior tasks.
- Produces verified frontend behavior.

- [ ] **Step 1: Run all affected frontend tests**

Run:

```bash
cd frontend && npx vitest run \
  src/live/LiveAskPeakSegments.test.tsx \
  src/state/liveIndicatorsPersistence.test.ts \
  src/state/livePage.test.ts \
  src/live/indicators/IntraMaxConfigRows.test.tsx \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/LiveChartRoot.test.tsx \
  src/live/LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 3: Optional browser QA if dev servers are running**

If the backend and frontend dev servers are already running, open `/live`, enable `당일 매도 최대벽`, and verify:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B console --errors
```

Expected: no console errors. When the chart is panned or zoomed, exactly one visible ask peak segment uses the `보이는 영역 최대벽` style.

- [ ] **Step 4: Commit verification-only docs if changed**

If this plan is the only remaining uncommitted file, do not include source commits here. If verification required plan corrections, commit only this plan file:

```bash
git add docs/superpowers/plans/2026-06-24-ask-peak-visible-max-highlight.md
git commit -m "docs: plan ask peak visible max highlight"
```

---

## Self-Review

- Spec coverage: The plan covers the third style picker, persistence, one combined visible max across baseline and all-price ask peak segments, visible viewport overlap, and focused verification.
- Placeholder scan: No placeholder requirements remain; every implementation step names the exact files, fields, functions, and test commands.
- Type consistency: `askPeakVisibleMaxColor`, `askPeakVisibleMaxLineWidth`, `setAskPeakVisibleMaxStyle`, `qty`, and `styleVisibleMaxAskPeakSegments` are introduced before later tasks consume them.
