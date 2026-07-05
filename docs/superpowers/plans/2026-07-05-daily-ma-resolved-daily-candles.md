# Daily MA Resolved Daily Candles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `일봉 이동평균선 (Daily MA)` visible on `/live` and `/study` minute charts during `KIS API 우회` by resolving daily candles from KIS daily plus screener daily stored fallback.

**Architecture:** Add a deep frontend Module, `useResolvedDailyCandles`, that hides two adapters behind one small Interface: `useLivePastDailyCandles` for preferred KIS daily rows and `useScreenerDailyCandles` for stored fallback rows. Rewire `DailyMovingAverageOverlay` to consume resolved rows while keeping Daily MA outside `useLiveBundle` per ADR-0073 and keeping `/api/live/past-daily-candles` semantics intact per ADR-0048.

**Tech Stack:** React 18, TanStack Query, Zustand, TypeScript, Vitest, Testing Library, lightweight-charts.

## Global Constraints

- Preserve ADR-0073: Daily MA remains a self-contained overlay outside `useLiveBundle`.
- Preserve ADR-0048: `/api/live/past-daily-candles` remains the KIS daily Live Candle Backfill wire, with memory-only cache semantics.
- Do not move Daily MA into `useLiveBundle`.
- Do not change `/api/live/past-daily-candles` to silently mix screener daily rows into its response.
- Do not persist Live Candle Backfill daily cache to disk.
- Do not add per-study-view saved Daily MA settings.
- Do not change current Timeframe moving averages or screener `ma` scan semantics.
- `useResolvedDailyCandles` must request KIS daily and screener daily in parallel whenever enabled.
- KIS daily wins for dates where both adapters return a row; screener daily fills dates missing from KIS daily.
- Do not consult global Source Preference for Daily MA daily resolution.
- Do not escalate `kis_rest_bypassed` warnings from Daily MA into the KIS unavailable toast.

---

## File Structure

- Create `frontend/src/live/indicators/useResolvedDailyCandles.ts`
  - Owns Daily MA daily-candle resolution.
  - Consumes `useLivePastDailyCandles` and `useScreenerDailyCandles`.
  - Produces sorted resolved daily candles, merged warnings, combined loading/error state, and `sourceByDate`.
- Create `frontend/src/live/indicators/useResolvedDailyCandles.test.tsx`
  - Tests the hook Interface without chart or VirtualAxis setup.
- Modify `frontend/src/api/livePastDailyCandles.ts`
  - Aligns the frontend warning reason union with the backend's existing `kis_rest_bypassed` response.
- Modify `frontend/src/live/indicators/DailyMovingAverageOverlay.tsx`
  - Replace direct `useLivePastDailyCandles` dependency with `useResolvedDailyCandles`.
  - Keep `dailyMaFetchWindow`, `pickTodayLiveClose`, and projection logic in the overlay.
- Modify `frontend/src/live/indicators/DailyMovingAverageOverlay.test.tsx`
  - Mock `useResolvedDailyCandles`.
  - Move direct venue threading coverage to the hook test.
  - Add a regression test proving fallback rows project Daily MA values.
- No backend files change.
- No route-level live/study files change unless a test reveals a prop mismatch; the shared `LiveChartRoot -> DailyMovingAverageOverlay` path is already the seam.

---

### Task 1: Add `useResolvedDailyCandles` Module

**Files:**
- Create: `frontend/src/live/indicators/useResolvedDailyCandles.ts`
- Create: `frontend/src/live/indicators/useResolvedDailyCandles.test.tsx`
- Modify: `frontend/src/api/livePastDailyCandles.ts`

**Interfaces:**
- Consumes:
  - `useLivePastDailyCandles(code: string | null, from: string | null, to: string | null, venue?: LiveVenueOption)`
  - `useScreenerDailyCandles(code: string | null, from: string | null, to: string | null)`
  - `unixMsToKSTDate(t_ms: number): string`
