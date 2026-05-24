# FillStrength 누적 라인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 체결강도 (FillStrength) pane에 당일 누적 매수−매도 라인(Cumulative Net Fill, 체결강도 누적)을 invisible overlay scale로 추가하고, per-tab `fillStrengthCumulative` 토글로 끄고 켤 수 있게 한다.

**Architecture:** ADR-0027의 `CHART_TOGGLES` 선언형 registry에 entry 1줄 추가. registry에 optional `category: 'chart' | 'indicators'` 필드를 도입해 같은 registry가 SettingsModal(차트 카테고리)과 IndicatorsSection(보조지표 카테고리) 두 UI surface를 category 필터로 동시 driving. Projector는 in-session(누적합)/in-viewport(emit) predicate를 분리해 줌인 시 09:00 기준 baseline을 보존.

**Tech Stack:** React 19 + TypeScript + Zustand + lightweight-charts v5 + Vitest + Tailwind.

**Spec:** [2026-05-24-fill-strength-cumulative-line-design.md](../specs/2026-05-24-fill-strength-cumulative-line-design.md)

**Domain terms touched:** `FillStrength`, `Cumulative Net Fill (체결강도 누적)` — both added to CONTEXT.md in the grill phase prior to this plan.

---

## File Structure

신규 파일 1개, 수정 파일 5개. 책임 분리:

| 파일 | 책임 |
|---|---|
| `frontend/src/replay/settings/ToggleRow.tsx` (신규) | 재사용 가능한 toggle row 컴포넌트. 현재 `SettingsModal.tsx` 내부에 inline 정의돼 있는 `ToggleRow`를 추출해 양쪽 카테고리 surface에서 import |
| `frontend/src/state/chartPrefs.ts` | `CHART_TOGGLES` entry shape에 optional `category` 필드 추가 + `fillStrengthCumulative` entry 1줄 추가. 나머지 (`ChartViewPrefs` 타입, `DEFAULT_PREFS`, persistence) 모두 derive |
| `frontend/src/replay/SettingsModal.tsx` | `ToggleRow` 추출본을 import. 차트 카테고리 루프를 `category === 'chart'`(default 포함) 필터링 |
| `frontend/src/replay/settings/IndicatorsSection.tsx` | "FILL STRENGTH" 서브헤더 추가 + `CHART_TOGGLES.filter((t) => t.category === 'indicators').map` 으로 ToggleRow 렌더 |
| `frontend/src/chart/projectors/fillStrength.ts` | `projectCumulativeDelta` 함수, `FillStrengthPaneContext` 타입, `useFillStrengthContext` 훅, `TOKEN_SPEC`에 `cumulative`/`cumulativeBaseline` 추가, `FILL_STRENGTH_SPEC.series[]`에 3번째 LineSeries 추가, `useContext` 연결 |
| `frontend/src/chart/projectors/fillStrength.test.ts` | `projectCumulativeDelta` 단위 테스트 확장 |

Test 파일 추가:
| 파일 | 책임 |
|---|---|
| `frontend/src/replay/settings/IndicatorsSection.test.tsx` | 신규 toggle 렌더링 + 클릭 동작 + "FILL STRENGTH" 서브헤더 케이스 추가 |
| `frontend/src/state/tabsPersistence.test.ts` | `fillStrengthCumulative` 누락/오타입/유효값 3 케이스 추가 (registry-driven 이므로 별도 코드는 없지만 회귀 보장) |
| `frontend/src/state/chartPrefs.test.ts` | `category` 메타데이터 보존 검증 1 케이스 |

---

### Task 1: Extract `ToggleRow` to shared module

**Files:**
- Create: `frontend/src/replay/settings/ToggleRow.tsx`
- Modify: `frontend/src/replay/SettingsModal.tsx` (remove inline definition, import shared)

ToggleRow는 Task 4에서 IndicatorsSection도 임포트해 쓰기 위해 먼저 추출. 행위 변경 없음 — 순수 이동 + 단일 export.

- [ ] **Step 1: Create the shared ToggleRow file**

Create `frontend/src/replay/settings/ToggleRow.tsx`:

```tsx
/** Single binary toggle row used inside Settings modal sections.
 *  Stateless — owner passes the current checked value and a click handler.
 *  Extracted from SettingsModal so both the "차트" auto-rendered loop and
 *  the "보조지표" IndicatorsSection can share one source. */
export default function ToggleRow({
  label,
  description,
  checked,
  onToggle,
  testId,
}: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  /** Optional data-testid override. SettingsModal/IndicatorsSection pass
   *  `settings-toggle-{key}` for registry-driven rows. */
  testId?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2" data-testid={testId}>
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">{label}</div>
        <div className="text-fg-dim text-xs mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onToggle}
        className={
          checked
            ? 'relative inline-flex h-5 w-9 items-center rounded-full bg-accent transition-colors'
            : 'relative inline-flex h-5 w-9 items-center rounded-full bg-bg-input-hover transition-colors'
        }
      >
        <span
          className={
            checked
              ? 'inline-block h-4 w-4 transform rounded-full bg-accent-fg translate-x-[18px] transition-transform'
              : 'inline-block h-4 w-4 transform rounded-full bg-fg-dim translate-x-[2px] transition-transform'
          }
        />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Remove inline ToggleRow from SettingsModal and import the shared one**

In `frontend/src/replay/SettingsModal.tsx`:

1. Delete lines 20-59 (the inline `ToggleRow` function).
2. Add an import near the top, after the `IndicatorsSection` import (line 10):

```tsx
import ToggleRow from './settings/ToggleRow';
```

3. Update the call site in the `CHART_TOGGLES.map` block (around line 266-277) — the existing JSX should keep the same prop set; the only change is now `<ToggleRow ... testId={\`settings-toggle-${key}\`} />`:

```tsx
{CHART_TOGGLES.map((toggle) => {
  const key: ChartToggleKey = toggle.key;
  return (
    <ToggleRow
      key={key}
      label={toggle.label}
      description={toggle.description}
      checked={prefs[key]}
      onToggle={() => setToggle(activeTabId, key, !prefs[key])}
      testId={`settings-toggle-${key}`}
    />
  );
})}
```

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `cd frontend && npm test -- --run src/replay`
Expected: PASS (all prior settings/IndicatorsSection tests). ToggleRow extraction is pure refactor.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/replay/settings/ToggleRow.tsx frontend/src/replay/SettingsModal.tsx
git commit -m "refactor(settings): extract ToggleRow to shared module

ToggleRow was defined inline inside SettingsModal but is about to be
consumed by IndicatorsSection too (for the FillStrength cumulative
toggle). Pure move — same markup, same props, opt-in testId."
```

---

### Task 2: Add `category` field + `fillStrengthCumulative` entry to `CHART_TOGGLES`

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts:10-26` (CHART_TOGGLES + ChartToggleKey)
- Modify: `frontend/src/state/chartPrefs.test.ts` (add category-preservation test)
- Modify: `frontend/src/state/tabsPersistence.test.ts` (add roundtrip tests for new key)

Per ADR-0027 the registry is the single source of truth — adding a toggle is one entry, and the type / default / persistence / setter all derive. `category` becomes a new optional metadata field.

- [ ] **Step 1: Write the failing persistence roundtrip test**

In `frontend/src/state/tabsPersistence.test.ts`, find the `describe('mergePrefs', ...)` block (the existing test file uses this structure — check line ~110 for the `auctionWindowMask` test). Add three new test cases at the same nesting level:

```ts
  it('fillStrengthCumulative missing → defaults to true', () => {
    const merged = mergePrefs({}, DEFAULT_PREFS, CHART_TOGGLES.map((t) => t.key), CHART_NUMERIC_PREFS);
    expect(merged.fillStrengthCumulative).toBe(true);
  });

  it('fillStrengthCumulative wrong type → falls back to default', () => {
    const merged = mergePrefs(
      { fillStrengthCumulative: 'yes' as never },
      DEFAULT_PREFS,
      CHART_TOGGLES.map((t) => t.key),
      CHART_NUMERIC_PREFS,
    );
    expect(merged.fillStrengthCumulative).toBe(true);
  });

  it('fillStrengthCumulative explicit false → preserved', () => {
    const merged = mergePrefs(
      { fillStrengthCumulative: false },
      DEFAULT_PREFS,
      CHART_TOGGLES.map((t) => t.key),
      CHART_NUMERIC_PREFS,
    );
    expect(merged.fillStrengthCumulative).toBe(false);
  });
```

If imports at top of file don't already pull `CHART_TOGGLES` / `CHART_NUMERIC_PREFS` from `./chartPrefs`, add them now.

- [ ] **Step 2: Write the category-preservation test**

In `frontend/src/state/chartPrefs.test.ts`, add:

```ts
  it('fillStrengthCumulative entry carries category="indicators"', () => {
    const entry = CHART_TOGGLES.find((t) => t.key === 'fillStrengthCumulative');
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('indicators');
  });

  it('pre-existing toggles have category undefined (default = chart)', () => {
    const auction = CHART_TOGGLES.find((t) => t.key === 'auctionWindowMask');
    expect(auction).toBeDefined();
    expect(auction?.category).toBeUndefined();
  });
```

Add the import at the top if missing: `import { CHART_TOGGLES } from './chartPrefs';`

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npm test -- --run src/state/tabsPersistence.test.ts src/state/chartPrefs.test.ts`
Expected: 5 FAIL (key not in registry → defaults missing; category field doesn't exist).

- [ ] **Step 4: Add the `category` field to the entry shape and the new entry**

In `frontend/src/state/chartPrefs.ts`, replace the `CHART_TOGGLES` block at lines 10-24 with:

```ts
export const CHART_TOGGLES = [
  {
    key: 'auctionWindowMask',
    label: '호가비 동시호가 마스킹',
    description: '15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.',
    default: true,
  },
  {
    key: 'ratioOutlierFilterEnabled',
    label: '호가비 극단값 필터',
    description:
      '한쪽 호가가 임계 배수를 넘으면 그 시점의 호가비를 0 으로 마스킹합니다. (오토스케일을 잡아먹는 스파이크 제거)',
    default: true,
  },
  {
    key: 'fillStrengthCumulative',
    label: '체결강도 — 당일 누적',
    description:
      '체결강도 pane에 당일 누적 매수−매도 라인(체결강도 누적)을 표시합니다. 거래일마다 0에서 다시 시작.',
    default: true,
    category: 'indicators',
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

/** UI surface a toggle belongs to. Unset entries default to 'chart' (the
 *  SettingsModal's "차트" category). New indicator-scoped toggles set
 *  'indicators' so IndicatorsSection picks them up automatically. */
export type ChartToggleCategory = 'chart' | 'indicators';
```

Why `as const` (vs the ADR-0027 sibling's `as const satisfies readonly NumericPrefDef[]`): the toggle shape carries an optional field that can have one of two literal values OR be absent. Forcing this through `satisfies` requires a discriminated-union def type that yields no narrowing win. `as const` alone preserves the literal types we need.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npm test -- --run src/state/tabsPersistence.test.ts src/state/chartPrefs.test.ts`
Expected: All PASS. The `mergePrefs` loop iterates `toggleKeys` and reads `p[key]`, so the new key roundtrips automatically. The `DEFAULT_PREFS = { ...TOGGLE_DEFAULTS, ... }` spread now includes `fillStrengthCumulative: true`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefs.test.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(prefs): add fillStrengthCumulative toggle + category metadata

CHART_TOGGLES gains an optional category field ('chart' | 'indicators',
default 'chart') so the same registry can drive two Settings surfaces.
New entry fillStrengthCumulative (default true, category 'indicators')
will be picked up by IndicatorsSection in a follow-up task.

Per ADR-0027 the type, default, persistence and setter all derive from
the registry — no edits in tabs.ts or tabsPersistence.ts production
code; only test fixtures updated."
```

---

### Task 3: Filter `CHART_TOGGLES` by `category === 'chart'` in SettingsModal

**Files:**
- Modify: `frontend/src/replay/SettingsModal.tsx` (filter the map)
- Modify: `frontend/src/replay/SettingsModal.test.tsx` (new test) — create if doesn't exist

`SettingsModal`'s 차트 카테고리 루프currently renders all `CHART_TOGGLES`. Filter to only `category === undefined || category === 'chart'`.

- [ ] **Step 1: Check whether SettingsModal.test.tsx exists**

Run: `ls frontend/src/replay/SettingsModal.test.tsx 2>/dev/null && echo EXISTS || echo MISSING`

If MISSING, create it with the test below. If EXISTS, add the test to the existing file.

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/replay/SettingsModal.test.tsx (create if missing)
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import SettingsModal from './SettingsModal';
import { useTabsStore } from '../state/tabs';

describe('SettingsModal — category filtering', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('차트 category does NOT render indicator-scoped toggles', () => {
    render(<SettingsModal onClose={() => {}} />);
    // Default category = 'chart'. fillStrengthCumulative is category='indicators',
    // so its toggle must not appear here.
    expect(screen.queryByTestId('settings-toggle-fillStrengthCumulative')).toBeNull();
    // Pre-existing chart-scoped toggles still appear.
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/replay/SettingsModal.test.tsx`
Expected: FAIL (the indicators-scoped toggle is currently rendered too — `queryByTestId` returns truthy).

- [ ] **Step 4: Implement the filter**

In `frontend/src/replay/SettingsModal.tsx`, find the `CHART_TOGGLES.map(...)` block (around line 266 after Task 1's edits) and change it to:

```tsx
{CHART_TOGGLES.filter((t) => (t.category ?? 'chart') === 'chart').map((toggle) => {
  const key: ChartToggleKey = toggle.key;
  return (
    <ToggleRow
      key={key}
      label={toggle.label}
      description={toggle.description}
      checked={prefs[key]}
      onToggle={() => setToggle(activeTabId, key, !prefs[key])}
      testId={`settings-toggle-${key}`}
    />
  );
})}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- --run src/replay/SettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/replay/SettingsModal.tsx frontend/src/replay/SettingsModal.test.tsx
git commit -m "feat(settings): filter CHART_TOGGLES by category in chart surface

차트 카테고리는 category undefined or 'chart' 인 entry만 렌더.
'indicators' category entry는 IndicatorsSection이 별도로 픽업
(다음 task)."
```

---

### Task 4: Render indicator-scoped toggles in IndicatorsSection

**Files:**
- Modify: `frontend/src/replay/settings/IndicatorsSection.tsx`
- Modify: `frontend/src/replay/settings/IndicatorsSection.test.tsx`

Add a "FILL STRENGTH" 서브헤더 and a registry-driven loop that picks up any `category === 'indicators'` toggles.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/replay/settings/IndicatorsSection.test.tsx`:

```tsx
  it('renders the FILL STRENGTH subheader and the cumulative toggle (default on)', () => {
    render(<IndicatorsSection />);
    expect(screen.getByText('Fill Strength')).toBeTruthy();
    const toggle = screen.getByTestId('settings-toggle-fillStrengthCumulative');
    expect(toggle).toBeTruthy();
    const sw = toggle.querySelector('[role="switch"]');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
  });

  it('clicking the fillStrengthCumulative toggle flips the store pref', () => {
    render(<IndicatorsSection />);
    const activeId = useTabsStore.getState().activeTabId;
    expect(useTabsStore.getState().getPrefs(activeId).fillStrengthCumulative).toBe(true);

    const sw = screen
      .getByTestId('settings-toggle-fillStrengthCumulative')
      .querySelector('[role="switch"]') as HTMLElement;
    fireEvent.click(sw);

    expect(useTabsStore.getState().getPrefs(activeId).fillStrengthCumulative).toBe(false);
  });
```

Note: the subheader text is lowercase-mixed "Fill Strength" in the rendered output (Tailwind's `uppercase` class does the visual transform but `textContent` keeps the source casing). The existing "Moving Average" row uses the same pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- --run src/replay/settings/IndicatorsSection.test.tsx`
Expected: FAIL (no subheader, no toggle).

- [ ] **Step 3: Add the subheader + registry-driven loop**

Replace `frontend/src/replay/settings/IndicatorsSection.tsx` lines 100-133 (the `IndicatorsSection` default export) with:

```tsx
/**
 * "보조지표" category content for the Settings modal. Hosts the 5 Moving
 * Average slots and any toggles whose CHART_TOGGLES entry sets
 * `category: 'indicators'`. New indicator-scoped toggles appear here
 * automatically when added to the registry — no edits below required.
 */
export default function IndicatorsSection() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const prefs = useTabsStore((s) => s.getPrefs(activeTabId));
  const setMovingAverage = useTabsStore((s) => s.setMovingAverage);
  const setToggle = useTabsStore((s) => s.setToggle);

  const indicatorToggles = CHART_TOGGLES.filter((t) => t.category === 'indicators');

  return (
    <>
      <h3 className="text-fg text-base font-medium pb-2 mb-2 border-b border-border">
        보조지표
      </h3>
      <div className="text-fg-dim text-[11px] uppercase tracking-wider mb-2">
        Moving Average
      </div>
      <div>
        {prefs.movingAverages.map((cfg, i) => {
          const index = i as MAIndex;
          return (
            <MovingAverageRow
              key={index}
              index={index}
              config={cfg}
              onChange={(patch) => setMovingAverage(activeTabId, index, patch)}
            />
          );
        })}
      </div>
      {indicatorToggles.length > 0 && (
        <>
          <div className="text-fg-dim text-[11px] uppercase tracking-wider mb-2 mt-4">
            Fill Strength
          </div>
          {indicatorToggles.map((toggle) => {
            const key = toggle.key;
            return (
              <ToggleRow
                key={key}
                label={toggle.label}
                description={toggle.description}
                checked={prefs[key]}
                onToggle={() => setToggle(activeTabId, key, !prefs[key])}
                testId={`settings-toggle-${key}`}
              />
            );
          })}
        </>
      )}
    </>
  );
}
```

The subheader title is hard-coded for now ("Fill Strength") because there is only one indicator-scoped toggle. A future second indicator group would prompt a sub-grouping pattern; until then, YAGNI — keep it simple.

Add the imports at the top of the file:

```tsx
import { useTabsStore, type MAConfig, type MAIndex, CHART_TOGGLES } from '../../state/tabs';
import ToggleRow from './ToggleRow';
```

(Replace the existing `import { useTabsStore, type MAConfig, type MAIndex }` line.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- --run src/replay/settings/IndicatorsSection.test.tsx`
Expected: All PASS. Confirm prior MA tests (rows, color dots, etc.) still pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/replay/settings/IndicatorsSection.tsx frontend/src/replay/settings/IndicatorsSection.test.tsx
git commit -m "feat(settings): render indicator-scoped toggles in IndicatorsSection

Adds 'Fill Strength' subheader and a CHART_TOGGLES.filter loop that
picks up any category='indicators' entries. Currently surfaces the
fillStrengthCumulative toggle; future indicator-scoped toggles need
zero code changes here."
```

---

### Task 5: Implement `projectCumulativeDelta`

**Files:**
- Modify: `frontend/src/chart/projectors/fillStrength.ts`
- Modify: `frontend/src/chart/projectors/fillStrength.test.ts`

The projector is the heart of this feature. Two predicates must stay separate: **in-session** (gates running-sum accumulation, per-segment `[session_open_ms, session_close_ms]`) and **in-viewport** (gates emit, via `axis.contains`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/chart/projectors/fillStrength.test.ts`:

```ts
import { projectBuy, projectSell, projectCumulativeDelta } from './fillStrength';

// ... existing imports remain ...

const day1Open = 1_779_062_400_000;
const day2Open = day1Open + 24 * 3_600_000; // +1 day
const sessionDurationMs = 23_400_000; // 6h30m

describe('projectCumulativeDelta — single-day', () => {
  const singleDayAxis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ]);

  it('runs the sum monotonically and emits per-bucket cumulative values', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },     // +70 → 70
          { t: day1Open + 1000, buy_qty: 20, sell_qty: 80 }, // -60 → 10
          { t: day1Open + 2000, buy_qty: 50, sell_qty: 50 }, //  0  → 10
        ],
      },
    };
    expect(projectCumulativeDelta(bundle, singleDayAxis)).toEqual([
      { time: 0, value: 70 },
      { time: 1, value: 10 },
      { time: 2, value: 10 },
    ]);
  });

  it('returns [] for an empty fill_strength.points list', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: { points: [] },
    };
    expect(projectCumulativeDelta(bundle, singleDayAxis)).toEqual([]);
  });

  it('excludes pre-open and after-session points from the running sum', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open - 60_000, buy_qty: 999, sell_qty: 0 },  // pre-open — must NOT contribute
          { t: day1Open, buy_qty: 100, sell_qty: 30 },          // +70 → 70
          { t: day1Open + sessionDurationMs + 60_000, buy_qty: 0, sell_qty: 500 }, // after — must NOT contribute
        ],
      },
    };
    const out = projectCumulativeDelta(bundle, singleDayAxis);
    expect(out).toHaveLength(1); // only the in-session, in-viewport point emits
    expect(out[0].value).toBe(70); // pre-open's +999 must not show up
  });
});

