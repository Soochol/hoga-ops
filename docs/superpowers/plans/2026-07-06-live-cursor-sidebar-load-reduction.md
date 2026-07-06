# Live Cursor Sidebar Load Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `/live` browser CPU and spot API churn while moving the crosshair over minute charts, especially after historical backfill.

**Architecture:** Keep `cursorMs` as the immediate chart cursor signal so existing chart-local behavior remains responsive. Add a separate `sidebarCursorMs` signal that is bucket-aligned and rate-limited before `LiveSidebar` and cursor-keyed REST hooks consume it. Then narrow the sidebar subscription so hover movement does not re-render the full right panel on every crosshair event.

**Tech Stack:** React 18, Zustand, Vitest, Testing Library, Vite, Playwright/CDP for manual verification.

## Global Constraints

- Do not change `/api/range` hoga/sidecar delta behavior in this plan.
- Keep `cursorMs` backward-compatible for existing chart tests.
- Spot mode remains minute-timeframe only.
- `sidebarCursorMs` must be bucket-aligned so moving within one minute does not refetch `/api/orderbook`.
- No new runtime dependencies.

---

## Scope

### Scope In

- Reduce the blast radius of chart crosshair hover by moving sidebar consumers from immediate `cursorMs` to rate-limited `sidebarCursorMs`.
- Reduce spot API churn by making `/api/orderbook` and `/api/brokers/series` read `sidebarCursorMs`, not raw crosshair movement.
- Keep dev and production browser profiling in the verification budget because the investigation showed Vite dev mode amplifies React render cost.

### Scope Out

- Do not shrink the initial `mode=sidecar` payload in this plan. The observed initial sidecar response was large, but that is a data-shape/cache/compression concern, not the cursor-hover render path.
- Do not change `/api/live/past-candles` abort behavior in this plan. The observed `AbortError` looked like query replacement/log noise, not the current CPU root cause.
- Do not refactor `LiveDetailPanel` card layout unless the cursor split fails to reduce measured render cost.

### Regression Watch

- Initial `mode=sidecar` payload size and latency must not increase from the investigation baseline.
- Historical extension must still use delta range requests, not full `20260624~20260706` hoga/sidecar refetches.
- `/api/live/past-candles` aborts must not surface as user-visible errors.
- Production hover CPU must remain low; dev hover CPU should materially improve from the observed `4.3s active JS / ~4.5s scenario`.

---

## File Structure

- Modify: `frontend/src/live/useLiveCursorStore.ts`
  - Own immediate cursor state and new sidebar-specific cursor state.
- Modify: `frontend/src/live/useLiveCursorStore.test.ts`
  - Unit coverage for `sidebarCursorMs` identity, clear, restore, and reset behavior.
- Create: `frontend/src/live/sidebarCursorRateLimit.ts`
  - Pure helper for aligning cursor timestamps to buckets and deciding whether a sidebar cursor publish is necessary.
- Create: `frontend/src/live/sidebarCursorRateLimit.test.ts`
  - Unit coverage for minute bucket alignment and null guards.
- Modify: `frontend/src/live/LiveChartRoot.tsx`
  - Schedule `sidebarCursorMs` updates with a short trailing debounce while preserving immediate `cursorMs`.
- Modify: `frontend/src/live/LiveChartRoot.test.tsx`
  - Assert rapid crosshair movement updates `cursorMs` immediately but only publishes one sidebar cursor after timers advance.
- Modify: `frontend/src/live/LiveSidebar.tsx`
  - Subscribe to `sidebarCursorMs`, not `cursorMs`.
- Modify: `frontend/src/api/useLiveCursor.ts`
  - Use `sidebarCursorMs` for `/api/orderbook` and `/api/brokers/series` keys.
- Modify: `frontend/src/api/useLiveCursor.test.ts`
  - Assert same-bucket rapid immediate cursor movement does not refetch until `sidebarCursorMs` changes.
- Modify: `frontend/src/live/LiveSidebar.test.tsx`
  - Update cursor-branching tests to publish `sidebarCursorMs` where sidebar behavior is under test.

---

### Task 1: Add Sidebar Cursor State And Pure Rate-Limit Helpers

