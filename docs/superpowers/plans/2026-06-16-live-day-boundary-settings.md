# Live Day Boundary Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global `/live` settings for date boundary vertical lines: on/off, color, and line width.

**Architecture:** Store the new preferences in the existing global `chartPrefs` store and `hoga.chart.prefs.v1` persistence path. Reuse `MAStylePicker` in the Settings modal for color and width, and have `DayBoundaryOverlay` self-gate and render from the stored prefs.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Testing Library, lightweight-charts.

---

## File Structure

- Modify `frontend/src/state/chartPrefs.ts`
  - Add `dayBoundaryEnabled` to `CHART_TOGGLES`.
  - Add explicit style fields `dayBoundaryColor` and `dayBoundaryLineWidth`.
  - Add `setDayBoundaryStyle`.
- Modify `frontend/src/state/chartPrefsPersistence.ts`
  - Merge and persist the style fields with validation.
- Modify `frontend/src/state/chartPrefs.test.ts`
  - Cover defaults, merge validation, and style setter behavior.
- Modify `frontend/src/live/LiveSettingsSections.tsx`
  - Render the date boundary style row under the chart settings.
- Modify `frontend/src/live/LiveSettingsSections.test.tsx`
  - Assert the toggle and style picker are visible.
- Modify `frontend/src/chart/DayBoundaryOverlay.tsx`
  - Read prefs, gate rendering, apply color and width.
- Create `frontend/src/chart/DayBoundaryOverlay.test.tsx`
  - Component-level coverage for disabled and styled rendering.

