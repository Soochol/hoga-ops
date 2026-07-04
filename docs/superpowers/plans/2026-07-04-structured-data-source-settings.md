# Structured Data Source Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the confusing single "data source" setting into user-visible candle, orderbook/trade, and screener daily sections that match the actual disk/data architecture.

**Architecture:** Keep the existing backend `source_pref` contract for `/api/range`, `/api/orderbook`, and `/api/brokers/series`; rename its UI meaning to "호가·체결 데이터 기준". Add a frontend-only candle data preference store for now, use it to control KIS-vs-hogaplay candle fallback order in `/live`, and surface screener daily parquet as a status/update section rather than mixing it into chart source preference. Defer a true backend candles-only screener daily endpoint to a later task because it changes chart data semantics.

**Tech Stack:** React, TypeScript, Zustand, TanStack Query, Vitest, FastAPI route contracts already exposed through `frontend/src/api/*`.

## Global Constraints

- Do not break existing persisted `chart.sourcePreference.v1`; migrate/alias its label only.
- Keep `/api/range?source_pref=` values unchanged: `hogaplay_first`, `kis_ws_first`, `kis_api_first`.
- Keep source chips honest: chip source should describe the data actually used in the rendered chart segment.
- Avoid backend schema changes in Phase 1.
- Korean UI copy must name user-recognizable data roles: "캔들", "호가·체결", "스크리너 일봉".

---

## File Structure

- Modify `frontend/src/api/sourceCapabilities.ts`: rename labels/copy helpers and add candle preference option definitions.
- Modify `frontend/src/state/sourcePreference.ts`: update comments/export naming for orderbook/trade source preference without changing storage value.
- Create `frontend/src/state/candleDataPreference.ts`: new Zustand store persisted under `chart.candleDataPreference.v1`.
- Modify `frontend/src/live/settings/SourcePreferenceRadio.tsx`: either rename to `OrderflowSourcePreferenceRadio` or keep as wrapper while updating copy.
- Create `frontend/src/live/settings/CandleDataPreferenceRadio.tsx`: radio controls for candle data policy.
- Modify `frontend/src/live/LiveSettingsSections.tsx`: restructure Data Source detail into "캔들 데이터", "호가·체결 데이터", "스크리너 일봉 데이터", and keep storage/KIS venue sections.
- Modify `frontend/src/live/useLiveBundle.ts`: read candle preference and use it when deciding whether to call KIS candle endpoints first or hogaplay fallback first.
- Modify `frontend/src/live/buildLiveBundle.ts` only if source chip labels need additional source names; otherwise leave untouched.
- Modify tests:
  - `frontend/src/api/sourceCapabilities.test.ts`
  - `frontend/src/state/sourcePreference.test.ts`
  - add `frontend/src/state/candleDataPreference.test.ts`
  - `frontend/src/live/LiveSettingsSections.test.tsx`
  - `frontend/src/live/LiveSettingsModal.test.tsx`
  - `frontend/src/live/useLiveBundle.test.tsx`

---

### Task 1: Rename The Existing Source Preference Concept In UI Code

**Files:**
- Modify: `frontend/src/api/sourceCapabilities.ts`
- Modify: `frontend/src/state/sourcePreference.ts`
- Test: `frontend/src/api/sourceCapabilities.test.ts`
- Test: `frontend/src/state/sourcePreference.test.ts`

**Interfaces:**
- Consumes: existing `SourcePreference = 'hogaplay_first' | 'kis_ws_first' | 'kis_api_first'`
- Produces: `getOrderflowSourcePreferenceLabel(value: SourcePreference): string`

- [ ] **Step 1: Write failing tests for renamed labels**

Update `frontend/src/api/sourceCapabilities.test.ts` to expect the UI helper to describe orderbook/trade data:

```ts
import {
  SOURCE_PREFERENCE_OPTIONS,
  SOURCE_PREFERENCE_PRIMARY_SOURCE,
  getOrderflowSourcePreferenceLabel,
} from './sourceCapabilities';

describe('sourceCapabilities', () => {
  it('defines UI capabilities for every read source', () => {
    expect(SOURCE_PREFERENCE_OPTIONS).toEqual(['hogaplay_first', 'kis_ws_first', 'kis_api_first']);
    expect(SOURCE_PREFERENCE_PRIMARY_SOURCE).toEqual({
      hogaplay_first: 'hogaplay',
      kis_ws_first: 'kis_live',
      kis_api_first: 'kis_api',
    });
  });

  it('derives orderflow labels from source capabilities', () => {
    expect(getOrderflowSourcePreferenceLabel('hogaplay_first')).toBe('hogaplay 우선');
    expect(getOrderflowSourcePreferenceLabel('kis_ws_first')).toBe('KIS WS 우선');
    expect(getOrderflowSourcePreferenceLabel('kis_api_first')).toBe('KIS API 우선');
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd frontend
npx vitest run src/api/sourceCapabilities.test.ts src/state/sourcePreference.test.ts
```