**Files:**
- Modify: `frontend/src/live/useLiveCursorStore.ts`
- Modify: `frontend/src/live/useLiveCursorStore.test.ts`
- Create: `frontend/src/live/sidebarCursorRateLimit.ts`
- Create: `frontend/src/live/sidebarCursorRateLimit.test.ts`

**Interfaces:**
- Produces: `alignSidebarCursorMs(cursorMs: number, bucketMs: number | null): number`
- Produces: `shouldPublishSidebarCursor(current: number | null, next: number | null): boolean`
- Produces store fields/actions:
  - `sidebarCursorMs: number | null`
  - `setSidebarCursor(t: number): void`
  - `clearSidebarCursor(): void`

- [ ] **Step 1: Write failing helper tests**

Add `frontend/src/live/sidebarCursorRateLimit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { alignSidebarCursorMs, shouldPublishSidebarCursor } from './sidebarCursorRateLimit';

describe('sidebar cursor rate-limit helpers', () => {
  it('aligns to the bucket floor', () => {
    expect(alignSidebarCursorMs(1_779_930_029_999, 60_000)).toBe(1_779_930_000_000);
    expect(alignSidebarCursorMs(1_779_930_060_000, 60_000)).toBe(1_779_930_060_000);
  });

  it('keeps the raw cursor when bucket is unavailable', () => {
    expect(alignSidebarCursorMs(1_779_930_029_999, null)).toBe(1_779_930_029_999);
    expect(alignSidebarCursorMs(1_779_930_029_999, 0)).toBe(1_779_930_029_999);
  });

  it('publishes only when the sidebar cursor value changes', () => {
    expect(shouldPublishSidebarCursor(null, 1)).toBe(true);
    expect(shouldPublishSidebarCursor(1, 1)).toBe(false);
    expect(shouldPublishSidebarCursor(1, 2)).toBe(true);
    expect(shouldPublishSidebarCursor(null, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing store tests**

Append to `frontend/src/live/useLiveCursorStore.test.ts`:

```ts
it('setSidebarCursor stores a sidebar-specific value without changing cursorMs', () => {
  useLiveCursorStore.getState().setCursor(1748400000123);
  useLiveCursorStore.getState().setSidebarCursor(1748400000000);

  expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
  expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1748400000000);
});

it('setSidebarCursor with same value is a no-op for subscribers', () => {
  useLiveCursorStore.getState().setSidebarCursor(123);
  let calls = 0;
  const unsub = useLiveCursorStore.subscribe((state) => {
    if (state.sidebarCursorMs === 123) calls += 1;
  });
  useLiveCursorStore.getState().setSidebarCursor(123);
  unsub();
  expect(calls).toBe(0);
});