describe('projectCumulativeDelta — multi-day', () => {
  it('resets the running sum at each segment boundary', () => {
    const axis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
      { date: '20260519', sessionOpenMs: day2Open, sessionCloseMs: day2Open + sessionDurationMs },
    ]);
    const bundle: any = {
      segments: [
        { date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs },
        { date: '20260519', session_open_ms: day2Open, session_close_ms: day2Open + sessionDurationMs },
      ],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },         // day1: +70 → 70
          { t: day1Open + 1000, buy_qty: 50, sell_qty: 200 },  // day1: -150 → -80
          { t: day2Open, buy_qty: 40, sell_qty: 10 },          // day2 reset: +30 → 30
          { t: day2Open + 1000, buy_qty: 100, sell_qty: 100 }, // day2: 0 → 30
        ],
      },
    };
    const out = projectCumulativeDelta(bundle, axis);
    expect(out).toHaveLength(4);
    expect(out[0].value).toBe(70);
    expect(out[1].value).toBe(-80);
    expect(out[2].value).toBe(30);  // RESET — day 2 starts from 0
    expect(out[3].value).toBe(30);
  });
});

describe('projectCumulativeDelta — viewport invariant', () => {
  it('includes out-of-viewport points in the sum but does NOT emit them', () => {
    // Axis covers only the second half of day 1 (zoomed in).
    const halfDay = sessionDurationMs / 2;
    const zoomedAxis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open + halfDay, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    // The bundle's segments still describe the FULL day (the wire format never
    // narrows segments by viewport — only the axis does).
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },             // pre-viewport: +70 → 70
          { t: day1Open + halfDay - 1000, buy_qty: 50, sell_qty: 80 }, // pre-viewport: -30 → 40
          { t: day1Open + halfDay, buy_qty: 20, sell_qty: 10 },    // in-viewport: +10 → 50
        ],
      },
    };
    const out = projectCumulativeDelta(bundle, zoomedAxis);
    expect(out).toHaveLength(1);
    // The running sum at the emitted point reflects the FULL pre-viewport
    // history (40 + 10 = 50), not a viewport-edge reset (would be 10).
    expect(out[0].value).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- --run src/chart/projectors/fillStrength.test.ts`
Expected: FAIL with "projectCumulativeDelta is not a function" or similar.

- [ ] **Step 3: Implement the projector**

In `frontend/src/chart/projectors/fillStrength.ts`, add this export (place it after `projectSell`, before `FILL_STRENGTH_SPEC`):

```ts
import { LineSeries, type LineData, type Time, type UTCTimestamp } from 'lightweight-charts';