- Produces:
  - `type ResolvedDailyCandleSource = 'kis_daily' | 'screener_daily'`
  - `type ResolvedDailyWarning = LivePastDailyCandlesWarning | { batch: string; reason: string; msg: string }`
  - `function useResolvedDailyCandles(input: UseResolvedDailyCandlesInput): UseResolvedDailyCandlesResult`

- [ ] **Step 1: Align the live daily warning type with the backend response**

Modify `frontend/src/api/livePastDailyCandles.ts` so the existing warning type accepts the backend's `kis_rest_bypassed` reason:

```ts
export type LivePastDailyCandlesWarning = {
  batch: string;
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation' | 'kis_rest_bypassed';
  msg: string;
};
```

- [ ] **Step 2: Write the failing hook tests**

Create `frontend/src/live/indicators/useResolvedDailyCandles.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
import { useScreenerDailyCandles } from '../../api/screenerDailyCandles';
import { useResolvedDailyCandles } from './useResolvedDailyCandles';

vi.mock('../../api/livePastDailyCandles', () => ({ useLivePastDailyCandles: vi.fn() }));
vi.mock('../../api/screenerDailyCandles', () => ({ useScreenerDailyCandles: vi.fn() }));

const mockUseKisDaily = vi.mocked(useLivePastDailyCandles);
const mockUseScreenerDaily = vi.mocked(useScreenerDailyCandles);

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const D1 = 1_781_568_000_000; // 2026-06-16 09:00 KST
const D2 = 1_781_654_400_000; // 2026-06-17 09:00 KST

function kisRow(t_ms: number, close: number) {
  return { t_ms, open: close - 1, high: close + 1, low: close - 2, close, volume: 100 };
}

function screenerRow(t_ms: number, close: number) {
  return { t_ms, open: close - 1, high: close + 1, low: close - 2, close, volume: 200 };
}

describe('useResolvedDailyCandles', () => {
  beforeEach(() => {
    mockUseKisDaily.mockReturnValue({
      data: { candles: [], data_warnings: [], code: '005930', from: '20260616', to: '20260617' },
      isLoading: false,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: { candles: [], data_warnings: [], code: '005930', from: '20260616', to: '20260617', source: 'screener_daily' },
      isLoading: false,
      error: null,
    } as never);
  });

  it('requests KIS daily and screener daily in parallel when enabled', () => {
    renderHook(
      () => useResolvedDailyCandles({
        code: '005930',
        from: '20260616',
        to: '20260617',
        venue: 'UN',
        enabled: true,
      }),
      { wrapper },
    );

    expect(mockUseKisDaily).toHaveBeenCalledWith('005930', '20260616', '20260617', 'UN');
    expect(mockUseScreenerDaily).toHaveBeenCalledWith('005930', '20260616', '20260617');
  });

  it('disables both adapters when input is disabled', () => {
    renderHook(
      () => useResolvedDailyCandles({
        code: '005930',
        from: '20260616',
        to: '20260617',
        venue: 'KRX',
        enabled: false,
      }),
      { wrapper },
    );

    expect(mockUseKisDaily).toHaveBeenCalledWith(null, null, null, 'KRX');
    expect(mockUseScreenerDaily).toHaveBeenCalledWith(null, null, null);
  });

  it('uses screener daily rows when KIS daily is empty with kis_rest_bypassed', () => {
    mockUseKisDaily.mockReturnValue({
      data: {
        candles: [],
        data_warnings: [{ batch: '20260616__20260617', reason: 'kis_rest_bypassed', msg: 'cache only' }],
        code: '005930',
        from: '20260616',
        to: '20260617',
      },
      isLoading: false,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100), screenerRow(D2, 110)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () => useResolvedDailyCandles({
        code: '005930',
        from: '20260616',
        to: '20260617',
        venue: 'KRX',
        enabled: true,
      }),
      { wrapper },
    );

    expect(result.current.candles.map((c) => c.close)).toEqual([100, 110]);
    expect(result.current.sourceByDate.get('20260616')).toBe('screener_daily');
    expect(result.current.dataWarnings).toHaveLength(1);
  });

  it('keeps KIS daily for dates where both adapters return rows', () => {
    mockUseKisDaily.mockReturnValue({
      data: { candles: [kisRow(D1, 101)], data_warnings: [], code: '005930', from: '20260616', to: '20260617' },
      isLoading: false,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100), screenerRow(D2, 110)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () => useResolvedDailyCandles({
        code: '005930',
        from: '20260616',
        to: '20260617',
        venue: 'KRX',
        enabled: true,
      }),
      { wrapper },
    );

    expect(result.current.candles.map((c) => c.close)).toEqual([101, 110]);
    expect(result.current.sourceByDate.get('20260616')).toBe('kis_daily');
    expect(result.current.sourceByDate.get('20260617')).toBe('screener_daily');
  });

  it('is usable as soon as either adapter has data', () => {
    mockUseKisDaily.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as never);
    mockUseScreenerDaily.mockReturnValue({
      data: {
        candles: [screenerRow(D1, 100)],
        data_warnings: [],
        code: '005930',
        from: '20260616',
        to: '20260617',
        source: 'screener_daily',
      },
      isLoading: false,
      error: null,
    } as never);

    const { result } = renderHook(
      () => useResolvedDailyCandles({
        code: '005930',
        from: '20260616',
        to: '20260617',
        venue: 'KRX',
        enabled: true,
      }),
      { wrapper },
    );

    expect(result.current.candles).toHaveLength(1);
    expect(result.current.isLoading).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
cd frontend
npm test -- --run src/live/indicators/useResolvedDailyCandles.test.tsx
```