## Task 1: Chart Prefs Store and Persistence

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/state/chartPrefsPersistence.ts`
- Test: `frontend/src/state/chartPrefs.test.ts`

- [ ] **Step 1: Write failing tests for defaults, persistence, and setter**

Append these tests to `frontend/src/state/chartPrefs.test.ts`:

```ts
describe('날짜 구분선 설정', () => {
  it('defaults to current visual behavior', () => {
    expect(DEFAULT_PREFS.dayBoundaryEnabled).toBe(true);
    expect(DEFAULT_PREFS.dayBoundaryColor).toBe('#64748B');
    expect(DEFAULT_PREFS.dayBoundaryLineWidth).toBe(1);
  });

  it('mergePrefs preserves valid day boundary style values', () => {
    const merged = mergePrefs({
      dayBoundaryEnabled: false,
      dayBoundaryColor: '#EF4444',
      dayBoundaryLineWidth: 3,
    });

    expect(merged.dayBoundaryEnabled).toBe(false);
    expect(merged.dayBoundaryColor).toBe('#EF4444');
    expect(merged.dayBoundaryLineWidth).toBe(3);
  });

  it('mergePrefs falls back for invalid day boundary style values', () => {
    const merged = mergePrefs({
      dayBoundaryColor: 'red',
      dayBoundaryLineWidth: 9,
    });

    expect(merged.dayBoundaryColor).toBe(DEFAULT_PREFS.dayBoundaryColor);
    expect(merged.dayBoundaryLineWidth).toBe(DEFAULT_PREFS.dayBoundaryLineWidth);
  });

  it('setDayBoundaryStyle updates color and width independently', () => {
    useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#22C55E' });
    expect(useChartPrefsStore.getState().dayBoundaryColor).toBe('#22C55E');
    expect(useChartPrefsStore.getState().dayBoundaryLineWidth).toBe(1);

    useChartPrefsStore.getState().setDayBoundaryStyle({ lineWidth: 4 });
    expect(useChartPrefsStore.getState().dayBoundaryColor).toBe('#22C55E');
    expect(useChartPrefsStore.getState().dayBoundaryLineWidth).toBe(4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run src/state/chartPrefs.test.ts
```

Expected: FAIL with TypeScript/test errors for missing `dayBoundaryEnabled`, `dayBoundaryColor`, `dayBoundaryLineWidth`, and `setDayBoundaryStyle`.

- [ ] **Step 3: Add prefs and setter to `chartPrefs.ts`**

In `frontend/src/state/chartPrefs.ts`, add this registry item to `CHART_TOGGLES` after `auctionWindowMask`:

```ts
  {
    key: 'dayBoundaryEnabled',
    label: '날짜 구분선',
    description: '분봉 차트에서 거래일이 바뀌는 지점에 세로 점선을 표시합니다.',
    default: true,
  },
```

Add these constants after `DEFAULT_PREFS` is created:

```ts
export const DAY_BOUNDARY_COLOR_DEFAULT = '#64748B';
export const DAY_BOUNDARY_LINE_WIDTH_DEFAULT: 1 | 2 | 3 | 4 = 1;
export type DayBoundaryLineWidth = 1 | 2 | 3 | 4;
```

Extend `ChartViewPrefs` so it includes explicit style fields:

```ts
export type ChartViewPrefs =
  & { [K in ChartToggleKey]: boolean }
  & { [K in NumericPrefKey]: number }
  & {
    dayBoundaryColor: string;
    dayBoundaryLineWidth: DayBoundaryLineWidth;
  };
```

Update `DEFAULT_PREFS`:

```ts
export const DEFAULT_PREFS: ChartViewPrefs = {
  ...TOGGLE_DEFAULTS,
  ...NUMERIC_DEFAULTS,
  dayBoundaryColor: DAY_BOUNDARY_COLOR_DEFAULT,
  dayBoundaryLineWidth: DAY_BOUNDARY_LINE_WIDTH_DEFAULT,
};
```

Extend `ChartPrefsStore`:

```ts
type ChartPrefsStore = ChartViewPrefs & {
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  setDayBoundaryStyle: (patch: { color?: string; lineWidth?: DayBoundaryLineWidth }) => void;
  resetToDefaults: () => void;
};
```

Add the setter inside `create<ChartPrefsStore>`:

```ts
  setDayBoundaryStyle: (patch) =>
    set((s) => ({
      dayBoundaryColor: patch.color ?? s.dayBoundaryColor,
      dayBoundaryLineWidth: patch.lineWidth ?? s.dayBoundaryLineWidth,
    })),
```

- [ ] **Step 4: Add merge validation to `chartPrefsPersistence.ts`**

Update the import:

```ts
import {
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  DEFAULT_PREFS,
  type ChartViewPrefs,
  type DayBoundaryLineWidth,
} from './chartPrefs';
```

Add helpers above `mergePrefs`:

```ts
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DAY_BOUNDARY_WIDTHS = new Set([1, 2, 3, 4]);

function isDayBoundaryLineWidth(v: unknown): v is DayBoundaryLineWidth {
  return typeof v === 'number' && DAY_BOUNDARY_WIDTHS.has(v);
}
```

Add this block before `return out;` in `mergePrefs`:

```ts
  if (typeof obj.dayBoundaryColor === 'string' && HEX_COLOR_RE.test(obj.dayBoundaryColor)) {
    out.dayBoundaryColor = obj.dayBoundaryColor.toUpperCase();
  }
  if (isDayBoundaryLineWidth(obj.dayBoundaryLineWidth)) {
    out.dayBoundaryLineWidth = obj.dayBoundaryLineWidth;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
npx vitest run src/state/chartPrefs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefsPersistence.ts frontend/src/state/chartPrefs.test.ts
git commit -m "feat(live): add day boundary chart prefs"
```

## Task 2: Settings Modal UI

**Files:**
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`

- [ ] **Step 1: Write failing settings UI tests**

Append these tests to `frontend/src/live/LiveSettingsSections.test.tsx`:

```tsx
  it('차트 설정에 날짜 구분선 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-dayBoundaryEnabled')).toBeTruthy();
  });

  it('차트 설정에 날짜 구분선 스타일 선택 버튼이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByRole('button', { name: '날짜 구분선 스타일 선택' })).toBeTruthy();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run src/live/LiveSettingsSections.test.tsx
```

Expected: FAIL because the style picker is not rendered yet.

- [ ] **Step 3: Render the style picker in `LiveSettingsSections.tsx`**

Add imports:

```ts
import { useChartPrefsStore } from '../state/chartPrefs';
import MAStylePicker from './indicators/MAStylePicker';
```

Add this component above `DataSourceDetail`:

```tsx
function DayBoundaryStyleRow() {
  const color = useChartPrefsStore((s) => s.dayBoundaryColor);
  const lineWidth = useChartPrefsStore((s) => s.dayBoundaryLineWidth);
  const setStyle = useChartPrefsStore((s) => s.setDayBoundaryStyle);

  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">날짜 구분선 스타일</div>
        <div className="text-fg-dim text-xs mt-0.5">
          거래일 경계를 표시하는 세로 점선의 색상과 두께입니다.
        </div>
      </div>
      <MAStylePicker color={color} lineWidth={lineWidth} onChange={setStyle} label="날짜 구분선" />
    </div>
  );
}
```

Replace `CategoryDetail` with:

```tsx
function CategoryDetail({ category }: { category: ChartToggleCategory }) {
  const keys = CHART_TOGGLES
    .filter((t) => categoryOf(t) === category)
    .map((t) => t.key);
  return (
    <>
      <IndicatorPrefRows toggleKeys={keys} />
      {category === 'chart' && (
        <>
          <div className="border-b border-border my-2" />
          <DayBoundaryStyleRow />
        </>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run the settings UI tests**

Run:

```bash
npx vitest run src/live/LiveSettingsSections.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src/live/LiveSettingsSections.tsx frontend/src/live/LiveSettingsSections.test.tsx
git commit -m "feat(live): expose day boundary style settings"
```

## Task 3: Day Boundary Overlay Rendering

**Files:**
- Modify: `frontend/src/chart/DayBoundaryOverlay.tsx`
- Create: `frontend/src/chart/DayBoundaryOverlay.test.tsx`

- [ ] **Step 1: Write failing overlay tests**

Create `frontend/src/chart/DayBoundaryOverlay.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { VirtualAxis } from '../util/virtualAxis';

function makeChart() {
  const subscribers = new Set<() => void>();
  return {
    timeScale: () => ({
      timeToCoordinate: vi.fn(() => 120),
      subscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.add(cb)),
      unsubscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.delete(cb)),
    }),
  };
}

const axis = {
  segments: [
    { date: '20260615' },
    { date: '20260616' },
  ],
  dayBoundaries: [
    { date: '20260616', virtualStart: 1_800_000 },
  ],
} as unknown as VirtualAxis;

describe('DayBoundaryOverlay', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  afterEach(cleanup);

  it('renders no boundary when disabled', () => {
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    render(<DayBoundaryOverlay chart={makeChart() as never} axis={axis} />);

    expect(screen.queryByTestId('day-boundary-20260616')).toBeNull();
  });

  it('applies configured color and line width', () => {
    useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#EF4444', lineWidth: 3 });
    render(<DayBoundaryOverlay chart={makeChart() as never} axis={axis} />);

    const boundary = screen.getByTestId('day-boundary-20260616');
    expect(boundary.style.width).toBe('3px');
    expect(boundary.style.backgroundImage).toContain('#EF4444');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vitest run src/chart/DayBoundaryOverlay.test.tsx
```

Expected: FAIL because `DayBoundaryOverlay` does not read prefs, does not expose `data-testid`, and still uses fixed 1px/token styling.

- [ ] **Step 3: Update `DayBoundaryOverlay.tsx`**

Remove the token imports and constant:

```ts
import { resolveTokens } from '../util/tokens';

const TOKEN_SPEC = { boundary: ['--fg-dimmer', '#64748B'] } as const;
```

Add this import:

```ts
import { useActivePrefs } from '../state/chartPrefs';
```

Inside `DayBoundaryOverlay`, after the `useEffect` block and before the segment length guard, add:

```ts
  const enabled = useActivePrefs((prefs) => prefs.dayBoundaryEnabled);
  const color = useActivePrefs((prefs) => prefs.dayBoundaryColor);
  const lineWidth = useActivePrefs((prefs) => prefs.dayBoundaryLineWidth);

  if (!enabled) return null;
```

Remove:

```ts
  const { boundary } = resolveTokens(TOKEN_SPEC);
```

Update the boundary element:

```tsx
          <div
            key={b.date}
            data-day-boundary={b.date}
            data-testid={`day-boundary-${b.date}`}
            className="absolute top-0 bottom-0"
            style={{
              width: `${lineWidth}px`,
              transform: `translateX(${b.x as number}px)`,
              backgroundImage: `repeating-linear-gradient(to bottom, ${color} 0 3px, transparent 3px 6px)`,
            }}
          />
```

- [ ] **Step 4: Run the overlay tests**

Run:

```bash
npx vitest run src/chart/DayBoundaryOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add frontend/src/chart/DayBoundaryOverlay.tsx frontend/src/chart/DayBoundaryOverlay.test.tsx
git commit -m "feat(live): render configurable day boundaries"
```

## Task 4: Integrated Verification

**Files:**
- No source files expected.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run src/state/chartPrefs.test.ts src/live/LiveSettingsSections.test.tsx src/chart/DayBoundaryOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run production build**

Run:

```bash
npm run build
```

Expected: PASS. Vite may print the existing chunk-size warning; that warning is acceptable for this task.

- [ ] **Step 3: Check git status**

Run:

```bash
git status --short
```

Expected: no uncommitted source changes after the task commits.

## Self-Review

- Spec coverage: The plan implements global on/off, color, width, persistence, default behavior, and settings UI placement.
- Scope check: The plan touches only chart prefs, settings UI, and the existing day boundary overlay. It does not add tab-specific settings or new chart behavior for D/W/M.
- Type consistency: The chosen names are `dayBoundaryEnabled`, `dayBoundaryColor`, `dayBoundaryLineWidth`, and `setDayBoundaryStyle` throughout all tasks.