// ... existing imports kept ...

/**
 * Per-Stock-Date running sum of `(buy_qty − sell_qty)` over FillStrength's
 * bucketed continuous-trade series — the **Cumulative Net Fill** indicator
 * (CONTEXT.md "Cumulative Net Fill (체결강도 누적)").
 *
 * Two independent predicates:
 *   - in-session (segment[i].session_open_ms ≤ p.t ≤ session_close_ms):
 *     gates whether the point contributes to the running sum. Pre-open and
 *     after-hours points are skipped.
 *   - in-viewport (axis.contains(p.t)): gates whether the cumulative value
 *     is emitted to the series.
 *
 * Splitting these is load-bearing: zooming into mid-session keeps the line
 * starting from the correct 09:00-anchored baseline rather than re-zeroing
 * at the viewport edge.
 *
 * Resets to 0 at each new segment boundary (per-Stock-Date semantics).
 */
export function projectCumulativeDelta(
  bundle: RangeBundle,
  axis: VirtualAxis,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const seg of bundle.segments) {
    let runningSum = 0;
    for (const p of bundle.fill_strength.points) {
      if (p.t < seg.session_open_ms || p.t > seg.session_close_ms) continue;
      runningSum += p.buy_qty - p.sell_qty;
      if (!axis.contains(p.t)) continue;
      out.push({
        time: (axis.toVirtual(p.t) / 1000) as UTCTimestamp,
        value: runningSum,
      });
    }
  }
  return out;
}
```

The outer loop is O(segments × points). For typical replay queries (1–10 segments × few thousand points) that's well under 1ms. If we ever face large ranges we can bucket-index points by segment — out of scope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- --run src/chart/projectors/fillStrength.test.ts`
Expected: All PASS, including the existing `projectBuy` / `projectSell` tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/projectors/fillStrength.ts frontend/src/chart/projectors/fillStrength.test.ts
git commit -m "feat(chart): projectCumulativeDelta for FillStrength pane