it('clearSidebarCursor clears only sidebarCursorMs', () => {
  useLiveCursorStore.getState().setCursor(1748400000123);
  useLiveCursorStore.getState().setSidebarCursor(1748400000000);
  useLiveCursorStore.getState().clearSidebarCursor();

  expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
  expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
cd frontend
npm run test -- --run src/live/sidebarCursorRateLimit.test.ts src/live/useLiveCursorStore.test.ts
```

Expected: FAIL because `sidebarCursorRateLimit.ts`, `sidebarCursorMs`, and sidebar actions do not exist.

- [ ] **Step 4: Implement helpers**

Create `frontend/src/live/sidebarCursorRateLimit.ts`:

```ts
export function alignSidebarCursorMs(cursorMs: number, bucketMs: number | null): number {
  if (bucketMs === null || !(bucketMs > 0)) return cursorMs;
  return Math.floor(cursorMs / bucketMs) * bucketMs;
}

export function shouldPublishSidebarCursor(current: number | null, next: number | null): boolean {
  return current !== next;
}
```

- [ ] **Step 5: Extend store**

Update `frontend/src/live/useLiveCursorStore.ts`:

```ts
interface State {
  cursorMs: number | null;
  lastCursorMs: number | null;
  sidebarCursorMs: number | null;
  setCursor: (t: number) => void;
  setSidebarCursor: (t: number) => void;
  clearCursor: () => void;
  clearSidebarCursor: () => void;
  restoreCursor: () => void;
  resetCursor: () => void;
}
```

Inside the store initializer, add:

```ts
sidebarCursorMs: null,
setSidebarCursor: (t) => {
  if (get().sidebarCursorMs === t) return;
  set({ sidebarCursorMs: t });
},
clearSidebarCursor: () => {
  if (get().sidebarCursorMs === null) return;
  set({ sidebarCursorMs: null });
},
```

Update `resetCursor` to clear all cursor state:

```ts
resetCursor: () => {
  const { cursorMs, lastCursorMs, sidebarCursorMs } = get();
  if (cursorMs === null && lastCursorMs === null && sidebarCursorMs === null) return;
  set({ cursorMs: null, lastCursorMs: null, sidebarCursorMs: null });
},
```

- [ ] **Step 6: Run tests and verify pass**

Run:

```bash
cd frontend
npm run test -- --run src/live/sidebarCursorRateLimit.test.ts src/live/useLiveCursorStore.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/live/sidebarCursorRateLimit.ts frontend/src/live/sidebarCursorRateLimit.test.ts frontend/src/live/useLiveCursorStore.ts frontend/src/live/useLiveCursorStore.test.ts
git commit -m "feat: add rate-limited live sidebar cursor state"
```

---

### Task 2: Publish Sidebar Cursor From LiveChartRoot With Trailing Debounce

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveChartRoot.test.tsx`

**Interfaces:**
- Consumes: `alignSidebarCursorMs(cursorMs, bucketMs)`
- Consumes: `useLiveCursorStore.getState().setSidebarCursor(t)`
- Produces: `cursorMs` remains immediate; `sidebarCursorMs` updates after `LIVE_SIDEBAR_CURSOR_DEBOUNCE_MS`.

- [ ] **Step 1: Write failing LiveChartRoot test**

Add a test near the existing crosshair cursor tests in `frontend/src/live/LiveChartRoot.test.tsx`:

```ts
it('debounces sidebar cursor while keeping chart cursor immediate', async () => {
  vi.useFakeTimers();
  try {
    const onCursorActiveChange = vi.fn();
    render(
      <LiveChartRoot
        code="005930"
        bundle={TODAY_ONLY_BUNDLE}
        timeframe="1m"
        isPastCandlesLoading={false}
        isExtending={false}
        onCursorActiveChange={onCursorActiveChange}
      />,
    );

    await act(async () => {
      chartMock.emitCrosshairMove({ time: virtualTimeForMs(TODAY_OPEN_MS), point: { x: 100 } });
      await Promise.resolve();
    });

    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS);
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();

    await act(async () => {
      chartMock.emitCrosshairMove({ time: virtualTimeForMs(TODAY_OPEN_MS + 29_000), point: { x: 110 } });
      chartMock.emitCrosshairMove({ time: virtualTimeForMs(TODAY_OPEN_MS + 59_000), point: { x: 120 } });
      vi.advanceTimersByTime(119);
      await Promise.resolve();
    });

    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(TODAY_OPEN_MS);
  } finally {
    vi.useRealTimers();
  }
});
```

If the local test helper names differ, use the existing test fixture helpers in the same file for emitting crosshair move events and virtual time conversion.

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
cd frontend
npm run test -- --run src/live/LiveChartRoot.test.tsx -t "debounces sidebar cursor"
```

Expected: FAIL because `sidebarCursorMs` is never scheduled.

- [ ] **Step 3: Implement scheduling in LiveChartRoot**

In `frontend/src/live/LiveChartRoot.tsx`, import helper:

```ts
import { alignSidebarCursorMs, shouldPublishSidebarCursor } from './sidebarCursorRateLimit';
```

Add constant near other cursor constants:

```ts
const LIVE_SIDEBAR_CURSOR_DEBOUNCE_MS = 120;
```

Add refs near `drawingHoverRafRef` / cursor refs:

```ts
const sidebarCursorTimeoutRef = useRef<number | null>(null);
const pendingSidebarCursorMsRef = useRef<number | null>(null);
```

Add scheduler inside the component:

```ts
const scheduleSidebarCursor = useCallback((cursorMs: number) => {
  const store = useLiveCursorStore.getState();
  const aligned = alignSidebarCursorMs(cursorMs, bucketMsRef.current);
  pendingSidebarCursorMsRef.current = aligned;
  if (sidebarCursorTimeoutRef.current !== null) {
    window.clearTimeout(sidebarCursorTimeoutRef.current);
  }
  sidebarCursorTimeoutRef.current = window.setTimeout(() => {
    sidebarCursorTimeoutRef.current = null;
    const next = pendingSidebarCursorMsRef.current;
    pendingSidebarCursorMsRef.current = null;
    if (next === null) return;
    const current = useLiveCursorStore.getState().sidebarCursorMs;
    if (shouldPublishSidebarCursor(current, next)) {
      useLiveCursorStore.getState().setSidebarCursor(next);
    }
  }, LIVE_SIDEBAR_CURSOR_DEBOUNCE_MS);
}, []);
```

Update `publishCursorMs` so it keeps immediate cursor behavior and schedules sidebar cursor:

```ts
const publishCursorMs = (cursorMs: number) => {
  if (publishedCursorMsRef.current === cursorMs && store.cursorMs === cursorMs) {
    scheduleSidebarCursor(cursorMs);
    return;
  }
  publishedCursorMsRef.current = cursorMs;
  store.setCursor(cursorMs);
  scheduleSidebarCursor(cursorMs);
};
```

In every leave/reset cleanup that currently calls `clearCursor()` or `resetCursor()`, also cancel pending sidebar timer and clear `sidebarCursorMs`:

```ts
if (sidebarCursorTimeoutRef.current !== null) {
  window.clearTimeout(sidebarCursorTimeoutRef.current);
  sidebarCursorTimeoutRef.current = null;
}
pendingSidebarCursorMsRef.current = null;
useLiveCursorStore.getState().clearSidebarCursor();
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
cd frontend
npm run test -- --run src/live/LiveChartRoot.test.tsx src/live/useLiveCursorStore.test.ts src/live/sidebarCursorRateLimit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "perf: debounce live sidebar cursor publishing"
```

---

### Task 3: Move Sidebar And Spot Hooks To `sidebarCursorMs`

**Files:**
- Modify: `frontend/src/live/LiveSidebar.tsx`
- Modify: `frontend/src/api/useLiveCursor.ts`
- Modify: `frontend/src/live/LiveSidebar.test.tsx`
- Modify: `frontend/src/api/useLiveCursor.test.ts`

**Interfaces:**
- Consumes: `useLiveCursorStore((s) => s.sidebarCursorMs)`
- Produces: `LiveSidebar` no longer re-renders on every immediate `cursorMs` update.

- [ ] **Step 1: Write failing API hook test**

In `frontend/src/api/useLiveCursor.test.ts`, add a test for orderbook:

```ts
it('orderbook waits for sidebarCursorMs instead of immediate cursorMs', async () => {
  renderHook(() => useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m' }));

  act(() => useLiveCursorStore.getState().setCursor(1_779_930_001_234));
  await Promise.resolve();
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/orderbook'), expect.anything());

  act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/orderbook?code=005930&date=20260528&t=1779930000000'),
      expect.anything(),
    );
  });
});
```

Adjust `fetchMock` naming to the existing mock helper in the file.

- [ ] **Step 2: Write failing sidebar render test**

In `frontend/src/live/LiveSidebar.test.tsx`, add:

```ts
it('does not switch to spot mode from immediate cursorMs alone', () => {
  renderSidebar({ code: '005930', live: emptyLive, bundle: bundleFixture });

  const latestCandleMs = bundleFixture.candles[bundleFixture.candles.length - 1].ts_ms;
  act(() => useLiveCursorStore.getState().setCursor(latestCandleMs));

  expect(cursorHooks.useLiveOrderbookAtCursor).toHaveBeenLastCalledWith(
    expect.objectContaining({ code: '005930' }),
  );
  expect(screen.queryByText('커서 위치 로딩 중…')).toBeNull();
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
cd frontend
npm run test -- --run src/api/useLiveCursor.test.ts src/live/LiveSidebar.test.tsx
```

Expected: FAIL because both consumers still read immediate `cursorMs`.

- [ ] **Step 4: Switch consumers**

In `frontend/src/live/LiveSidebar.tsx`, change:

```ts
const cursorMs = useLiveCursorStore((s) => s.cursorMs);
```

to:

```ts
const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
```

In `frontend/src/api/useLiveCursor.ts`, change both hook selectors:

```ts
const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
```

- [ ] **Step 5: Update existing tests that intentionally drive sidebar behavior**

Where `LiveSidebar.test.tsx` currently calls:

```ts
act(() => useLiveCursorStore.getState().setCursor(t));
```

and the assertion is about sidebar spot behavior, replace with:

```ts
act(() => useLiveCursorStore.getState().setSidebarCursor(t));
```

Keep `setCursor` in tests whose assertion is specifically about immediate chart cursor state.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd frontend
npm run test -- --run src/api/useLiveCursor.test.ts src/live/LiveSidebar.test.tsx src/live/LiveChartRoot.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/live/LiveSidebar.tsx frontend/src/api/useLiveCursor.ts frontend/src/live/LiveSidebar.test.tsx frontend/src/api/useLiveCursor.test.ts
git commit -m "perf: move live sidebar spot data to rate-limited cursor"
```

---

### Task 4: Browser Verification And Regression Budget

**Files:**
- No production files unless verification exposes a bug.
- Optional: update `docs/superpowers/plans/2026-07-06-live-cursor-sidebar-load-reduction.md` with final measured numbers.

**Interfaces:**
- Consumes: implemented `sidebarCursorMs` path.
- Produces: measured before/after evidence for hover CPU, cursor updates, and spot API request count.

- [ ] **Step 1: Run full focused test set**

Run:

```bash
cd frontend
npm run test -- --run src/live/useLiveCursorStore.test.ts src/live/sidebarCursorRateLimit.test.ts src/live/LiveChartRoot.test.tsx src/live/LiveSidebar.test.tsx src/api/useLiveCursor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Build production bundle**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run dev browser profile**

Use the same Playwright/CDP profile script from the investigation with URL:

```text
http://127.0.0.1:5173/live?code=005930
```

Procedure:

```text
1. Set localStorage hoga.perf.debug=1.
2. Wait for initial hoga and sidecar range responses.
3. extendHistoricalRange('20260624').
4. Sweep crosshair across the chart 100 times.
5. Record cursor store changes, /api/orderbook count, /api/brokers/series count, and active JS time.
```

Expected improvement target:

```text
sidebarCursorMs changes: <= 5 for a 100-point sweep
/api/orderbook requests: <= 3 for a 100-point sweep
dev active JS time: materially lower than the observed 4.3s active / ~4.5s scenario
initial mode=sidecar payload size and latency do not increase from baseline
/api/live/past-candles AbortError does not appear as a page-visible error
```

- [ ] **Step 4: Run production preview browser profile**

Run:

```bash
cd frontend
npm run preview -- --host 127.0.0.1 --port 4173
```

Profile:

```text
http://127.0.0.1:4173/live?code=005930
```

Expected:

```text
prod hover remains low CPU.
No full-range hoga/sidecar requests appear during historical extension.
Spot API count is bounded by sidebarCursorMs publishes, not raw crosshair events.
Initial sidecar payload/latency is not worse than the investigation baseline.
Any past-candles abort remains non-user-visible.
```

- [ ] **Step 5: Commit verification notes if numbers are added**

```bash
git add docs/superpowers/plans/2026-07-06-live-cursor-sidebar-load-reduction.md
git commit -m "docs: record live cursor performance verification"
```

Skip this commit if no doc changes are made.

---

## Self-Review

- Spec coverage: The plan addresses the observed bottleneck: raw crosshair cursor events cause full sidebar rerenders and spot API churn. Vite dev amplification is captured in verification. Initial sidecar payload and past-candles abort cleanup are explicitly out of implementation scope and covered by regression watch.
- Placeholder scan: No implementation step relies on a generic "handle edge cases" instruction. Each task has explicit files, tests, commands, and expected outcomes.
- Type consistency: `sidebarCursorMs`, `setSidebarCursor`, `clearSidebarCursor`, `alignSidebarCursorMs`, and `shouldPublishSidebarCursor` are defined before later tasks consume them.