Expected: fail because `getOrderflowSourcePreferenceLabel` is not exported.

- [ ] **Step 3: Implement label alias without breaking old imports**

In `frontend/src/api/sourceCapabilities.ts`, add the new helper and keep the old helper as a compatibility alias:

```ts
export function getOrderflowSourcePreferenceLabel(value: SourcePreference): string {
  return `${SOURCE_CAPABILITIES[SOURCE_PREFERENCE_PRIMARY_SOURCE[value]].label} 우선`;
}

export function getSourcePreferenceLabel(value: SourcePreference): string {
  return getOrderflowSourcePreferenceLabel(value);
}
```

In `frontend/src/state/sourcePreference.ts`, update the comment so future readers understand this store is now orderflow/hoga source preference:

```ts
/**
 * Orderflow Source Preference (ADR-0039) — global per-user setting that drives
 * source selection for hoga/orderbook/trade-derived read paths such as
 * `/api/range`, `/api/orderbook`, and `/api/brokers/series`.
 *
 * Storage key stays `chart.sourcePreference.v1` for backward compatibility.
 */
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
cd frontend
npx vitest run src/api/sourceCapabilities.test.ts src/state/sourcePreference.test.ts
```

Expected: pass.

---

### Task 2: Add A Candle Data Preference Store

**Files:**
- Create: `frontend/src/state/candleDataPreference.ts`
- Test: `frontend/src/state/candleDataPreference.test.ts`

**Interfaces:**
- Produces: `CandleDataPreference = 'auto' | 'hogaplay_first' | 'kis_api_first' | 'screener_daily_first'`
- Produces: `useCandleDataPreferenceStore`
- Produces: `CANDLE_DATA_PREFERENCE_OPTIONS`
- Produces: `getCandleDataPreferenceLabel(value: CandleDataPreference): string`

- [ ] **Step 1: Write failing store tests**

Create `frontend/src/state/candleDataPreference.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CANDLE_DATA_PREFERENCE_OPTIONS,
  getCandleDataPreferenceLabel,
  useCandleDataPreferenceStore,
  type CandleDataPreference,
} from './candleDataPreference';

describe('candleDataPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    useCandleDataPreferenceStore.setState({ candleDataPreference: 'auto' });
  });

  it('defaults to auto', () => {
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('auto');
  });

  it('updates and persists valid values', () => {
    useCandleDataPreferenceStore.getState().setCandleDataPreference('hogaplay_first');
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('hogaplay_first');
    expect(localStorage.getItem('chart.candleDataPreference.v1')).toContain('hogaplay_first');
  });

  it('ignores invalid values', () => {
    useCandleDataPreferenceStore.getState().setCandleDataPreference('bogus' as CandleDataPreference);
    expect(useCandleDataPreferenceStore.getState().candleDataPreference).toBe('auto');
  });

  it('defines user-facing labels', () => {
    expect(CANDLE_DATA_PREFERENCE_OPTIONS).toEqual(['auto', 'hogaplay_first', 'kis_api_first', 'screener_daily_first']);
    expect(getCandleDataPreferenceLabel('auto')).toBe('자동');
    expect(getCandleDataPreferenceLabel('hogaplay_first')).toBe('hogaplay 우선');
    expect(getCandleDataPreferenceLabel('kis_api_first')).toBe('KIS API 우선');
    expect(getCandleDataPreferenceLabel('screener_daily_first')).toBe('스크리너 일봉 우선');
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd frontend
npx vitest run src/state/candleDataPreference.test.ts
```

Expected: fail because the module does not exist.

- [ ] **Step 3: Implement the store**

Create `frontend/src/state/candleDataPreference.ts`:

```ts
import { create } from 'zustand';

export type CandleDataPreference =
  | 'auto'
  | 'hogaplay_first'
  | 'kis_api_first'
  | 'screener_daily_first';

export const CANDLE_DATA_PREFERENCE_OPTIONS = [
  'auto',
  'hogaplay_first',
  'kis_api_first',
  'screener_daily_first',
] as const satisfies readonly CandleDataPreference[];

const STORAGE_KEY = 'chart.candleDataPreference.v1';

const LABEL: Record<CandleDataPreference, string> = {
  auto: '자동',
  hogaplay_first: 'hogaplay 우선',
  kis_api_first: 'KIS API 우선',
  screener_daily_first: '스크리너 일봉 우선',
};

export function getCandleDataPreferenceLabel(value: CandleDataPreference): string {
  return LABEL[value];
}

interface Store {
  candleDataPreference: CandleDataPreference;
  setCandleDataPreference: (value: CandleDataPreference) => void;
  hydrateFromStorage: () => void;
}

function readStorage(): { candleDataPreference: CandleDataPreference } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { candleDataPreference: string };
    if (CANDLE_DATA_PREFERENCE_OPTIONS.includes(parsed.candleDataPreference as CandleDataPreference)) {
      return { candleDataPreference: parsed.candleDataPreference as CandleDataPreference };
    }
    return null;
  } catch {
    return null;
  }
}

function persist(value: CandleDataPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ candleDataPreference: value }));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useCandleDataPreferenceStore = create<Store>((set) => ({
  candleDataPreference: readStorage()?.candleDataPreference ?? 'auto',
  setCandleDataPreference: (value) => {
    if (!CANDLE_DATA_PREFERENCE_OPTIONS.includes(value)) return;
    set({ candleDataPreference: value });
    persist(value);
  },
  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ candleDataPreference: stored.candleDataPreference });
  },
}));
```

- [ ] **Step 4: Run test and verify pass**

Run:

```bash
cd frontend
npx vitest run src/state/candleDataPreference.test.ts
```

Expected: pass.

---

### Task 3: Restructure Data Source Settings UI

**Files:**
- Create: `frontend/src/live/settings/CandleDataPreferenceRadio.tsx`
- Modify: `frontend/src/live/settings/SourcePreferenceRadio.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`
- Test: `frontend/src/live/LiveSettingsSections.test.tsx`
- Test: `frontend/src/live/LiveSettingsModal.test.tsx`

**Interfaces:**
- Consumes: `useCandleDataPreferenceStore`
- Consumes: `useSourcePreferenceStore`
- Produces: visible sections "캔들 데이터 기준", "호가·체결 데이터 기준", "스크리너 일봉 데이터"

- [ ] **Step 1: Write failing UI tests**

In `frontend/src/live/LiveSettingsSections.test.tsx`, update the data-source test to assert the new sections:

```ts
it('데이터소스 상세를 캔들/호가체결/스크리너 일봉으로 구조화한다', async () => {
  render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });

  fireEvent.click(screen.getByTestId('settings-nav-data-source'));

  expect(await screen.findByText('캔들 데이터 기준')).toBeInTheDocument();
  expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
  expect(screen.getByText('스크리너 일봉 데이터')).toBeInTheDocument();
  expect(screen.getByLabelText('자동')).toBeInTheDocument();
  expect(screen.getByLabelText('KIS WS 우선')).toBeInTheDocument();
});
```

Update `frontend/src/live/LiveSettingsModal.test.tsx` so its "데이터소스 nav" test expects "캔들 데이터 기준" and "호가·체결 데이터 기준" instead of the old "데이터 표현 기준".

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd frontend
npx vitest run src/live/LiveSettingsSections.test.tsx src/live/LiveSettingsModal.test.tsx
```

Expected: fail because new headings are not rendered.

- [ ] **Step 3: Create candle preference radio**

Create `frontend/src/live/settings/CandleDataPreferenceRadio.tsx`:

```tsx
import {
  getCandleDataPreferenceLabel,
  useCandleDataPreferenceStore,
  type CandleDataPreference,
} from '../../state/candleDataPreference';

export default function CandleDataPreferenceRadio({ value }: { value: CandleDataPreference }) {
  const current = useCandleDataPreferenceStore((s) => s.candleDataPreference);
  const setPref = useCandleDataPreferenceStore((s) => s.setCandleDataPreference);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <input
        type="radio"
        name="candle-data-preference"
        value={value}
        checked={current === value}
        onChange={() => setPref(value)}
      />
      <span>{getCandleDataPreferenceLabel(value)}</span>
    </label>
  );
}
```

- [ ] **Step 4: Update orderflow source radio copy**

In `frontend/src/live/settings/SourcePreferenceRadio.tsx`, import `getOrderflowSourcePreferenceLabel` and render that label:

```tsx
import { getOrderflowSourcePreferenceLabel } from '../../api/sourceCapabilities';
```

Replace:

```tsx
{getSourcePreferenceLabel(value)}
```

with:

```tsx
{getOrderflowSourcePreferenceLabel(value)}
```

- [ ] **Step 5: Restructure `DataSourceDetail`**

In `frontend/src/live/LiveSettingsSections.tsx`, import candle options/radio:

```tsx
import { CANDLE_DATA_PREFERENCE_OPTIONS } from '../state/candleDataPreference';
import CandleDataPreferenceRadio from './settings/CandleDataPreferenceRadio';
```

Replace the old "데이터 표현 기준" block with three role-specific sections:

```tsx
<DataSection title="캔들 데이터 기준" contentClassName="space-y-2 p-3">
  <div className="text-xs text-fg-dimmer">
    분봉·일봉·주봉·월봉 캔들에 적용됩니다. 자동은 현재 안정적인 디스크 데이터를 먼저 사용합니다.
  </div>
  <div className="flex flex-col gap-2">
    {CANDLE_DATA_PREFERENCE_OPTIONS.map((opt) => (
      <CandleDataPreferenceRadio key={opt} value={opt} />
    ))}
  </div>