Expected: FAIL with module resolution error for `./useResolvedDailyCandles`.

- [ ] **Step 4: Implement the hook**

Create `frontend/src/live/indicators/useResolvedDailyCandles.ts`:

```ts
import { useMemo } from 'react';
import { useLivePastDailyCandles, type LivePastDailyCandle, type LivePastDailyCandlesWarning } from '../../api/livePastDailyCandles';
import { useScreenerDailyCandles } from '../../api/screenerDailyCandles';
import type { LiveVenueOption } from '../../state/liveVenue';
import { unixMsToKSTDate } from '../../util/time';

export type ResolvedDailyCandleSource = 'kis_daily' | 'screener_daily';

export type ResolvedDailyWarning =
  | LivePastDailyCandlesWarning
  | { batch: string; reason: string; msg: string };

export type UseResolvedDailyCandlesInput = {
  code: string | null;
  from: string | null;
  to: string | null;
  venue: LiveVenueOption;
  enabled: boolean;
};

export type UseResolvedDailyCandlesResult = {
  candles: LivePastDailyCandle[];
  dataWarnings: ResolvedDailyWarning[];
  isLoading: boolean;
  error: unknown;
  sourceByDate: Map<string, ResolvedDailyCandleSource>;
};

const EMPTY_CANDLES: LivePastDailyCandle[] = [];
const EMPTY_WARNINGS: ResolvedDailyWarning[] = [];

function validInputs(input: UseResolvedDailyCandlesInput): { code: string; from: string; to: string } | null {
  if (!input.enabled || !input.code || !input.from || !input.to || input.from > input.to) return null;
  return { code: input.code, from: input.from, to: input.to };
}

export function useResolvedDailyCandles(input: UseResolvedDailyCandlesInput): UseResolvedDailyCandlesResult {
  const resolvedInput = validInputs(input);
  const kisQuery = useLivePastDailyCandles(
    resolvedInput?.code ?? null,
    resolvedInput?.from ?? null,
    resolvedInput?.to ?? null,
    input.venue,
  );
  const screenerQuery = useScreenerDailyCandles(
    resolvedInput?.code ?? null,
    resolvedInput?.from ?? null,
    resolvedInput?.to ?? null,
  );

  return useMemo(() => {
    const byDate = new Map<string, LivePastDailyCandle>();
    const sourceByDate = new Map<string, ResolvedDailyCandleSource>();
    const screenerRows = screenerQuery.data?.candles ?? EMPTY_CANDLES;
    const kisRows = kisQuery.data?.candles ?? EMPTY_CANDLES;

    for (const row of screenerRows) {
      const date = unixMsToKSTDate(row.t_ms);
      byDate.set(date, row);
      sourceByDate.set(date, 'screener_daily');
    }

    for (const row of kisRows) {
      const date = unixMsToKSTDate(row.t_ms);
      byDate.set(date, row);
      sourceByDate.set(date, 'kis_daily');
    }

    const candles = Array.from(byDate.values()).sort((a, b) => a.t_ms - b.t_ms);
    const dataWarnings = [
      ...(kisQuery.data?.data_warnings ?? EMPTY_WARNINGS),
      ...(screenerQuery.data?.data_warnings ?? EMPTY_WARNINGS),
    ];

    return {
      candles,
      dataWarnings,
      isLoading: Boolean(kisQuery.isLoading && screenerQuery.isLoading),
      error: kisQuery.error ?? screenerQuery.error ?? null,
      sourceByDate,
    };
  }, [
    kisQuery.data?.candles,
    kisQuery.data?.data_warnings,
    kisQuery.error,
    kisQuery.isLoading,
    screenerQuery.data?.candles,
    screenerQuery.data?.data_warnings,
    screenerQuery.error,
    screenerQuery.isLoading,
  ]);
}
```

