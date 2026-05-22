# Replay Data-Load Crash Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /replay 페이지에서 종목 데이터 로드 시 `lightweight-charts` 어설션으로 React root가 unmount되는 critical 버그를 고치고, 같은 종류의 장애가 재발해도 사이드 네비를 살리도록 에러 바운더리를 추가하며, OnboardingCard 단계 표시기를 toolbar 사용자 입력에 반응하게 한다.

**Architecture:** (1) `util/time.ts`에 `isWithinSessions` 가드를 추가하고 4개 차트 pane(`CandlePane`, `VolumePane`, `RatioPane`, `FillStrengthPane`)이 시계열 데이터를 mapping하기 전에 이 가드로 pre-open auction 시각을 거른다 — virtual axis의 "연속 거래 시간만" 의미를 보존. (2) `ChartErrorBoundary`를 도입해 `Workarea`가 `ChartStage`를 감싸 어떤 pane이 throw해도 폴백 UI만 영향. (3) 작은 zustand 스토어(`useToolbarDraftStore`)로 Toolbar의 draft state를 OnboardingCard와 공유해 단계 표시기가 사용자 선택에 실시간 반응.

**Tech Stack:** React 18, TypeScript, vitest (unit/component), Playwright (e2e), zustand, lightweight-charts, @testing-library/react.

**관련 QA 리포트:** `.gstack/qa-reports/qa-report-localhost-replay-2026-05-22.md` (ISSUE-001/002/003).

---

## File Structure

생성:
- `frontend/src/chart/ChartErrorBoundary.tsx` — `ChartStage`를 감싸는 클래스형 ErrorBoundary. 자식이 throw하면 폴백 UI만 렌더.
- `frontend/src/state/toolbarDraft.ts` — Toolbar의 draft selection을 active tab id 기준으로 보관하는 zustand 스토어. OnboardingCard도 구독.
- `frontend/tests/component/ChartErrorBoundary.test.tsx` — ErrorBoundary 회귀 테스트.
- `frontend/tests/unit/toolbarDraft.test.ts` — Draft 스토어 회귀 테스트.

수정:
- `frontend/src/util/time.ts` — `isWithinSessions(segments, realMs): boolean` export 추가, `realToVirtual` JSDoc에 pre-session clamp 동작을 명시.
- `frontend/src/util/time.test.ts` (현재 위치: `frontend/tests/unit/time.test.ts`) — `isWithinSessions` 및 `realToVirtual` pre-session 회귀 테스트 추가.
- `frontend/src/chart/CandlePane.tsx` — 데이터 mapping 전에 `isWithinSessions` 필터.
- `frontend/src/chart/VolumePane.tsx` — 동일 필터.
- `frontend/src/chart/RatioPane.tsx` — 동일 필터.
- `frontend/src/chart/FillStrengthPane.tsx` — 동일 필터 (buy/sell 두 series 모두).
- `frontend/tests/component/CandlePane.test.tsx` — pre-session 캔들 회귀 케이스.
- `frontend/tests/component/VolumePane.test.tsx` — 동일.
- `frontend/tests/component/RatioPane.test.tsx` — 동일.
- `frontend/tests/component/FillStrengthPane.test.tsx` — 동일.
- `frontend/src/replay/Workarea.tsx` — `ChartStage`를 `ChartErrorBoundary`로 감싸기.
- `frontend/src/replay/Toolbar.tsx` — local state 대신 `useToolbarDraftStore` 사용.
- `frontend/src/replay/OnboardingCard.tsx` — draft 스토어를 구독해 단계 갱신.
- `frontend/tests/e2e/replay-smoke.spec.ts` — pre-open auction 데이터가 있는 fixture에서도 5개 pane이 mount되는지 검증.

영향 받지 않음:
- `IntensityPane.tsx` — 같은 `realToVirtual`을 호출하지만 자체적으로 `xFloat === null` 체크가 있어 throw하지 않음. Pre-session 데이터가 visual artifact를 만들 수 있으나 본 플랜 범위 외(다른 PR에서 다룸).
- `VolumeProfileOverlay.tsx` — sessionOpen/Close만 mapping해 throw 위험 없음.

---

## Phase 1 — Fix critical crash (ISSUE-001)

### Task 1: `isWithinSessions` 헬퍼 + `realToVirtual` pre-session 동작 회귀 테스트

**Files:**
- Modify: `frontend/src/util/time.ts`
- Modify: `frontend/tests/unit/time.test.ts`

- [ ] **Step 1: Write failing tests for `isWithinSessions`**

`frontend/tests/unit/time.test.ts` 끝에 추가:

```typescript
import { isWithinSessions, realToVirtual, type Segment } from '../../src/util/time';

const seg = (date: string, openMs: number, lengthMs: number, virtualStart = 0): Segment => ({
  date,
  sessionOpenMs: openMs,
  sessionCloseMs: openMs + lengthMs,
  virtualStart,
});

describe('isWithinSessions', () => {
  const segments: Segment[] = [seg('20260511', 1_778_457_600_000, 23_400_000)];

  it('returns false for empty segments', () => {
    expect(isWithinSessions([], 1_778_457_600_000)).toBe(false);
  });
  it('returns false for ts before session open (pre-open auction)', () => {
    // 30 minutes before session open — the exact scenario that crashed prod
    expect(isWithinSessions(segments, 1_778_455_800_000)).toBe(false);
  });
  it('returns true at session open boundary', () => {
    expect(isWithinSessions(segments, 1_778_457_600_000)).toBe(true);
  });
  it('returns true inside session', () => {
    expect(isWithinSessions(segments, 1_778_457_600_000 + 3_600_000)).toBe(true);
  });
  it('returns true at session close boundary', () => {
    expect(isWithinSessions(segments, 1_778_457_600_000 + 23_400_000)).toBe(true);
  });
  it('returns false in inter-session gap', () => {
    const multi: Segment[] = [
      seg('20260511', 1_778_457_600_000, 23_400_000, 0),
      seg('20260512', 1_778_544_000_000, 23_400_000, 23_400_000),
    ];
    // Between day-1 close and day-2 open
    expect(isWithinSessions(multi, 1_778_500_000_000)).toBe(false);
  });
});

describe('realToVirtual — documented pre-session clamp', () => {
  const segments: Segment[] = [seg('20260511', 1_778_457_600_000, 23_400_000)];
  it('clamps any pre-session time to virtualStart (0) — consumers MUST filter first', () => {
    // This is the documented behavior that caused ISSUE-001 when consumers
    // forgot to filter. We keep it for backward compatibility with
    // viewport publishing in ChartStage; chart panes now filter upstream.
    expect(realToVirtual(segments, 1_778_455_800_000)).toBe(0);
    expect(realToVirtual(segments, 1_778_457_600_000)).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/unit/time.test.ts`