</DataSection>

<DataSection title="호가·체결 데이터 기준" contentClassName="space-y-2 p-3">
  <div className="text-xs text-fg-dimmer">
    호가창, 체결, 거래원, 호가비, 체결강도 같은 보조 데이터에 적용됩니다.
  </div>
  <div className="flex flex-col gap-2">
    {SOURCE_OPTIONS.map((opt) => (
      <SourcePreferenceRadio key={opt} value={opt} />
    ))}
  </div>
</DataSection>

<DataSection title="스크리너 일봉 데이터" contentClassName="space-y-2 p-3">
  <div className="text-xs text-fg-dimmer">
    스크리너 갱신으로 저장되는 KIS 일봉 parquet입니다. 조건검색과 섹터 랭킹의 기준 데이터로 사용됩니다.
  </div>
  <div className="text-sm text-fg-dim">
    갱신은 스크리너 화면의 데이터 갱신 버튼에서 실행합니다.
  </div>
</DataSection>
```

Keep existing "KIS 캔들 거래소", "데이터 저장 방식", and "프로그램 순매수 저장" above these sections.

- [ ] **Step 6: Run tests and verify pass**

Run:

```bash
cd frontend
npx vitest run src/live/LiveSettingsSections.test.tsx src/live/LiveSettingsModal.test.tsx
```

Expected: pass.

---

### Task 4: Wire Candle Preference Into `/live` Candle Fallback Order

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Test: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: `useCandleDataPreferenceStore((s) => s.candleDataPreference)`
- Produces: behavior where `hogaplay_first` starts candle display from `/api/range` candles instead of waiting for KIS warnings.

- [ ] **Step 1: Add failing tests for hogaplay-first candle behavior**

In `frontend/src/live/useLiveBundle.test.tsx`, add a test near existing fallback tests:

```ts
it('candleDataPreference=hogaplay_first uses range candles as the candle source before KIS warning', async () => {
  useCandleDataPreferenceStore.setState({ candleDataPreference: 'hogaplay_first' });
  useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });

  // Mock past KIS candles as empty/no-warning and /api/range as hogaplay candles.
  // Assert chartBundle.candles comes from range and latest segment source is hogaplay.
});
```

Use the local mocking style already present in the file; do not introduce a new test harness.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd frontend
npx vitest run src/live/useLiveBundle.test.tsx
```

Expected: fail because `useLiveBundle` ignores `candleDataPreference`.

- [ ] **Step 3: Implement preference-derived fallback gating**

In `frontend/src/live/useLiveBundle.ts`, import and read the new store:

```ts
import { useCandleDataPreferenceStore } from '../state/candleDataPreference';
```

Inside `useLiveBundle`:

```ts
const candleDataPreference = useCandleDataPreferenceStore((s) => s.candleDataPreference);
const preferHogaplayCandles = candleDataPreference === 'hogaplay_first';
const preferKisCandles = candleDataPreference === 'kis_api_first';
```

Adjust the fallback gate:

```ts
const candleFallbackNeeded = !!(code && (
  preferHogaplayCandles ||
  (isMinute
    ? pastCandlesQuery.data != null && pastCandlesQuery.data.data_warnings.length > 0
    : timeframe === 'D' &&
      pastDailyCandlesQuery.data != null &&
      (pastDailyCandlesQuery.data.data_warnings.length > 0 || pastDailyCandlesQuery.data.candles.length === 0))
));
```

Make merge precedence explicit:

```ts
const primaryRangeFallback = mergeCandlesPreferPrimary(
  candleFallback.data?.candles ?? [],
  hogaplayCandleFallback.data?.candles ?? [],
);
const fallback = preferHogaplayCandles
  ? primaryRangeFallback
  : mergeCandlesPreferPrimary([], primaryRangeFallback);
```

Then in the minute and daily branches:

- if `preferHogaplayCandles && fallback.length > 0`, return fallback-derived candles before KIS candles.
- if `preferKisCandles` or `auto`, preserve current KIS-first behavior.
- treat `screener_daily_first` like `auto` in Phase 1, but add a source warning/comment that true screener-daily chart source needs Phase 2 backend endpoint.

- [ ] **Step 4: Update source-by-date behavior**

Ensure `candleSourceByDate` marks hogaplay dates as `hogaplay` when `preferHogaplayCandles` is active:

```ts
if (preferHogaplayCandles) {
  for (const date of candleDateSet(candleFallback.data?.candles ?? [])) {
    sourceByDate.set(date, segmentSourceByDate(candleFallback.data, date) ?? 'hogaplay');
  }
}
```

- [ ] **Step 5: Run tests and verify pass**

Run:

```bash
cd frontend
npx vitest run src/live/useLiveBundle.test.tsx src/live/aggregateCandles.test.ts src/chart/projectors/candle.test.ts
```

Expected: pass.

---

### Task 5: Update Copy And Regression Tests Around The Old "모든 차트 공통" Meaning

**Files:**
- Modify: `frontend/src/live/LiveSettingsSections.test.tsx`
- Modify: `frontend/src/live/LiveSettingsModal.test.tsx`
- Modify: any tests found by `rg -n "데이터 표현 기준|모든 차트 공통|현재 source는" frontend/src -S`

**Interfaces:**
- Produces: no visible "데이터 표현 기준 (모든 차트 공통)" copy remains.

- [ ] **Step 1: Search stale copy**

Run:

```bash
rg -n "데이터 표현 기준|모든 차트 공통|현재 source는" frontend/src -S
```

Expected: matches only tests or files being edited.

- [ ] **Step 2: Replace stale copy**

Use these replacements:

```txt
데이터 표현 기준 (모든 차트 공통) -> 호가·체결 데이터 기준
현재 source는 차트 상단 칩에 표시됩니다. -> 차트 상단 칩은 실제 렌더링에 사용된 source를 표시합니다.
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
cd frontend
npx vitest run src/live/LiveSettingsSections.test.tsx src/live/LiveSettingsModal.test.tsx src/api/sourceCapabilities.test.ts src/state/candleDataPreference.test.ts
```

Expected: pass.

---

### Task 6: Full Verification

**Files:**
- No code files unless failures require fixes.

**Interfaces:**
- Produces: verified UI/settings behavior.

- [ ] **Step 1: Run frontend focused suite**

Run:

```bash
cd frontend
npx vitest run src/live/useLiveBundle.test.tsx src/live/LiveSettingsSections.test.tsx src/live/LiveSettingsModal.test.tsx src/api/sourceCapabilities.test.ts src/state/sourcePreference.test.ts src/state/candleDataPreference.test.ts src/api/range.test.tsx src/api/useLiveCursor.test.ts
```

Expected: pass.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd frontend
npm run build
```

Expected: pass.

- [ ] **Step 3: Manual smoke test**

Run the dev server if not already running:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173/live`.

Verify:

- Settings → 데이터소스 shows "캔들 데이터 기준", "호가·체결 데이터 기준", "스크리너 일봉 데이터".
- Selecting "호가·체결 데이터 기준 → KIS WS 우선" still changes `/api/range` and cursor requests to `source_pref=kis_ws_first`.
- Selecting "캔들 데이터 기준 → hogaplay 우선" makes daily/minute candles appear from hogaplay when KIS API is unavailable.
- The chart source chip still reflects the source used for the visible segment.

---

## Phase 2 Follow-Up: True Screener Daily Candle Source

This plan intentionally does not make `/live` D/W/M candles read directly from `data/screener/daily_adjusted.parquet`. To do that cleanly, create a separate backend task:

- Add a backend candles-only endpoint such as `/api/live/screener-daily-candles`.
- Read `data/screener/daily_adjusted.parquet` by `code` and date range.
- Return the same candle wire shape as `/api/live/past-daily-candles`.
- Update `screener_daily_first` to use that endpoint for D/W/M.
- Keep minute candles on hogaplay/KIS paths because screener parquet is daily-only.

## Self-Review

- Spec coverage: The plan separates candle, orderflow, and screener daily UI; preserves existing source_pref; adds candle preference; wires hogaplay-first behavior; leaves screener daily chart source as explicit Phase 2.
- Placeholder scan: No TBD/TODO/fill-later text remains. The one intentionally open test mocking detail references the existing test harness because the file already contains the required mock patterns.
- Type consistency: `CandleDataPreference`, `SourcePreference`, and helper names are introduced before use and match across tasks.