- [ ] **Step 5: Run hook tests to verify they pass**

Run:

```bash
cd frontend
npm test -- --run src/live/indicators/useResolvedDailyCandles.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add frontend/src/api/livePastDailyCandles.ts frontend/src/live/indicators/useResolvedDailyCandles.ts frontend/src/live/indicators/useResolvedDailyCandles.test.tsx
git commit -m "feat: resolve daily candles for daily MA"
```

---

### Task 2: Rewire Daily MA Overlay to Use Resolved Daily Candles

**Files:**
- Modify: `frontend/src/live/indicators/DailyMovingAverageOverlay.tsx`
- Modify: `frontend/src/live/indicators/DailyMovingAverageOverlay.test.tsx`

**Interfaces:**
- Consumes:
  - `useResolvedDailyCandles({ code, from, to, venue, enabled }): UseResolvedDailyCandlesResult`
  - `dailyMaFetchWindow(todayKst: string, configs: readonly LiveMAConfig[]): { from: string; to: string }`
  - `computeDailyMaByDate(daily, period, source, todayKst, todayLiveClose)`
- Produces:
  - Daily MA projection behavior unchanged except daily rows can now come from screener fallback.

- [ ] **Step 1: Change the test mock to the new hook and write the regression test**

Modify the imports and mock at the top of `frontend/src/live/indicators/DailyMovingAverageOverlay.test.tsx`:

```tsx
import { useResolvedDailyCandles } from './useResolvedDailyCandles';
import DailyMovingAverageOverlay from './DailyMovingAverageOverlay';

vi.mock('./useResolvedDailyCandles', () => ({ useResolvedDailyCandles: vi.fn() }));
const mockUseResolvedDaily = vi.mocked(useResolvedDailyCandles);
```

Remove the old import and mock:

```tsx
import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
vi.mock('../../api/livePastDailyCandles', () => ({ useLivePastDailyCandles: vi.fn() }));
const mockUseDaily = vi.mocked(useLivePastDailyCandles);
```

In `beforeEach`, replace:

```tsx
mockUseDaily.mockReturnValue({ data: { candles: dailyCandles } } as never);
```

with:

```tsx
mockUseResolvedDaily.mockReturnValue({
  candles: dailyCandles,
  dataWarnings: [],
  isLoading: false,
  error: null,
  sourceByDate: new Map([['20260612', 'kis_daily']]),
} as never);
```

Replace the old venue-threading test with a resolved-hook input test:

```tsx
it('passes the Daily MA fetch window and venue into resolved daily candles', () => {
  const m = makeChartMock();
  renderOverlay(m, { venue: 'UN' });
  expect(mockUseResolvedDaily).toHaveBeenLastCalledWith({
    code: '005930',
    from: '20250822',
    to: '20260613',
    venue: 'UN',
    enabled: true,
  });
});
```

Add this regression test near the projection tests:

```tsx
it('projects screener fallback daily rows when KIS daily is unavailable', () => {
  mockUseResolvedDaily.mockReturnValue({
    candles: dailyCandles,
    dataWarnings: [{ batch: '20260612__20260612', reason: 'kis_rest_bypassed', msg: 'cache only' }],
    isLoading: false,
    error: null,
    sourceByDate: new Map([['20260612', 'screener_daily']]),
  } as never);
  const m = makeChartMock();
  renderOverlay(m);

  const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
  const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ time: number; value?: number }>;
  expect(data).toHaveLength(3);
  expect(data.every((d) => d.value === 100)).toBe(true);
});
```

Update the empty daily response test to use the new hook:

```tsx
it('empty resolved daily response → no values, no throw', () => {
  mockUseResolvedDaily.mockReturnValue({
    candles: [],
    dataWarnings: [],
    isLoading: false,
    error: null,
    sourceByDate: new Map(),
  } as never);
  const m = makeChartMock();
  expect(() => renderOverlay(m)).not.toThrow();
  const first = m.addSeries.mock.results[0].value as { setData: ReturnType<typeof vi.fn> };
  const data = first.setData.mock.calls.at(-1)?.[0] as Array<{ value?: number }>;
  expect(data.every((d) => d.value === undefined)).toBe(true);
});
```

- [ ] **Step 2: Run overlay tests to verify they fail**

Run:

```bash
cd frontend
npm test -- --run src/live/indicators/DailyMovingAverageOverlay.test.tsx
```

Expected: FAIL because `DailyMovingAverageOverlay` still imports and calls `useLivePastDailyCandles`, not `useResolvedDailyCandles`.

- [ ] **Step 3: Rewire `DailyMovingAverageOverlay`**

Modify `frontend/src/live/indicators/DailyMovingAverageOverlay.tsx`.

Replace this import:

```ts
import { useLivePastDailyCandles } from '../../api/livePastDailyCandles';
```

with:

```ts
import { useResolvedDailyCandles } from './useResolvedDailyCandles';
```

Replace:

```ts
const dailyQuery = useLivePastDailyCandles(enabled ? code : null, fetchWindow?.from ?? null, fetchWindow?.to ?? null, venue);
const daily = dailyQuery.data?.candles ?? EMPTY_DAILY;
```

with:

```ts
const dailyQuery = useResolvedDailyCandles({
  code,
  from: fetchWindow?.from ?? null,
  to: fetchWindow?.to ?? null,
  venue,
  enabled,
});
const daily = dailyQuery.candles;
```

Remove:

```ts
const EMPTY_DAILY: never[] = [];
```

- [ ] **Step 4: Run overlay and hook tests**

Run:

```bash
cd frontend
npm test -- --run src/live/indicators/useResolvedDailyCandles.test.tsx src/live/indicators/DailyMovingAverageOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add frontend/src/live/indicators/DailyMovingAverageOverlay.tsx frontend/src/live/indicators/DailyMovingAverageOverlay.test.tsx
git commit -m "fix: feed daily MA from resolved daily candles"
```

---

### Task 3: Verify Existing Daily MA Settings and Bypass Regression Coverage