Expected: FAIL with "isWithinSessions is not a function" (or similar import error).

- [ ] **Step 3: Add `isWithinSessions` to `frontend/src/util/time.ts`**

`util/time.ts`의 `isDayBoundary` export 바로 위에 추가:

```typescript
/**
 * True if realMs falls inside ANY segment's [sessionOpenMs, sessionCloseMs]
 * (inclusive on both ends). Used by chart panes to filter out pre-open auction
 * candles (8:30–9:00 KST) and post-close points before mapping through
 * `realToVirtual`. Without this guard, those points collapse to virtual time
 * 0 and lightweight-charts throws "data must be asc ordered by time" on the
 * second clamped point.
 *
 * Returns false for empty segments.
 */
export function isWithinSessions(segments: Segment[], realMs: number): boolean {
  for (const seg of segments) {
    if (realMs >= seg.sessionOpenMs && realMs <= seg.sessionCloseMs) return true;
  }
  return false;
}
```

또한 `realToVirtual` JSDoc(line 56-67) 마지막 줄에 다음 문구 추가:

```typescript
 *  - Pre-session times collapse to virtualStart=0. CALLERS THAT PRODUCE
 *    SERIES DATA MUST PRE-FILTER WITH `isWithinSessions` — otherwise two
 *    pre-session points produce duplicate virtual-time=0 entries and
 *    lightweight-charts' setData throws.
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/time.test.ts`
Expected: PASS (all `isWithinSessions` and `realToVirtual — documented pre-session clamp` cases green; existing `unixMsToKSTClock` and `formatElapsed` suites remain green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/util/time.ts frontend/tests/unit/time.test.ts
git commit -m "feat(util/time): add isWithinSessions guard for pre-session filter

Documents the long-standing realToVirtual clamp behavior and gives chart
panes a single-source-of-truth guard so pre-open auction candles can be
dropped before they reach lightweight-charts.setData (which asserts on
duplicate virtual-time=0 entries)."
```

---

### Task 2: CandlePane filter pre-session candles

**Files:**
- Modify: `frontend/src/chart/CandlePane.tsx`
- Modify: `frontend/tests/component/CandlePane.test.tsx`

- [ ] **Step 1: Add failing regression test to `CandlePane.test.tsx`**

`describe('CandlePane', () => { ... })` 안의 마지막 `it(...)` 다음에 추가:

```typescript
  it('drops pre-open auction candles that fall outside any segment', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      candles: [
        // pre-open auction (8:30 KST, 30 min before sessionOpen) — must be dropped
        { ts_ms: sessionOpenMs - 30 * 60_000, open: 27050, close: 27050, high: 27050, low: 27050, vol_a: 111, vol_b: 0 },
        // session-open candle — kept
        { ts_ms: sessionOpenMs, open: 27050, close: 27100, high: 27100, low: 27050, vol_a: 200, vol_b: 50 },
        // mid-session candle — kept
        { ts_ms: sessionOpenMs + 60_000, open: 27100, close: 27090, high: 27110, low: 27080, vol_a: 50, vol_b: 80 },
      ],
    };
    render(
      <CandlePane
        chart={chart}
        bundle={bundle}
        segments={[
          {
            date: '20260511',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
            virtualStart: 0,
          },
        ]}
      />,
    );
    expect(series.setData).toHaveBeenCalledTimes(1);
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(2); // pre-open dropped
    // Times must be strictly ascending and non-zero-duplicate
    expect(data[0].time).toBe(0);                    // session-open at virtualStart=0
    expect(data[1].time).toBe(60);                   // +60s in virtual axis (seconds)
    expect(data[0].time).toBeLessThan(data[1].time); // ASC ordered
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/component/CandlePane.test.tsx`
Expected: FAIL — current code maps all 3 candles, producing `data[0].time === 0` and `data[1].time === 0` (and the test expects length=2 with 0 < 60).

- [ ] **Step 3: Fix `frontend/src/chart/CandlePane.tsx`**

상단 import 줄 수정:

```typescript
import { type Segment, realToVirtual, isWithinSessions } from '../util/time';
```

`useEffect` 내부의 `const data = bundle.candles.map(...)` 블록(line 50-70)을 다음으로 교체:

```typescript
    // Drop pre-open auction candles (8:30-9:00 KST) and any other points that
    // fall outside the regular-session segments — they would all collapse to
    // virtual-time=0 and lightweight-charts.setData would throw "asc ordered
    // by time" on the duplicate. See util/time.ts:isWithinSessions docs.
    const data = bundle.candles
      .filter((c) => isWithinSessions(segments, c.ts_ms))
      .map((c) => {
        const inAuctionOrAfter = c.ts_ms >= auctionThresholdMs;
        const color = inAuctionOrAfter ? muted : c.close >= c.open ? up : down;
        return {
          time: (realToVirtual(segments, c.ts_ms) / 1000) as any,
          open: c.open,
          close: c.close,
          high: c.high,
          low: c.low,
          color,
          borderColor: color,
          wickColor: color,
        };
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/CandlePane.test.tsx`
Expected: PASS — new regression test green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/CandlePane.tsx frontend/tests/component/CandlePane.test.tsx
git commit -m "fix(chart): CandlePane drops pre-open auction candles

Backend includes 8:30 KST single-price auction candles in /api/session.
Without filtering, realToVirtual collapses them to virtual-time=0, then
the next session-open candle also maps to 0 → lightweight-charts asserts
'data must be asc ordered by time, index=1, time=0, prev time=0' and
React unmounts the entire root.

Fixes ISSUE-001 (CandlePane path)."
```

---

### Task 3: VolumePane filter pre-session candles

**Files:**
- Modify: `frontend/src/chart/VolumePane.tsx`
- Modify: `frontend/tests/component/VolumePane.test.tsx`

- [ ] **Step 1: Add failing regression test to `VolumePane.test.tsx`**

기존 `describe('VolumePane', () => { ... })` 마지막에 다음 `it` 추가:

```typescript
  it('drops pre-open auction candles to keep virtual times unique and ascending', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      candles: [
        { ts_ms: sessionOpenMs - 30 * 60_000, open: 1, close: 1, high: 1, low: 1, vol_a: 111, vol_b: 0 },
        { ts_ms: sessionOpenMs, open: 1, close: 1, high: 1, low: 1, vol_a: 200, vol_b: 50 },
        { ts_ms: sessionOpenMs + 60_000, open: 1, close: 1, high: 1, low: 1, vol_a: 50, vol_b: 80 },
      ],
    };
    render(
      <VolumePane
        chart={chart}
        bundle={bundle}
        segments={[
          {
            date: '20260511',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
            virtualStart: 0,
          },
        ]}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[1].time).toBe(60);
  });
```

기존 테스트 파일에 `makeMockChart`가 정의되어 있다고 가정 — 없다면 CandlePane.test.tsx와 동일한 헬퍼를 파일 상단에 복사.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/component/VolumePane.test.tsx`
Expected: FAIL — current code returns 3 entries with duplicate `time=0`.

- [ ] **Step 3: Fix `frontend/src/chart/VolumePane.tsx`**

import 줄(line 4) 수정:

```typescript
import { type Segment, realToVirtual, isWithinSessions } from '../util/time';
```

`useEffect` 내부의 `const data = bundle.candles.map((c) => ({...}))` 블록(line 41-48)을 다음으로 교체:

```typescript
    const data = bundle.candles
      .filter((c) => isWithinSessions(segments, c.ts_ms))
      .map((c) => ({
        time: (realToVirtual(segments, c.ts_ms) / 1000) as any,
        value: c.vol_a + c.vol_b,
        color: c.close >= c.open ? up : down,
      }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/VolumePane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/VolumePane.tsx frontend/tests/component/VolumePane.test.tsx
git commit -m "fix(chart): VolumePane drops pre-open auction candles

Same root cause as CandlePane fix — without filtering, two pre-session
candles collapse to virtual-time=0 and HistogramSeries.setData asserts.
ISSUE-001 (VolumePane path)."
```

---

### Task 4: RatioPane filter pre-session quote_ratio points

**Files:**
- Modify: `frontend/src/chart/RatioPane.tsx`
- Modify: `frontend/tests/component/RatioPane.test.tsx`

- [ ] **Step 1: Add failing regression test to `RatioPane.test.tsx`**

기존 `describe`에 추가:

```typescript
  it('drops pre-open auction quote_ratio points', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 100, ask_total: 100 }, // pre-open: drop
          { t: sessionOpenMs,              bid_total: 100, ask_total: 200 }, // keep
          { t: sessionOpenMs + 1000,       bid_total: 150, ask_total: 100 }, // keep
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        segments={[
          {
            date: '20260511',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
            virtualStart: 0,
          },
        ]}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[1].time).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/component/RatioPane.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Fix `frontend/src/chart/RatioPane.tsx`**

import 줄(line 4) 수정:

```typescript
import { type Segment, realToVirtual, isWithinSessions } from '../util/time';
```

`useEffect` 내부의 `const data = bundle.quote_ratio.points.map(...)` 블록(line 50-53)을 다음으로 교체:

```typescript
    const data = bundle.quote_ratio.points
      .filter((p) => isWithinSessions(segments, p.t))
      .map((p) => ({
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: quoteImbalance(p.bid_total, p.ask_total),
      }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/RatioPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/RatioPane.tsx frontend/tests/component/RatioPane.test.tsx
git commit -m "fix(chart): RatioPane drops pre-open auction quote_ratio points

ISSUE-001 (RatioPane path)."
```

---

### Task 5: FillStrengthPane filter pre-session points (both buy and sell series)

**Files:**
- Modify: `frontend/src/chart/FillStrengthPane.tsx`
- Modify: `frontend/tests/component/FillStrengthPane.test.tsx`

- [ ] **Step 1: Add failing regression test to `FillStrengthPane.test.tsx`**

`makeMockChart`을 buy/sell 두 series를 구분할 수 있게 확장하고, 새 `it` 추가:

```typescript
  it('drops pre-open auction points from both buy and sell series', () => {
    // Two addSeries calls (buy, sell) — capture both series mocks.
    const buySeries = { setData: vi.fn(), applyOptions: vi.fn() };
    const sellSeries = { setData: vi.fn(), applyOptions: vi.fn() };
    const addSeries = vi.fn().mockReturnValueOnce(buySeries).mockReturnValueOnce(sellSeries);
    const chart: any = { addSeries, removeSeries: vi.fn() };

    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      fill_strength: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs - 30 * 60_000, buy_qty: 10, sell_qty: 5 }, // pre-open: drop
          { t: sessionOpenMs,              buy_qty: 20, sell_qty: 8 }, // keep
          { t: sessionOpenMs + 1000,       buy_qty: 30, sell_qty: 12 }, // keep
        ],
      },
    };
    render(
      <FillStrengthPane
        chart={chart}
        bundle={bundle}
        segments={[
          {
            date: '20260511',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
            virtualStart: 0,
          },
        ]}
      />,
    );
    const buyData = buySeries.setData.mock.calls[0][0];
    const sellData = sellSeries.setData.mock.calls[0][0];
    expect(buyData).toHaveLength(2);
    expect(sellData).toHaveLength(2);
    expect(buyData[0].time).toBe(0);
    expect(buyData[1].time).toBe(1);
    // sell series uses negative value
    expect(sellData[0].value).toBe(-8);
    expect(sellData[1].value).toBe(-12);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/component/FillStrengthPane.test.tsx`
Expected: FAIL (3 entries instead of 2, duplicate time=0).

- [ ] **Step 3: Fix `frontend/src/chart/FillStrengthPane.tsx`**

import 줄(line 4) 수정:

```typescript
import { type Segment, realToVirtual, isWithinSessions } from '../util/time';
```

`useEffect` 내부 전체 buy/sell 매핑(line 35-49)을 다음으로 교체:

```typescript
    const inSession = bundle.fill_strength.points.filter((p) =>
      isWithinSessions(segments, p.t),
    );
    buy.setData(
      inSession.map((p) => ({
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: p.buy_qty,
      })),
    );
    sell.setData(
      inSession.map((p) => ({
        time: (realToVirtual(segments, p.t) / 1000) as any,
        value: -p.sell_qty,
      })),
    );
```

(filter 결과를 두 series에서 공유 — 두 번 필터링하지 않음.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/FillStrengthPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/FillStrengthPane.tsx frontend/tests/component/FillStrengthPane.test.tsx
git commit -m "fix(chart): FillStrengthPane drops pre-open auction points

Filter shared across buy/sell series. ISSUE-001 (FillStrengthPane path)."
```

---

### Task 6: E2E regression — 대한항공 데이터가 정상 로드되어 5개 pane이 렌더된다

**Files:**
- Modify: `frontend/tests/e2e/replay-smoke.spec.ts`

- [ ] **Step 1: Add failing E2E test for 003490**

`replay-smoke.spec.ts`의 기존 test.describe 블록 안, 기존 happy path 다음에 추가:

```typescript
  test('대한항공 (003490, 2026-05-11) loads without unmounting the app', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/replay?tabs=003490:20260511:20260511&active=0');

    // 5개 차트 pane이 모두 mount되어야 한다
    for (const pane of ['candle', 'volume', 'ratio', 'intensity', 'fill-strength']) {
      await expect(page.locator(`[data-pane="${pane}"]`)).toBeVisible({ timeout: 5000 });
    }

    // 사이드 네비가 살아 있어야 한다 (root unmount 회귀 가드)
    await expect(page.getByRole('link', { name: 'Replay Viewer' })).toBeVisible();

    // lightweight-charts assertion 메시지가 콘솔에 떠선 안 된다
    const assertionErr = consoleErrors.find((e) =>
      e.includes('data must be asc ordered by time'),
    );
    expect(assertionErr, `unexpected chart assertion: ${assertionErr}`).toBeUndefined();
  });
```

- [ ] **Step 2: Run the new E2E test to confirm it fails on `main`/pre-fix**

Run: `cd frontend && npx playwright test tests/e2e/replay-smoke.spec.ts -g "대한항공"`
Expected on un-fixed branch: FAIL (assertion message present, root unmounted).
Expected on this branch (after Tasks 2-5 merged): PASS.

> Note: 백엔드가 003490 fixture를 응답해야 한다. 이 E2E는 dev backend가 005930 + 003490을 모두 인벤토리에 가지고 있다는 전제 — 그렇지 않으면 `replay-smoke.spec.ts` 헤더 주석대로 fixture bootstrap이 별도 작업으로 필요. README 업데이트만 하고 skip 표시할지는 PR 시점 백엔드 상태에 따라 결정.

- [ ] **Step 3: Commit**

```bash
git add frontend/tests/e2e/replay-smoke.spec.ts
git commit -m "test(e2e): regression for 대한항공 data-load crash

Verifies all 5 chart panes mount and no lightweight-charts assertion
fires when loading a session that includes pre-open auction candles.
Locks in the ISSUE-001 fix."
```

---

## Phase 2 — Error boundary (ISSUE-002)

### Task 7: `ChartErrorBoundary` 컴포넌트 + 테스트

**Files:**
- Create: `frontend/src/chart/ChartErrorBoundary.tsx`
- Create: `frontend/tests/component/ChartErrorBoundary.test.tsx`

- [ ] **Step 1: Write failing test**

`frontend/tests/component/ChartErrorBoundary.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ChartErrorBoundary from '../../src/chart/ChartErrorBoundary';

function Boom({ msg }: { msg: string }) {
  throw new Error(msg);
}

describe('ChartErrorBoundary', () => {
  // Suppress React's error log noise from intentional throws.
  const origErr = console.error;
  afterEach(() => {
    console.error = origErr;
  });

  it('renders children when no error', () => {
    render(
      <ChartErrorBoundary>
        <div>chart content</div>
      </ChartErrorBoundary>,
    );
    expect(screen.getByText('chart content')).toBeInTheDocument();
  });

  it('renders fallback UI and preserves sibling layout when a child throws', () => {
    console.error = vi.fn();
    render(
      <ChartErrorBoundary>
        <Boom msg="lightweight-charts assert" />
      </ChartErrorBoundary>,
    );
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    // The error message itself should be surfaced so users can copy-paste it.
    expect(screen.getByText(/lightweight-charts assert/)).toBeInTheDocument();
  });

  it('exposes a reset button that re-renders children after fix', () => {
    console.error = vi.fn();
    let shouldThrow = true;
    function Toggling() {
      if (shouldThrow) throw new Error('boom');
      return <div>recovered</div>;
    }
    const { getByRole, rerender } = render(
      <ChartErrorBoundary>
        <Toggling />
      </ChartErrorBoundary>,
    );
    // Fallback shown
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    // Simulate fix
    shouldThrow = false;
    getByRole('button', { name: /다시 시도/ }).click();
    rerender(
      <ChartErrorBoundary>
        <Toggling />
      </ChartErrorBoundary>,
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/component/ChartErrorBoundary.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `frontend/src/chart/ChartErrorBoundary.tsx`**

```typescript
import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * ChartErrorBoundary — guards the lightweight-charts pane tree.
 *
 * lightweight-charts asserts on a few invariants (asc-sorted times, etc.)
 * and throws synchronously inside React render/effect. Without this
 * boundary, the throw bubbles to the React root and unmounts the entire
 * app — sidebar, tabs, everything. The boundary keeps the chart area
 * isolated so the rest of the page survives.
 *
 * Renders a small fallback that surfaces the message (so users can
 * copy-paste it into bug reports) and a "다시 시도" button to clear
 * the error state and let React re-mount children.
 */
export default class ChartErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Keep the original error visible in dev tools for stack-trace inspection.
    // The boundary fallback shows the message; this preserves the noise for
    // engineers who have the console open.
    console.error('[ChartErrorBoundary]', error);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="grid place-items-center h-full bg-bg-card text-fg-dim p-6">
          <div className="max-w-md text-center space-y-3">
            <div className="text-fg font-semibold">차트 렌더링에 실패했습니다</div>
            <div className="text-xs font-mono break-all bg-bg-subtle border rounded p-2">
              {this.state.error.message}
            </div>
            <button
              onClick={this.reset}
              className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm"
            >
              다시 시도
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/ChartErrorBoundary.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/ChartErrorBoundary.tsx frontend/tests/component/ChartErrorBoundary.test.tsx
git commit -m "feat(chart): add ChartErrorBoundary

Class-based ErrorBoundary that isolates lightweight-charts throws to the
chart area. ISSUE-002: a single pane assertion no longer unmounts the
sidebar/tabs/page chrome."
```

---

### Task 8: `Workarea`가 `ChartStage`를 `ChartErrorBoundary`로 감싼다

**Files:**
- Modify: `frontend/src/replay/Workarea.tsx`

- [ ] **Step 1: Locate the current ChartStage usage**

`frontend/src/replay/Workarea.tsx`의 return 블록(line 58-63):

```jsx
  return (
    <div className="grid grid-cols-[1fr_320px] gap-2 p-2 h-full min-h-0 bg-bg">
      <ChartStage bundle={session ?? null} segments={segments} />
      <CursorSidebarConnected />
    </div>
  );
```

- [ ] **Step 2: Replace with boundary-wrapped version**

import 줄에 추가:

```typescript
import ChartErrorBoundary from '../chart/ChartErrorBoundary';
```

return 블록의 `<ChartStage ... />` 를 다음으로 교체:

```jsx
      <ChartErrorBoundary>
        <ChartStage bundle={session ?? null} segments={segments} />
      </ChartErrorBoundary>
```

- [ ] **Step 3: Add a component test for the integration**

`frontend/tests/component/Workarea.test.tsx`가 이미 있는지 확인하고, 없으면 다음 내용으로 생성:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock ChartStage to throw — proves the boundary catches it.
vi.mock('../../src/chart/ChartStage', () => ({
  default: () => {
    throw new Error('boundary-test boom');
  },
}));
// Mock CursorSidebarConnected so it doesn't pull in network code.
vi.mock('../../src/sidebar/CursorSidebar', () => ({
  CursorSidebarConnected: () => <div data-testid="sidebar" />,
}));
// Stub API hooks the Workarea consumes.
vi.mock('../../src/api/session', () => ({
  useSession: () => ({ data: { fake: true }, isLoading: false, isError: false, error: null }),
}));
vi.mock('../../src/api/stock-dates', () => ({
  useStockDates: () => ({ data: [] }),
}));

import Workarea from '../../src/replay/Workarea';

describe('Workarea + ChartErrorBoundary integration', () => {
  const origErr = console.error;
  afterEach(() => {
    console.error = origErr;
  });

  it('isolates chart throws so sidebar remains rendered', () => {
    console.error = vi.fn();
    const tab: any = {
      id: 't1',
      selection: { code: '003490', fromDate: '20260511', toDate: '20260511' },
      cursorMs: null,
      status: 'loaded',
      bundles: new Map(),
    };
    render(<Workarea tab={tab} />);
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/boundary-test boom/)).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/Workarea.test.tsx tests/component/ChartErrorBoundary.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/replay/Workarea.tsx frontend/tests/component/Workarea.test.tsx
git commit -m "fix(replay): wrap ChartStage in ChartErrorBoundary

Workarea now isolates chart throws so the sidebar, tabs, and nav survive.
ISSUE-002: regression test asserts sidebar remains mounted when ChartStage
throws."
```

---

## Phase 3 — Onboarding feedback (ISSUE-003)

### Task 9: `useToolbarDraftStore` zustand 스토어

**Files:**
- Create: `frontend/src/state/toolbarDraft.ts`
- Create: `frontend/tests/unit/toolbarDraft.test.ts`

- [ ] **Step 1: Write failing test**

`frontend/tests/unit/toolbarDraft.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

describe('toolbarDraftStore', () => {
  beforeEach(() => {
    useToolbarDraftStore.getState().reset();
  });

  it('starts empty for a fresh tab', () => {
    const d = useToolbarDraftStore.getState().getDraft('tab-1');
    expect(d).toEqual({ code: null, from: null, to: null });
  });

  it('setDraft persists per tab id', () => {
    useToolbarDraftStore.getState().setDraft('tab-1', { code: '003490', from: null, to: null });
    useToolbarDraftStore.getState().setDraft('tab-2', { code: '005930', from: '20260520', to: '20260520' });
    expect(useToolbarDraftStore.getState().getDraft('tab-1')).toEqual({
      code: '003490',
      from: null,
      to: null,
    });
    expect(useToolbarDraftStore.getState().getDraft('tab-2')).toEqual({
      code: '005930',
      from: '20260520',
      to: '20260520',
    });
  });

  it('setStock clears dates (mirrors Toolbar UX)', () => {
    useToolbarDraftStore
      .getState()
      .setDraft('tab-1', { code: '003490', from: '20260511', to: '20260511' });
    useToolbarDraftStore.getState().setStock('tab-1', '005930');
    expect(useToolbarDraftStore.getState().getDraft('tab-1')).toEqual({
      code: '005930',
      from: null,
      to: null,
    });
  });

  it('clearTab removes the draft', () => {
    useToolbarDraftStore.getState().setDraft('tab-1', { code: '003490', from: null, to: null });
    useToolbarDraftStore.getState().clearTab('tab-1');
    expect(useToolbarDraftStore.getState().getDraft('tab-1')).toEqual({
      code: null,
      from: null,
      to: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/toolbarDraft.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `frontend/src/state/toolbarDraft.ts`**

```typescript
import { create } from 'zustand';

export type Draft = {
  code: string | null;
  from: string | null;
  to: string | null;
};

const EMPTY: Draft = { code: null, from: null, to: null };

type Store = {
  drafts: Record<string, Draft>;
  getDraft: (tabId: string) => Draft;
  setDraft: (tabId: string, draft: Draft) => void;
  setStock: (tabId: string, code: string) => void;
  setDates: (tabId: string, from: string, to: string) => void;
  clearTab: (tabId: string) => void;
  reset: () => void;
};

/**
 * Toolbar draft state, keyed by tab id.
 *
 * Lives outside `useTabsStore` because draft != committed selection —
 * the user can tinker with stock/date before pressing "데이터 불러오기"
 * to commit. OnboardingCard reads this so its step indicator reacts to
 * draft progress in real time (ISSUE-003).
 */
export const useToolbarDraftStore = create<Store>((set, get) => ({
  drafts: {},
  getDraft: (tabId) => get().drafts[tabId] ?? EMPTY,
  setDraft: (tabId, draft) => set((s) => ({ drafts: { ...s.drafts, [tabId]: draft } })),
  setStock: (tabId, code) =>
    set((s) => ({ drafts: { ...s.drafts, [tabId]: { code, from: null, to: null } } })),
  setDates: (tabId, from, to) =>
    set((s) => {
      const cur = s.drafts[tabId] ?? EMPTY;
      return { drafts: { ...s.drafts, [tabId]: { ...cur, from, to } } };
    }),
  clearTab: (tabId) =>
    set((s) => {
      const next = { ...s.drafts };
      delete next[tabId];
      return { drafts: next };
    }),
  reset: () => set({ drafts: {} }),
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/toolbarDraft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/toolbarDraft.ts frontend/tests/unit/toolbarDraft.test.ts
git commit -m "feat(state): add useToolbarDraftStore for shared toolbar draft

Per-tab draft state lifted out of Toolbar's local useState so sibling
components (OnboardingCard) can subscribe. Foundation for ISSUE-003."
```

---

### Task 10: `Toolbar`가 draft 스토어를 사용한다

**Files:**
- Modify: `frontend/src/replay/Toolbar.tsx`

- [ ] **Step 1: Update Toolbar to read/write the store**

`frontend/src/replay/Toolbar.tsx` 전체를 다음으로 교체:

```typescript
import { useEffect } from 'react';
import { useTabsStore } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';
import StockCombobox from './StockCombobox';
import DateRangePicker from './DateRangePicker';

export default function Toolbar() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  const draft = useToolbarDraftStore((s) => s.getDraft(active.id));

  // Sync draft from the store-committed selection when the user switches tabs.
  // We seed the draft with the selection so a tab that already loaded data
  // shows its current values in the toolbar instead of empty fields.
  useEffect(() => {
    const cur = useToolbarDraftStore.getState().getDraft(active.id);
    const sel = active.selection;
    const isEmpty = cur.code === null && cur.from === null && cur.to === null;
    if (isEmpty && sel) {
      useToolbarDraftStore.getState().setDraft(active.id, {
        code: sel.code,
        from: sel.fromDate,
        to: sel.toDate,
      });
    }
    // Note: we intentionally don't overwrite a non-empty draft — the user may
    // be mid-edit. Lifting from local state preserves the original behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.id]);

  const setCode = (code: string) =>
    useToolbarDraftStore.getState().setStock(active.id, code);
  const setDates = (from: string, to: string) =>
    useToolbarDraftStore.getState().setDates(active.id, from, to);

  const ready = !!(draft.code && draft.from && draft.to);
  const loaded = active.status === 'loaded';

  const onLoad = () => {
    if (!ready) return;
    useTabsStore.getState().setSelection(active.id, {
      code: draft.code!,
      fromDate: draft.from!,
      toDate: draft.to!,
    });
  };

  return (
    <div className="flex items-center gap-2.5 px-4 bg-bg-card border-b h-[60px]">
      <StockCombobox value={draft.code} onChange={setCode} />
      <DateRangePicker code={draft.code} from={draft.from} to={draft.to} onChange={setDates} />
      <span className="flex-1" />
      <button
        disabled={!ready}
        onClick={onLoad}
        className="px-4 py-2 bg-accent text-accent-fg rounded font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loaded ? 'Reload' : '데이터 불러오기'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Run existing component tests**

`Toolbar`의 기존 테스트가 있는지 확인. 있다면 store 의존성을 mock 해서 통과시켜야 한다. 없으면 다음 통합 테스트를 `frontend/tests/component/Toolbar.test.tsx`로 생성:

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/api/stock-dates', () => ({
  useStockDates: () => ({
    data: [
      {
        date: '20260511',
        code: '003490',
        name: '대한항공',
        regular_session_open_ms: 1_778_457_600_000,
        regular_session_close_ms: 1_778_481_000_000,
      },
    ],
  }),
}));

import Toolbar from '../../src/replay/Toolbar';
import { useTabsStore } from '../../src/state/tabs';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

describe('Toolbar', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useToolbarDraftStore.getState().reset();
  });

  it('writes stock selection to the draft store', () => {
    render(<Toolbar />);
    fireEvent.click(screen.getByRole('button', { name: /종목 선택/ }));
    fireEvent.click(screen.getByText('대한항공'));
    const activeId = useTabsStore.getState().activeTabId;
    expect(useToolbarDraftStore.getState().getDraft(activeId).code).toBe('003490');
  });
});
```

Run: `cd frontend && npx vitest run tests/component/Toolbar.test.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/replay/Toolbar.tsx frontend/tests/component/Toolbar.test.tsx
git commit -m "refactor(replay): Toolbar reads/writes useToolbarDraftStore

Lifts draft state out of local useState so siblings (OnboardingCard)
can subscribe. No behavior change for Toolbar itself. ISSUE-003 prep."
```

---

### Task 11a (보강): `closeTab` 시 draft store에서 stale entry 제거

**Files:**
- Modify: `frontend/src/state/tabs.ts`
- Modify: `frontend/tests/unit/tabs.test.ts`

- [ ] **Step 1: Add regression test in `tabs.test.ts`**

```typescript
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

it('closeTab clears any draft entry for the closed tab', () => {
  const id1 = useTabsStore.getState().activeTabId;
  const id2 = useTabsStore.getState().newTab();
  useToolbarDraftStore.getState().setDraft(id1, {
    code: '003490',
    from: '20260511',
    to: '20260511',
  });
  useToolbarDraftStore.getState().setDraft(id2, {
    code: '005930',
    from: null,
    to: null,
  });
  useTabsStore.getState().closeTab(id1);
  expect(useToolbarDraftStore.getState().getDraft(id1)).toEqual({
    code: null,
    from: null,
    to: null,
  });
  // Other tab's draft untouched
  expect(useToolbarDraftStore.getState().getDraft(id2).code).toBe('005930');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/unit/tabs.test.ts`
Expected: FAIL — `getDraft(id1)` still returns the stale draft.

- [ ] **Step 3: Wire `closeTab` to `useToolbarDraftStore.clearTab`**

`frontend/src/state/tabs.ts` 상단에 import 추가:

```typescript
import { useToolbarDraftStore } from './toolbarDraft';
```

`closeTab` 액션의 `set({ tabs: next, activeTabId: nextActive });` 줄 직전에 추가:

```typescript
    useToolbarDraftStore.getState().clearTab(id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/unit/tabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabs.ts frontend/tests/unit/tabs.test.ts
git commit -m "fix(state): clear toolbar draft when its tab closes

Prevents stale entries in useToolbarDraftStore when users close tabs.
Memory leak only — no behavior impact — but keeps the two stores' tab
lifecycle aligned. Surfaced by /plan-eng-review."
```

---

### Task 11: `OnboardingCard`가 draft를 구독해 단계를 갱신한다

**Files:**
- Modify: `frontend/src/replay/OnboardingCard.tsx`
- Create: `frontend/tests/component/OnboardingCard.test.tsx`

- [ ] **Step 1: Write failing test**

`frontend/tests/component/OnboardingCard.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import OnboardingCard from '../../src/replay/OnboardingCard';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

const baseTab: any = {
  id: 'tab-1',
  selection: null,
  cursorMs: null,
  status: 'empty',
  bundles: new Map(),
};

describe('OnboardingCard', () => {
  beforeEach(() => {
    useToolbarDraftStore.getState().reset();
  });

  it('highlights step 1 (종목 선택) when draft is empty', () => {
    render(<OnboardingCard tab={baseTab} />);
    // Step 1 has the active style; step 2 and 3 are dim/inactive
    const step1 = screen.getByText('종목 선택');
    expect(step1.className).toMatch(/font-medium/);
  });

  it('ticks step 1 and highlights step 2 once a stock is in draft', () => {
    useToolbarDraftStore
      .getState()
      .setDraft('tab-1', { code: '003490', from: null, to: null });
    render(<OnboardingCard tab={baseTab} />);
    // Step 1 should show ✓
    expect(screen.getByText('✓', { selector: 'span' })).toBeInTheDocument();
    const step2 = screen.getByText('기간 선택');
    expect(step2.className).toMatch(/font-medium/);
  });

  it('ticks steps 1+2 and highlights step 3 once dates are in draft', () => {
    useToolbarDraftStore
      .getState()
      .setDraft('tab-1', { code: '003490', from: '20260511', to: '20260511' });
    render(<OnboardingCard tab={baseTab} />);
    const checkmarks = screen.getAllByText('✓');
    expect(checkmarks).toHaveLength(2); // 두 단계 완료
    const step3 = screen.getByText('데이터 불러오기');
    expect(step3.className).toMatch(/font-medium/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/component/OnboardingCard.test.tsx`
Expected: FAIL (current OnboardingCard ignores the draft store).

- [ ] **Step 3: Update `frontend/src/replay/OnboardingCard.tsx`**

전체 파일을 다음으로 교체:

```typescript
import type { Tab } from '../state/tabs';
import { useToolbarDraftStore } from '../state/toolbarDraft';

export default function OnboardingCard({ tab }: { tab: Tab }) {
  // Subscribe to the draft store so the step indicator updates as the user
  // fills in the toolbar — without waiting for "데이터 불러오기" to commit.
  // Falls back to tab.selection when present (covers cases where the tab was
  // hydrated from URL but the user hasn't touched the toolbar yet).
  const draft = useToolbarDraftStore((s) => s.getDraft(tab.id));
  const code = draft.code ?? tab.selection?.code ?? null;
  const from = draft.from ?? tab.selection?.fromDate ?? null;
  const to = draft.to ?? tab.selection?.toDate ?? null;

  const step = !code ? 1 : !from || !to ? 2 : 3;
  return (
    <div className="grid place-items-center h-full">
      <div className="max-w-md bg-bg-card border rounded p-6 space-y-3">
        <h3 className="text-lg font-semibold">분석 시작</h3>
        <Step n={1} done={step > 1} active={step === 1} label="종목 선택" />
        <Step n={2} done={step > 2} active={step === 2} label="기간 선택" />
        <Step n={3} done={false} active={step === 3} label="데이터 불러오기" />
      </div>
    </div>
  );
}

function Step({ n, done, active, label }: { n: number; done: boolean; active: boolean; label: string }) {
  return (
    <div className={`flex gap-3 items-center ${done ? 'text-up' : active ? 'text-fg' : 'text-fg-dim'}`}>
      <span className="font-mono text-xs">{done ? '✓' : n + '.'}</span>
      <span className={active ? 'font-medium' : ''}>{label}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/component/OnboardingCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/replay/OnboardingCard.tsx frontend/tests/component/OnboardingCard.test.tsx
git commit -m "fix(replay): OnboardingCard reacts to toolbar draft

Step indicator now updates as the user picks stock/dates instead of
staying frozen until '데이터 불러오기' commits. ISSUE-003."
```

---

## Phase 4 — Verification

### Task 12: Full suite + manual replay

**Files:** none

- [ ] **Step 1: Run all unit + component tests**

Run: `cd frontend && npx vitest run`
Expected: ALL PASS, no regressions in pre-existing suites (calendar / sse / symbols / etc.).

- [ ] **Step 2: Run lint**

Run: `cd frontend && npm run lint`
Expected: clean. Fix any new warnings introduced by the changes (likely none, since we used the codebase's existing patterns).

- [ ] **Step 3: Run e2e smoke**

Run: `cd frontend && npx playwright test tests/e2e/replay-smoke.spec.ts`
Expected: PASS — both the existing 005930 test AND the new 003490 test green.

- [ ] **Step 4: Manual /qa run via the browse skill**

지난 라운드에서 작성한 QA 리포트(`.gstack/qa-reports/qa-report-localhost-replay-2026-05-22.md`)의 시나리오를 재실행:

1. `http://localhost:5173/replay` → onboarding "1. 종목 선택" 강조
2. 콤보박스에서 003490 대한항공 선택 → "1. ✓" + "2. 기간 선택" 강조 (NEW — ISSUE-003 확인)
3. 2026-05-11 선택 → "1. ✓ / 2. ✓ / 3. 데이터 불러오기" 강조
4. "데이터 불러오기" 클릭 → 차트 5개 pane이 모두 렌더되고 사이드 네비/탭 유지 (NEW — ISSUE-001/002 확인)
5. 콘솔에 lightweight-charts assertion 없음

이 manual run은 PR 본문에 evidence 스크린샷 첨부.

- [ ] **Step 5: Commit checkpoint and prepare PR**

```bash
git status   # verify clean tree (no uncommitted work)
git log --oneline main..HEAD   # confirm fix commits are atomic and well-named
```

PR 본문에 다음을 포함:
- ISSUE-001/002/003 각각의 before/after 스크린샷
- 회귀 테스트 통과 evidence (vitest + playwright 출력)
- 향후 작업으로 남기는 후속 항목 명시:
  - IntensityPane / VolumeProfileOverlay에 대한 pre-session 데이터의 visual artifact 검토
  - 백엔드가 pre-open 캔들을 의도적으로 보내는지 vs 누락된 필터인지 확인 (spec 정렬)
  - DESIGN.md/CONTEXT.md에 "virtual axis는 정규 거래 시간만 표현" 규약 명문화

---

## Self-Review Notes (작성자가 검토 후 기록)

- [x] 모든 Task가 spec(QA 리포트의 ISSUE-001/002/003) 요구사항에 매핑됨
  - Phase 1 (Tasks 1-6) → ISSUE-001
  - Phase 2 (Tasks 7-8) → ISSUE-002
  - Phase 3 (Tasks 9-11) → ISSUE-003
  - Phase 4 (Task 12) → 통합 검증
- [x] 플레이스홀더 없음 — 모든 코드 블록 완전, 모든 명령어 실행 가능
- [x] Type 일관성 — `Segment`, `Draft`, `Tab` 시그니처가 모든 Task에서 동일
- [x] 헬퍼 함수 이름 일관 — `isWithinSessions` (단수 아님), `useToolbarDraftStore` (camel case + Store 접미)
- [x] 기존 패턴 준수 — vitest + @testing-library/react + mock chart 패턴은 `CandlePane.test.tsx`와 동일

---

**Plan complete and saved.** 다음 단계로 두 가지 실행 옵션이 있습니다:

1. **Subagent-Driven (recommended)** — 매 Task마다 fresh subagent 디스패치 + 사이마다 review, 빠른 반복.
2. **Inline Execution** — 이 세션에서 직접 실행, checkpoint마다 review.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P2, human: ~10min / CC: ~3min)** — state/tabs — `closeTab` 시 toolbarDraft 정리 (Task 11a 추가)
  - Surfaced by: Architecture review — "draft store key가 active tab id에 종속, closeTab 시 cross-store cleanup 누락"
  - Files: `frontend/src/state/tabs.ts`, `frontend/tests/unit/tabs.test.ts`
  - Verify: `cd frontend && npx vitest run tests/unit/tabs.test.ts`

_No new tasks from Code Quality / Test review (gaps were P3 cosmetic only)._
_No new tasks from Performance review._

## Suggested TODOs (post-PR follow-up)

- [ ] **IntensityPane / VolumeProfileOverlay pre-session 시각화 검토** — 본 PR이 4개 throw-prone pane은 고치지만 IntensityPane은 `xFloat===null` 가드로 throw는 피하되 pre-session 데이터 시각 정합성은 검증 안 됨. 별도 PR에서 동일 `isWithinSessions` 가드 적용 또는 명시적 의도 결정 (보여줄지 말지).
- [ ] **백엔드 pre-open auction 캔들 spec 정렬** — 백엔드가 8:30-9:00 단일가 매매 호가를 응답에 포함하는 게 의도된 디자인인지 vs 누락된 필터인지 spec/ADR 명문화. 현재는 프론트가 일방적으로 drop.
- [ ] **DESIGN.md / CONTEXT.md** — "virtual axis는 regular session(09:00-15:30 KST)만 표현, 시간외/단일가는 별도 처리"를 도메인 규약으로 명문화.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | bug fix 플랜 — CEO 리뷰 불필요 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | 선택 사항, 실행되지 않음 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 1 actionable P2 (Task 11a 보강 완료), 3 P3 cosmetic notes, 0 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | OnboardingCard만 미세 변경, 별도 리뷰 불필요 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | 내부 fix — DX 영향 없음 |

- **UNRESOLVED**: 0
- **VERDICT**: ENG CLEARED — 1 minor finding (closeTab cross-store cleanup) folded into Task 11a. Ready to implement.

**Test plan artifact** written for /qa: scope에는 003490 정상 로드, 차트 5개 pane mount, 사이드 네비 유지, OnboardingCard 단계 진행이 포함됨.