Per-segment running sum of (buy_qty - sell_qty). In-session and
in-viewport predicates split — zoom-in preserves the 09:00 baseline
instead of resetting at viewport edge. Auction-window cross included
naturally (single bar at 15:30 → line jump)."
```

---

### Task 6: Wire the cumulative LineSeries into `FILL_STRENGTH_SPEC`

**Files:**
- Modify: `frontend/src/chart/projectors/fillStrength.ts`
- Modify: `frontend/src/chart/projectors/fillStrength.test.ts` (spec shape assertion)

Add the third series with invisible overlay scale, the per-tab `useFillStrengthContext` hook, and the 0-baseline guide. Toggle OFF returns `[]` so the series handle survives — no series churn on toggle flip ([RangeSeriesPane.tsx:75-79](../../frontend/src/chart/RangeSeriesPane.tsx#L75-L79) invariant).

- [ ] **Step 1: Write the failing spec-shape test**

Append to `frontend/src/chart/projectors/fillStrength.test.ts`:

```ts
import { FILL_STRENGTH_SPEC } from './fillStrength';
import { LineSeries, HistogramSeries } from 'lightweight-charts';

describe('FILL_STRENGTH_SPEC shape', () => {
  it('has three series: two histograms then one cumulative line', () => {
    expect(FILL_STRENGTH_SPEC.series).toHaveLength(3);
    expect(FILL_STRENGTH_SPEC.series[0].type).toBe(HistogramSeries);
    expect(FILL_STRENGTH_SPEC.series[1].type).toBe(HistogramSeries);
    expect(FILL_STRENGTH_SPEC.series[2].type).toBe(LineSeries);
  });

  it('cumulative series uses invisible overlay scale (priceScaleId: "")', () => {
    const cum = FILL_STRENGTH_SPEC.series[2];
    expect(cum.options.priceScaleId).toBe('');
  });

  it('cumulative series projector returns [] when cumulativeEnabled is false', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [{ t: day1Open, buy_qty: 100, sell_qty: 30 }],
      },
    };
    const axis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    const cum = FILL_STRENGTH_SPEC.series[2];
    // ON → one point
    expect(cum.data(bundle, axis, { cumulativeEnabled: true })).toHaveLength(1);
    // OFF → []
    expect(cum.data(bundle, axis, { cumulativeEnabled: false })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- --run src/chart/projectors/fillStrength.test.ts`
Expected: FAIL (only 2 series exist, options lacks `priceScaleId`, no `cumulativeEnabled` gating).

- [ ] **Step 3: Add tokens, context, and the third series**

Edit `frontend/src/chart/projectors/fillStrength.ts`:

1. Replace the imports section at the top:

```ts
import { HistogramSeries, LineSeries, type LineData, type Time, type UTCTimestamp } from 'lightweight-charts';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import type { PaneSpec } from '../RangeSeriesPane';
```

2. Replace the `TOKEN_SPEC` block:

```ts
const TOKEN_SPEC = {
  buy: ['--price-up', '#DC2626'],          // 체결 매수 (KRX 빨강)
  sell: ['--price-down', '#2563EB'],       // 체결 매도 (KRX 파랑)
  cumulative: ['--fg', '#E5E7EB'],         // 체결강도 누적 — neutral (derived signal)
  cumulativeBaseline: ['--fg-dimmer', '#64748B'], // 0-baseline guide
} as const;

const { buy, sell, cumulative, cumulativeBaseline } = resolveTokens(TOKEN_SPEC);
```

3. Add the context type and hook before `FILL_STRENGTH_SPEC`:

```ts
export type FillStrengthPaneContext = {
  cumulativeEnabled: boolean;
};

// Single primitive selector; useShallow not needed (Object.is on boolean is fine).
// But we still pull the toggle through useActivePrefs so cross-tab switches
// re-run RangeSeriesPane's data effect — same pattern as useRatioContext but
// minus the multi-field object literal.
const useFillStrengthContext = (): FillStrengthPaneContext =>
  useActivePrefs(
    useShallow((p): FillStrengthPaneContext => ({
      cumulativeEnabled: p.fillStrengthCumulative,
    })),
  );

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

const cumulativePriceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => v.toLocaleString('ko-KR'),  // sign preserved
  minMove: 1,
};
```

(Delete the old standalone `const histOpts = { ... }` lines if they appear earlier; the block above is the new single definition.)

4. Replace the `FILL_STRENGTH_SPEC` export with the typed-context version:

```ts
export const FILL_STRENGTH_SPEC: PaneSpec<FillStrengthPaneContext> = {
  name: 'fill-strength',
  stretch: 0.4,
  useContext: useFillStrengthContext,
  series: [
    {
      type: HistogramSeries,
      options: { color: buy, ...histOpts },
      data: (bundle, axis) => projectBuy(bundle, axis),
    },
    {
      type: HistogramSeries,
      options: { color: sell, ...histOpts },
      data: (bundle, axis) => projectSell(bundle, axis),
    },
    {
      type: LineSeries,
      options: {
        color: cumulative,
        lineWidth: 2,
        lineStyle: 0,          // solid
        priceScaleId: '',      // invisible overlay scale — autoscale split from histograms
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: cumulativePriceFormat,
      },
      data: (bundle, axis, ctx) =>
        ctx.cumulativeEnabled ? projectCumulativeDelta(bundle, axis) : [],
      afterAdd: (series) => {
        series.createPriceLine({
          price: 0,
          color: cumulativeBaseline,
          lineWidth: 1,
          lineStyle: 1,         // dotted
          axisLabelVisible: false,
          title: '',
        });
      },
    },
  ],
};
```

The existing `projectBuy` / `projectSell` keep their 2-arg signatures (they don't use ctx); we wrap them inline to satisfy the 3-arg `SeriesSpec<Ctx>.data` signature.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test -- --run src/chart/projectors/fillStrength.test.ts`
Expected: All PASS — both the old `projectBuy` / `projectSell` tests and the new `FILL_STRENGTH_SPEC shape` block.

- [ ] **Step 5: Run the full frontend test suite for regression**

Run: `cd frontend && npm test -- --run`
Expected: All PASS. The new spec shape may affect `ChartStage` / `Workarea` tests that count series — review failures and adjust if needed (those tests usually count addSeries calls per pane; bumping FillStrength from 2 → 3 is the only change).

If any test fails with "expected addSeries called N times, received N+1" on the FillStrength pane, update that test's expectation to N+1. Do NOT relax assertions — find the count and bump it.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/projectors/fillStrength.ts frontend/src/chart/projectors/fillStrength.test.ts
git commit -m "feat(chart): cumulative net fill line on FillStrength pane

Third series on FILL_STRENGTH_SPEC, gated by per-tab
fillStrengthCumulative toggle via FillStrengthPaneContext. Invisible
overlay scale (priceScaleId: '') keeps the line from compressing the
buy/sell histogram bars on the shared right axis. 0-baseline dotted
guide rendered via afterAdd. Toggle OFF returns [] from the projector
so the series handle survives — no series churn on flip."
```

---

### Task 7: Manual verification in dev server

CLAUDE.md requires: "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete."

- [ ] **Step 1: Start backend + frontend dev servers**

In two terminals (or use the VS Code task `Dev: backend + frontend`):

```bash
# terminal 1
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga

# terminal 2
cd frontend && npm run dev
```

Wait for "Application startup complete." (backend) and "ready in" (vite).

- [ ] **Step 2: Open the replay viewer and verify the cumulative line appears**

Navigate to `http://localhost:5173/replay`. Pick a Stock-Date with available data and load it. In the bottom FillStrength pane, confirm:

- [ ] A solid neutral-color line is rendered on top of the buy/sell histograms.
- [ ] The line trends in one direction within a day (sawtooth-ish across multi-day ranges).
- [ ] A dotted 0-baseline is visible.
- [ ] The histogram bars are NOT visually compressed (separate price scales worked).
- [ ] Cross at 15:30 produces a visible jump (or flat-line during 15:20–15:30 then jump).

- [ ] **Step 3: Verify the toggle**

Open the Settings modal (gear icon) → 보조지표 카테고리:

- [ ] "Fill Strength" 서브헤더가 Moving Average 그룹 아래에 존재.
- [ ] "체결강도 — 당일 누적" 토글이 ON 상태로 보임.
- [ ] 토글을 클릭하면 라인이 사라짐 (히스토그램은 그대로).
- [ ] 다시 클릭하면 라인 재출현.
- [ ] 차트 카테고리에는 "체결강도 — 당일 누적" 토글이 보이지 않음 (auctionWindowMask / ratioOutlierFilterEnabled만).

- [ ] **Step 4: Verify persistence**

- [ ] 토글 OFF 상태에서 페이지 새로고침 (F5) → OFF 상태가 유지되어야 함.
- [ ] 토글 ON으로 복귀 후 다시 새로고침 → ON 상태 유지.

- [ ] **Step 5: Verify multi-day range**

If a multi-day range is available:

- [ ] 라인이 매 거래일 시작에서 0 baseline으로 reset되는지 확인 (톱니파 모양).
- [ ] DayBoundaryOverlay 위치와 reset 지점이 일치하는지 확인.

- [ ] **Step 6: No-commit step — manual verification result**

If everything above passes, the feature is shipped. If any item fails, file a follow-up issue or fix inline (and add a regression test in the relevant `.test.ts` file before re-committing).

---

## Self-Review

| Spec section | Implementing task(s) |
|---|---|
| 결정 사항 Q1/Q2/Q3/Color | Task 5 (값 알고리즘), Task 6 (overlay scale + neutral color), Task 2 (toggle entry) |
| 알고리즘 invariant (in-session vs in-viewport) | Task 5 step 3 + tests in step 1 |
| 파일별 변경 (registry + UI 카테고리) | Task 2 (registry), Task 3 (SettingsModal filter), Task 4 (IndicatorsSection loop) |
| Pane 컨텍스트 / 토글 churn 없음 invariant | Task 6 step 3 (`useContext` + `cumulativeEnabled ? ... : []`) + spec-shape test step 1 |
| 라인 스타일 (color, lineWidth, lineStyle, format) | Task 6 step 3 |
| 0-baseline 가이드선 | Task 6 step 3 (`afterAdd` block) |
| Settings UI (서브헤더 + 토글) | Task 4 |
| 엣지 케이스 — 빈 points, 다일 reset, viewport 잘림, auction window | Task 5 tests step 1 (all four cases covered) |
| Persistence 테스트 | Task 2 step 1 |
| Component 테스트 (addSeries 3회) | Task 6 step 1 |
| Settings UI 테스트 | Task 4 step 1, Task 3 step 2 |

No spec section is left without a task. No "TBD" / "implement later" placeholders. Type names are consistent throughout: `FillStrengthPaneContext`, `cumulativeEnabled`, `projectCumulativeDelta`, `fillStrengthCumulative`, `category`.

---

**Plan file:** `docs/superpowers/plans/2026-05-24-fill-strength-cumulative-line.md`