**Files:**
- Modify only if needed: `frontend/src/live/indicators/DailyMovingAverageConfig.test.tsx`
- Modify only if needed: `frontend/src/state/livePage.dailyMa.test.ts`
- Modify only if needed: `frontend/src/live/indicators/IndicatorPanel.test.tsx`

**Interfaces:**
- Consumes:
  - `setDailyMovingAverageEnabled(true)` clears stale `dailyMovingAverageHidden`.
  - `DailyMovingAverageConfig` exposes `일봉 MA 표시` and `일봉 MA 선 숨김`.
- Produces:
  - No new production Interface. This task is a verification gate around the previously merged PR #412 behavior plus the new resolved-daily path.

- [ ] **Step 1: Run the Daily MA settings and indicator tests**

Run:

```bash
cd frontend
npm test -- --run \
  src/live/indicators/DailyMovingAverageConfig.test.tsx \
  src/state/livePage.dailyMa.test.ts \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/live/indicators/useResolvedDailyCandles.test.tsx \
  src/live/indicators/DailyMovingAverageOverlay.test.tsx
```

Expected: PASS.

- [ ] **Step 2: If tests fail due to stale mocks, update only the affected test mock**

If a failure says `useResolvedDailyCandles` is not mocked or the hook query order changed, update the specific test file that imports `DailyMovingAverageOverlay` to mock the hook explicitly:

```tsx
vi.mock('./indicators/useResolvedDailyCandles', () => ({
  useResolvedDailyCandles: () => ({
    candles: [],
    dataWarnings: [],
    isLoading: false,
    error: null,
    sourceByDate: new Map(),
  }),
}));
```

Use the relative import path that matches the failing test file. Do not add a broad global mock.

- [ ] **Step 3: Run the focused tests again**

Run the same command from Step 1.

Expected: PASS.

- [ ] **Step 4: Commit only if files changed**

If Step 2 required test updates:

```bash
git add frontend/src/live/indicators/DailyMovingAverageConfig.test.tsx frontend/src/state/livePage.dailyMa.test.ts frontend/src/live/indicators/IndicatorPanel.test.tsx
git commit -m "test: keep daily MA settings coverage with resolved daily candles"
```

If no files changed, do not create an empty commit.

---

### Task 4: Final Verification and PR Notes

**Files:**
- Modify: no production files expected.
- Modify only if needed: PR description or release notes outside this plan.

**Interfaces:**
- Consumes:
  - `useResolvedDailyCandles` from Task 1.
  - `DailyMovingAverageOverlay` rewire from Task 2.
  - Settings verification from Task 3.
- Produces:
  - Verified implementation ready for PR.

- [ ] **Step 1: Run focused test suite**

Run:

```bash
cd frontend
npm test -- --run \
  src/live/indicators/useResolvedDailyCandles.test.tsx \
  src/live/indicators/DailyMovingAverageOverlay.test.tsx \
  src/live/indicators/DailyMovingAverageConfig.test.tsx \
  src/state/livePage.dailyMa.test.ts \
  src/live/indicators/IndicatorPanel.test.tsx \
  src/state/liveIndicatorsPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run production build**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run full frontend test sweep and record known unrelated failures**

Run:

```bash
cd frontend
npm test -- --run
```

Expected based on current main history: may fail in `src/pages/Screener.test.tsx` because the `../api/liveQuotes` mock does not define `isStaleLiveQuote`. If this still fails, record it in the PR body as unrelated to Daily MA. If it passes, record the pass.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check
```

Expected: only the new hook, hook test, overlay, and overlay test changed; `git diff --check` exits 0.

- [ ] **Step 5: Leave final verification uncommitted unless implementation files changed**

Most implementations will not need a commit in this task. If Step 4 reveals a real implementation or test fix is needed, make that fix in the relevant source file and commit the exact file from that fix. Do not create a verification-only commit.

Do not commit generated `frontend/dist` output.
