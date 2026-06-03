# Live 분봉 고정 스텝 점진 채우기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 분봉 좌측 팬의 과거 backfill을 고정 42일 1-shot 청크에서 고정 3거래일 스텝 점진 루프(viewport 찰 때까지)로 바꿔, 어떤 줌이든 첫 그림이 ~3.4초 안에 보이게 한다.

**Architecture:** 청크 사이징·종료 판정을 `liveDateTime.ts`의 순수 함수(`stepChunkDays`, `earliestAllowedMinuteDate`, `planFillStep`)로 뽑아 chart-mock 없이 TDD한다. `LiveChartRoot`의 좌측 팬 핸들러는 스텝 1만 dispatch하고, 스텝 2..N은 `useLiveBundle`이 새로 노출하는 `isExtending`의 falling-edge(=스텝 settle)에 반응하는 effect가 `planFillStep`을 호출해 자가 전진한다. prepend/clamp/viewport-shift 기존 코드는 그대로 재사용하되 루프 안에서 N회 돈다. D/W/M은 one-shot 그대로(루프는 minute-only).

**Tech Stack:** TypeScript, React, lightweight-charts v5.2.0, @tanstack/react-query, vitest, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-03-live-minute-dynamic-chunk-fetch-design.md`
**ADR:** `docs/adr/0059-live-minute-progressive-step-fill.md`

---

## File Structure

- **`frontend/src/live/liveDateTime.ts`** (modify) — 순수 커널이 모두 여기 산다.
  - 추가: `PAST_CANDLES_MAX_DAYS`, `earliestAllowedMinuteDate(todayKst)`, `stepChunkDays(tf)`, `planFillStep(args)`.
  - 변경: `nextHistoricalFrom(axisEarliestMs, historicalFromDate, chunkDays)` — 3번째 인자를 `tf`에서 `chunkDays: number`로.
  - 삭제: `prefetchChunkCandlesFor`, `prefetchChunkDaysFor` (역할이 `stepChunkDays`로 흡수됨).
- **`frontend/src/live/liveDateTime.test.ts`** (modify) — 새 시그니처·새 헬퍼 테스트.
- **`frontend/src/live/useLiveBundle.ts`** (modify) — 반환에 `isExtending` 추가; `earliestAllowedMinute` 계산을 `earliestAllowedMinuteDate` 헬퍼로 교체(DRY).
- **`frontend/src/live/useLiveBundle.test.tsx`** (modify) — `isExtending` 노출 테스트.
- **`frontend/src/live/LiveChartRoot.tsx`** (modify) — `captureViewportShift` 추출; 핸들러가 `stepChunkDays` 사용; 새 settle-effect 진행 루프(minute-only); 새 prop `isExtending`.
- **`frontend/src/live/LiveChartRoot.test.tsx`** (modify) — 옛 42일 기대값 갱신 + 진행 루프 테스트.
- **`frontend/src/live/LivePage.tsx`** (modify) — `isExtending`를 `useLiveBundle`에서 받아 아래로 전달.
- **`frontend/src/live/LiveWorkarea.tsx`** (modify) — `isExtending` prop을 `LiveChartRoot`로 전달(기존 `clampEngaged` 경로 미러).

**Test 실행 (worktree 루트에서):**
```bash
cd frontend && npx vitest run src/live/liveDateTime.test.ts
```
타입 체크: `cd frontend && npx tsc -b`

---

## Task 1: `earliestAllowedMinuteDate` 헬퍼 + 상수 이전 (pure)

250일 clamp 하한 날짜 계산을 `useLiveBundle`의 지역 계산에서 `liveDateTime`의 공유 헬퍼로 올린다(진행 루프가 LiveChartRoot에서도 같은 하한이 필요하므로 DRY).

**Files:**
- Modify: `frontend/src/live/liveDateTime.ts`
- Test: `frontend/src/live/liveDateTime.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`frontend/src/live/liveDateTime.test.ts` 상단 import에 `earliestAllowedMinuteDate, PAST_CANDLES_MAX_DAYS` 추가하고, 파일 끝(마지막 `});` 뒤)에 추가:

```ts
describe('earliestAllowedMinuteDate', () => {
  it('is today minus (PAST_CANDLES_MAX_DAYS - 1) calendar days', () => {
    expect(PAST_CANDLES_MAX_DAYS).toBe(250);
    expect(earliestAllowedMinuteDate('20260527')).toBe(
      subtractDaysKst('20260527', PAST_CANDLES_MAX_DAYS - 1),
    );
  });

  it('uses 249 (inclusive 250-day window), not 250', () => {
    // 250-day window inclusive of today → floor is today-249.
    expect(earliestAllowedMinuteDate('20260527')).not.toBe(
      subtractDaysKst('20260527', 250),
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "earliestAllowedMinuteDate"`
Expected: FAIL — `earliestAllowedMinuteDate is not a function` / import 에러.

- [ ] **Step 3: 구현**

`frontend/src/live/liveDateTime.ts`의 import 바로 아래, `TRADING_MINUTES_PER_DAY` 선언부 근처에 추가:

```ts
/** 분봉 scroll-back 깊이 상한 (캘린더일). payload 보호 + lwc setData 비용 한계.
 * useLiveBundle의 클램프와 LiveChartRoot 진행 루프의 종료 판정이 공유한다. */
export const PAST_CANDLES_MAX_DAYS = 250;

/** 250일 클램프 하한 날짜(YYYYMMDD KST). 분봉 fetch는 이 날짜보다 과거로 못 간다.
 * 250일 윈도가 오늘을 포함하므로 오늘 − 249. */
export function earliestAllowedMinuteDate(todayKstYyyymmdd: string): string {
  return subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "earliestAllowedMinuteDate"`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/liveDateTime.ts frontend/src/live/liveDateTime.test.ts
git commit -m "feat(live): earliestAllowedMinuteDate 헬퍼 + PAST_CANDLES_MAX_DAYS export"
```

---

## Task 2: `stepChunkDays` 헬퍼 (pure)

분봉 = 고정 3거래일 스텝(≈5 캘린더일), D/W/M = 기존 one-shot 윈도 그대로.

**Files:**
- Modify: `frontend/src/live/liveDateTime.ts`
- Test: `frontend/src/live/liveDateTime.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`liveDateTime.test.ts` import에 `stepChunkDays` 추가하고 파일 끝에 추가:

```ts
describe('stepChunkDays', () => {
  it('minute timeframes are a fixed 3-trading-day step (≈5 calendar days)', () => {
    // 3 trading days / (5/7 trading-days-per-calendar-day) = ceil(4.2) = 5.
    for (const tf of ['1m', '3m', '5m', '10m', '15m', '30m'] as const) {
      expect(stepChunkDays(tf)).toBe(5);
    }
  });

  it('D keeps the prior one-shot 350-calendar-day window (≈250 daily candles)', () => {
    expect(stepChunkDays('D')).toBe(350);
  });

  it('W/M keep the prior one-shot windows (120 candles)', () => {
    expect(stepChunkDays('W')).toBe(840); // 120 × 7
    expect(stepChunkDays('M')).toBe(3720); // 120 × 31
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "stepChunkDays"`
Expected: FAIL — `stepChunkDays is not a function`.

- [ ] **Step 3: 구현**

`liveDateTime.ts`의 `candleTargetToCalendarDays`(line 76) 아래에 추가:

```ts
/** 좌측 팬 한 스텝의 캘린더일 크기.
 *
 * - 분봉: 고정 3거래일(=latency cap). 3거래일을 5/7 밀도로 환산 → 5 캘린더일.
 *   주말 1회를 한 스텝에 항상 덮어 빈 결과 재드래그를 막는 최소값.
 *   `STEP_TRADING_DAYS`는 실측 후 조정 가능한 단일 상수(데이터를 덜 받는 게
 *   아니라 첫 그림 시점·렌더 분할 횟수만 바뀐다).
 * - D/W/M: 기존 one-shot 윈도 유지(진행 루프는 minute-only). 한 번의 팬으로
 *   ~1년치를 그려 채우므로 스텝 분할이 불필요. */
const STEP_TRADING_DAYS = 3;
export function stepChunkDays(tf: LiveTimeframe): number {
  if (isMinuteTimeframe(tf)) {
    return Math.ceil(STEP_TRADING_DAYS / TRADING_DAYS_PER_CALENDAR_DAYS);
  }
  if (tf === 'D') return candleTargetToCalendarDays(250, tf);
  return candleTargetToCalendarDays(120, tf); // W, M
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "stepChunkDays"`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/liveDateTime.ts frontend/src/live/liveDateTime.test.ts
git commit -m "feat(live): stepChunkDays — 분봉 고정 3거래일 스텝, D/W/M one-shot 유지"
```

---

## Task 3: `nextHistoricalFrom`을 chunkDays 주입형으로 + 호출부·테스트 동기 (coupled)

시그니처 변경은 호출부(`LiveChartRoot`)와 두 테스트 파일을 깨므로 **한 커밋**에 함께 바꾼다(분리하면 tsc/테스트 red).

**Files:**
- Modify: `frontend/src/live/liveDateTime.ts:152-163` (시그니처) + 삭제 `prefetchChunkCandlesFor`/`prefetchChunkDaysFor` (115-135)
- Modify: `frontend/src/live/LiveChartRoot.tsx:27` (import), `:454` (호출부)
- Modify: `frontend/src/live/liveDateTime.test.ts`, `frontend/src/live/LiveChartRoot.test.tsx`

- [ ] **Step 1: 테스트를 새 시그니처로 갱신 (실패 상태)**

`liveDateTime.test.ts`의 `describe('nextHistoricalFrom', ...)` 블록 전체를 교체:

```ts
describe('nextHistoricalFrom', () => {
  // 2026-02-02 09:00 KST in Unix ms — axis earliest for the base cases.
  const axisEarliestMs = Date.UTC(2026, 1, 2, 0, 0, 0);
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);

  it('steps back chunkDays from the axis earliest when no fetch is in flight', () => {
    const got = nextHistoricalFrom(axisEarliestMs, null, 5);
    expect(got).toBe(subtractDaysKst(axisEarliestDate, 5));
  });

  it('bases off historicalFromDate when it is already earlier than the axis (holiday-span progress)', () => {
    const earlier = subtractDaysKst(axisEarliestDate, 40);
    const got = nextHistoricalFrom(axisEarliestMs, earlier, 5);
    expect(got).toBe(subtractDaysKst(earlier, 5));
  });

  it('ignores a historicalFromDate that is NOT earlier than the axis earliest', () => {
    const later = subtractDaysKst(axisEarliestDate, -5);
    const got = nextHistoricalFrom(axisEarliestMs, later, 5);
    expect(got).toBe(subtractDaysKst(axisEarliestDate, 5));
  });

  it('honors the injected chunkDays (different chunkDays → different result)', () => {
    const small = nextHistoricalFrom(axisEarliestMs, null, 5);
    const large = nextHistoricalFrom(axisEarliestMs, null, 350);
    expect(small).toBe(subtractDaysKst(axisEarliestDate, 5));
    expect(large).toBe(subtractDaysKst(axisEarliestDate, 350));
    expect(small).not.toBe(large);
  });

  it('is monotonic: feeding its own output back always steps further back', () => {
    const first = nextHistoricalFrom(axisEarliestMs, null, 5);
    const second = nextHistoricalFrom(axisEarliestMs, first, 5);
    expect(second < first).toBe(true);
  });
});
```

import 줄에서 `prefetchChunkDaysFor` 제거.

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "nextHistoricalFrom"`
Expected: FAIL — 타입 에러(3번째 인자 number 기대 vs `prefetchChunkDaysFor` 미존재).

- [ ] **Step 3: `nextHistoricalFrom` 시그니처 변경 + prefetch* 삭제**

`liveDateTime.ts` line 152-163을 교체:

```ts
export function nextHistoricalFrom(
  axisEarliestMs: number,
  historicalFromDate: string | null,
  chunkDays: number,
): string {
  const axisEarliestDate = realMsToYyyymmdd(axisEarliestMs);
  const baseDate =
    historicalFromDate !== null && historicalFromDate < axisEarliestDate
      ? historicalFromDate
      : axisEarliestDate;
  return subtractDaysKst(baseDate, chunkDays);
}
```

`prefetchChunkCandlesFor`(115-123)와 `prefetchChunkDaysFor`(131-135) 함수 + 그 JSDoc을 삭제. (`initialCandleTargetFor`/`initialHistoricalDaysFor`는 유지 — 초기 seed용, 무관.)

- [ ] **Step 4: 호출부 갱신**

`LiveChartRoot.tsx:27` import를 `import { nextHistoricalFrom, stepChunkDays } from './liveDateTime';`로.

`LiveChartRoot.tsx:454`를 교체:

```ts
      const nextFrom = nextHistoricalFrom(axis.segments[0].sessionOpenMs, cur, stepChunkDays(timeframe));
```

- [ ] **Step 5: LiveChartRoot 테스트의 옛 42일 기대값 갱신**

`LiveChartRoot.test.tsx`:
- 430번 `it('fires extendHistoricalRange with one chunk ...')`: 기대값 `'20260414'` → `'20260521'`로, 주석의 "prefetchChunkDaysFor('1m')=42" → "stepChunkDays('1m')=5"로.
- 461번 `it('bases next chunk on historicalFromDate ...')`: 기대값 `'20260407'` → `'20260514'`로, 주석 "minus 42" → "minus 5"로.
- 496번 D 테스트: `stepChunkDays('D')=350`이라 기대값 `'20250610'`은 **그대로**; 주석의 `prefetchChunkCandlesFor('D')` → `stepChunkDays('D')=350`으로만 갱신.

```ts
// 430번 테스트 기대:
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521');
// 461번 테스트 기대:
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260514');
```

- [ ] **Step 6: 전체 통과 + 타입 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts src/live/LiveChartRoot.test.tsx`
Expected: PASS (모든 테스트). 이어서 `npx tsc -b` → 에러 0.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/live/liveDateTime.ts frontend/src/live/liveDateTime.test.ts frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "refactor(live): nextHistoricalFrom chunkDays 주입형 + 분봉 3거래일 스텝 적용 (42일 폐기)"
```

---

## Task 4: `planFillStep` 진행 루프 종료 판정 커널 (pure)

스텝 settle 후 "멈출지 / 다음 from을 받을지"를 결정하는 순수 함수. 루프 로직의 핵심이고 chart-mock 없이 전부 TDD된다.

**Files:**
- Modify: `frontend/src/live/liveDateTime.ts`
- Test: `frontend/src/live/liveDateTime.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`liveDateTime.test.ts` import에 `planFillStep` 추가, 파일 끝에 추가:

```ts
describe('planFillStep', () => {
  const axisEarliestMs = Date.UTC(2026, 4, 26, 0, 0, 0); // '20260526' 09:00 KST
  const base = {
    historicalFromDate: '20260521' as string | null,
    axisEarliestMs,
    earliestAllowedDate: '20251010', // far floor → not clamped
    stepCalendarDays: 5,
    stepCount: 1,
    maxSteps: 60,
  };

  it('stops when the viewport is full (visibleFrom >= 0)', () => {
    expect(planFillStep({ ...base, visibleFrom: 3 })).toEqual({ action: 'stop' });
  });

  it('stops when the viewport range is unavailable (visibleFrom null)', () => {
    expect(planFillStep({ ...base, visibleFrom: null })).toEqual({ action: 'stop' });
  });

  it('fetches the next step back when whitespace remains', () => {
    expect(planFillStep({ ...base, visibleFrom: -50 })).toEqual({
      action: 'fetch',
      nextFrom: subtractDaysKst('20260521', 5), // '20260516'
    });
  });

  it('stops at the 250-day clamp floor (already at/below earliestAllowed)', () => {
    expect(
      planFillStep({ ...base, visibleFrom: -50, historicalFromDate: '20251010' }),
    ).toEqual({ action: 'stop' });
  });

  it('stops at the backstop (stepCount reached maxSteps) to bound the loop', () => {
    expect(
      planFillStep({ ...base, visibleFrom: -50, stepCount: 60 }),
    ).toEqual({ action: 'stop' });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "planFillStep"`
Expected: FAIL — `planFillStep is not a function`.

- [ ] **Step 3: 구현**

`liveDateTime.ts`의 `nextHistoricalFrom` 아래에 추가:

```ts
export interface FillStepArgs {
  /** getVisibleLogicalRange().from — 음수면 왼쪽 빈영역. null이면 측정 불가. */
  visibleFrom: number | null;
  historicalFromDate: string | null;
  axisEarliestMs: number;
  /** 250일 클램프 하한(YYYYMMDD). earliestAllowedMinuteDate(today). */
  earliestAllowedDate: string;
  /** stepChunkDays(tf). */
  stepCalendarDays: number;
  /** 이번 fill에서 지금까지 dispatch한 스텝 수. */
  stepCount: number;
  /** 무한 루프 백스톱. */
  maxSteps: number;
}

/** 한 스텝 settle 후 진행 루프가 멈출지 / 다음 from을 받을지 결정.
 *
 * 종료: (a) viewport 꽉 참(visibleFrom ≥ 0) (b) 측정 불가(null) (c) 250일 클램프
 * 하한 도달 (d) 백스톱(stepCount ≥ maxSteps). 그 외엔 cur-base nextHistoricalFrom
 * 으로 한 스텝 더 과거를 받는다. 연휴 스텝(거래일 0개)은 여기서 멈추지 않는다 —
 * cur-base가 다음 스텝을 자동으로 더 과거로 보낸다. */
export function planFillStep(
  args: FillStepArgs,
): { action: 'stop' } | { action: 'fetch'; nextFrom: string } {
  const { visibleFrom, historicalFromDate, axisEarliestMs, earliestAllowedDate, stepCalendarDays, stepCount, maxSteps } = args;
  if (visibleFrom === null || visibleFrom >= 0) return { action: 'stop' };
  if (stepCount >= maxSteps) return { action: 'stop' };
  if (historicalFromDate !== null && historicalFromDate <= earliestAllowedDate) {
    return { action: 'stop' };
  }
  return {
    action: 'fetch',
    nextFrom: nextHistoricalFrom(axisEarliestMs, historicalFromDate, stepCalendarDays),
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "planFillStep"`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/liveDateTime.ts frontend/src/live/liveDateTime.test.ts
git commit -m "feat(live): planFillStep — 진행 루프 종료 판정 순수 커널"
```

---

## Task 5: `useLiveBundle`이 `isExtending` 노출 + earliestAllowedMinute DRY

진행 루프의 settle 신호(=`extending` falling edge)를 컴포넌트에 노출하고, 클램프 하한 계산을 공유 헬퍼로 교체한다.

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts:24,42-48,73,226-232`
- Test: `frontend/src/live/useLiveBundle.test.tsx`

- [ ] **Step 1: 실패 테스트 작성**

`useLiveBundle.test.tsx` 끝의 마지막 `describe` 안(또는 새 describe)에 추가. 기존 하니스의 `candlesMock`/`useLivePageStore` 제어를 그대로 쓴다:

```ts
describe('useLiveBundle isExtending', () => {
  it('is true during a historical extension (placeholderData + isFetching, historicalFromDate set)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260514' });
    candlesMock.isPlaceholderData = true;
    candlesMock.isFetching = true;
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper },
    );
    expect(result.current.isExtending).toBe(true);
  });

  it('is false when not extending (no historicalFromDate)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper },
    );
    expect(result.current.isExtending).toBe(false);
  });
});
```

> `wrapper`/`renderHook` 패턴은 이 파일 기존 테스트와 동일. `candlesMock`은 각 테스트 후 `beforeEach`에서 리셋되는지 확인하고, 안 되면 두 테스트가 서로 오염되지 않도록 각 테스트 시작에서 명시 세팅(위 코드처럼).

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/useLiveBundle.test.tsx -t "isExtending"`
Expected: FAIL — `result.current.isExtending` undefined.

- [ ] **Step 3: 구현**

`useLiveBundle.ts`:

(a) 상단 import에 추가:
```ts
import {
  regularSessionOpenMs,
  regularSessionCloseMs,
  subtractDaysKst,
  initialHistoricalDaysFor,
  earliestAllowedMinuteDate,
} from './liveDateTime';
```
그리고 line 24 `const PAST_CANDLES_MAX_DAYS = 250;` 삭제(헬퍼로 대체).

(b) line 73 `const earliestAllowedMinute = subtractDaysKst(todayKstYyyymmdd, PAST_CANDLES_MAX_DAYS - 1);` 를 교체:
```ts
  const earliestAllowedMinute = earliestAllowedMinuteDate(todayKstYyyymmdd);
```

(c) `UseLiveBundleResult` 인터페이스(42-48)에 추가:
```ts
export interface UseLiveBundleResult {
  bundle: RangeBundle | null;
  isLoading: boolean;
  error: unknown;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** 좌측 팬 한 스텝이 진행 중(placeholderData+isFetching). false-edge = 스텝 settle.
   * LiveChartRoot 진행 루프가 이 falling edge에 반응해 다음 스텝을 dispatch한다. */
  isExtending: boolean;
}
```

(d) return(226-232)에 `isExtending: extending,` 추가:
```ts
  return {
    bundle,
    isLoading: live.isLoading || past.isLoading || pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
    error: live.error ?? past.error ?? pastCandlesQuery.error ?? pastDailyCandlesQuery.error ?? null,
    clampEngaged,
    isPastCandlesLoading: pastCandlesQuery.isLoading || pastDailyCandlesQuery.isLoading,
    isExtending: extending,
  };
```

- [ ] **Step 4: 통과 확인**

Run: `cd frontend && npx vitest run src/live/useLiveBundle.test.tsx` 이어서 `npx tsc -b`
Expected: PASS + 타입 에러 0.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/live/useLiveBundle.ts frontend/src/live/useLiveBundle.test.tsx
git commit -m "feat(live): useLiveBundle이 isExtending 노출 + earliestAllowedMinute DRY"
```

---

## Task 6: `LiveChartRoot` viewport-shift 캡처를 `captureViewportShift`로 추출 (refactor)

스텝 1(핸들러)과 스텝 2..N(다음 task의 settle-effect)이 **같은** 캡처 로직을 쓰도록 헬퍼로 뽑는다. 동작 불변 — 기존 테스트가 green이어야 한다.

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (모듈 함수 추가 + 핸들러 435-448 교체)

- [ ] **Step 1: 모듈 함수 추가**

`LiveChartRoot.tsx`의 컴포넌트 `function LiveChartRoot(...)` 위(모듈 스코프)에 추가. 필요한 타입 import(`ITimeScaleApi`, `Time` from 'lightweight-charts', `VirtualAxis` 타입)는 파일 상단 기존 import에서 확인해 맞춘다:

```ts
/** 좌측 팬 prepend 직전의 STABLE 기준 봉을 캡처한다(real ms + 현재 union logical
 * 인덱스 + 캡처 시점 logical range). 복원 effect가 이 ref로 viewport 위치를
 * 동기 shift해 사용자가 보던 봉을 같은 위치에 고정한다. 스텝 1(드래그 핸들러)과
 * 스텝 2..N(settle-effect)이 공유한다. 캡처 불가(vr/lr/refIdx 누락)면 null. */
function captureViewportShift(
  ts: ITimeScaleApi<Time>,
  axis: VirtualAxis,
): { refMs: number; refIdx: number; fromLogical: number; toLogical: number } | null {
  const vr = ts.getVisibleRange();
  const lr = vr ? ts.getVisibleLogicalRange() : null;
  const refIdx = vr ? ts.timeToIndex(vr.to as Time, true) : null;
  if (!vr || !lr || refIdx === null) return null;
  return {
    refMs: axis.toReal((vr.to as number) * 1000),
    refIdx,
    fromLogical: lr.from,
    toLogical: lr.to,
  };
}
```

- [ ] **Step 2: 핸들러에서 사용**

`LiveChartRoot.tsx:435-448`(vr/lr/refIdx 계산 + `viewportShiftRef.current = ...` 블록)을 교체:

```ts
      // Always overwrite (capture OR clear): a failed capture must not leave a
      // PREVIOUS pan's anchors live for the next prepend's restore.
      viewportShiftRef.current = captureViewportShift(ts, axis);
```

- [ ] **Step 3: 기존 테스트 + 타입 확인**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx` 이어서 `npx tsc -b`
Expected: PASS (동작 불변) + 타입 에러 0.

> 주의: import 추가가 필요할 수 있다(`ITimeScaleApi` 등). 기존 파일이 `Time`을 이미 import하는지 확인하고 부족분만 추가.

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/live/LiveChartRoot.tsx
git commit -m "refactor(live): viewport-shift 캡처를 captureViewportShift로 추출 (스텝 공유)"
```

---

## Task 7: 진행 루프 settle-effect + prop 배선 (coupled)

스텝 2..N: `isExtending` falling edge에 `planFillStep`을 호출해 자가 전진. minute-only. prop 배선(LivePage→LiveWorkarea→LiveChartRoot)은 tsc가 강제하므로 같은 커밋.

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (Props, 새 effect, fill-step ref)
- Modify: `frontend/src/live/LivePage.tsx:78`, `frontend/src/live/LiveWorkarea.tsx`
- Test: `frontend/src/live/LiveChartRoot.test.tsx`

- [ ] **Step 1: 실패 테스트 작성 (settle-effect 진행)**

`LiveChartRoot.test.tsx`에서 **`makeTs`/`buildStableCapturingMock`가 정의된 describe 블록 안**(viewport 복원 테스트와 같은 블록 — settle-effect가 같은 viewport 머신을 쓴다)에 추가한다. `makeTs(handlers)`는 **안정적 ts 객체**를 돌려주므로(그 `getVisibleLogicalRange`는 모듈 상수 `LR_FROM` 고정), 테스트별로 그 메서드를 덮어 `from`을 제어한다. `buildChartMockCapturing`의 timeScale은 호출마다 새 객체일 수 있어 오버라이드가 안 먹으니 쓰지 않는다. 진행 단계는 `isExtending`를 true→false로 rerender해 falling edge를 만든다:

```ts
it('dispatches the next step on isExtending falling edge while whitespace remains', () => {
  // 스텝 1 이미 settle된 상태에서 시작: historicalFromDate 세팅 + viewport 여전히 빈영역.
  useLivePageStore.setState({ historicalFromDate: '20260521' });
  const handlers: Array<(r: unknown) => void> = [];
  const ts = makeTs(handlers);
  ts.getVisibleLogicalRange = vi.fn(() => ({ from: -50, to: 100 })); // 빈영역 남음
  vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

  const { rerender } = render(
    <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
      clampEngaged={false} isPastCandlesLoading={false} isExtending={true} />,
    { wrapper },
  );
  // falling edge: true → false (= 스텝 settle).
  act(() => {
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={false} />,
    );
  });

  // cur '20260521' − stepChunkDays('1m')=5 → '20260516'.
  expect(useLivePageStore.getState().historicalFromDate).toBe('20260516');
});

it('does NOT dispatch a next step when the viewport is full (visibleFrom >= 0)', () => {
  useLivePageStore.setState({ historicalFromDate: '20260521' });
  const handlers: Array<(r: unknown) => void> = [];
  const ts = makeTs(handlers);
  ts.getVisibleLogicalRange = vi.fn(() => ({ from: 4, to: 100 })); // 꽉 참
  vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

  const { rerender } = render(
    <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
      clampEngaged={false} isPastCandlesLoading={false} isExtending={true} />,
    { wrapper },
  );
  act(() => {
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={false} />,
    );
  });

  // viewport 꽉 참 → 다음 스텝 없음. historicalFromDate 불변.
  expect(useLivePageStore.getState().historicalFromDate).toBe('20260521');
});

it('does NOT run the fill loop on D timeframe (minute-only)', () => {
  useLivePageStore.setState({ historicalFromDate: '20260521' });
  const handlers: Array<(r: unknown) => void> = [];
  const ts = makeTs(handlers);
  ts.getVisibleLogicalRange = vi.fn(() => ({ from: -50, to: 100 }));
  vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

  const { rerender } = render(
    <LiveChartRoot code="005930" timeframe="D" bundle={TWO_SEGMENT_BUNDLE}
      clampEngaged={false} isPastCandlesLoading={false} isExtending={true} />,
    { wrapper },
  );
  act(() => {
    rerender(
      <LiveChartRoot code="005930" timeframe="D" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={false} />,
    );
  });

  // D는 one-shot → settle-loop 미동작. 불변.
  expect(useLivePageStore.getState().historicalFromDate).toBe('20260521');
});
```

> `makeTs`/`buildStableCapturingMock`는 그 describe 블록의 지역 함수다(line 613/603 부근). 새 테스트는 반드시 그 블록 안에 둔다. `TWO_SEGMENT_BUNDLE` axis earliest는 '20260526'.

기존 테스트들(430/461/496 등)이 `isExtending` prop을 안 넘기므로, prop을 **선택적(default false)** 으로 둬 기존 테스트를 무수정 통과시킨다(Step 3에서 `isExtending = false` 기본값).

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx -t "falling edge"`
Expected: FAIL — `isExtending` prop 미존재 타입 에러 / 루프 미동작.

- [ ] **Step 3: Props + fill-step ref + settle-effect 구현**

`LiveChartRoot.tsx`:

(a) Props 인터페이스(line 55-60 부근)에 추가:
```ts
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isExtending. false-edge = 한 스텝 settle → 진행 루프 다음 스텝 판정. */
  isExtending?: boolean;
```
그리고 구조분해(line 66)에 `isExtending = false` 기본값:
```ts
export function LiveChartRoot({ code, timeframe, bundle, clampEngaged, isPastCandlesLoading, isExtending = false }: Props) {
```

(b) fill-step 카운터 ref + 직전 extending ref를 다른 ref 선언(line 148-151 근처)에 추가:
```ts
  // 진행 루프: 현재 fill에서 dispatch한 스텝 수(백스톱용) + isExtending 직전값(falling edge 검출).
  const fillStepCountRef = useRef(0);
  const prevExtendingRef = useRef(false);
```

(c) 핸들러(스텝 1)에서 새 fill 시작 시 카운터 리셋. line 441 `viewportShiftRef.current = captureViewportShift(ts, axis);` 직후(또는 dispatch 직전)에:
```ts
      fillStepCountRef.current = 1; // 이 dispatch가 스텝 1
```
(핸들러는 이미 `nextHistoricalFrom(..., stepChunkDays(timeframe))`로 dispatch — Task 3에서 적용됨.)

(d) reset effect(line 152-156, `[code, timeframe]`)에 카운터 리셋 추가:
```ts
  useEffect(() => {
    lastAppliedCountRef.current = null;
    prevEarliestTsMsRef.current = null;
    viewportShiftRef.current = null;
    fillStepCountRef.current = 0;
    prevExtendingRef.current = false;
  }, [code, timeframe]);
```

(e) **새 settle-effect** — viewport 복원 effect(234-288) **뒤에** 선언(복원이 먼저 shift를 적용한 뒤 viewport from을 읽어야 함). `todayKstYyyymmdd`, `stepChunkDays`, `planFillStep`, `earliestAllowedMinuteDate`를 import에 추가:

```ts
  // 진행 루프(스텝 2..N): 한 스텝 settle(isExtending true→false) 직후 viewport가
  // 아직 빈영역이면 다음 스텝을 자가 dispatch한다. minute-only(D/W/M은 one-shot).
  // planFillStep이 종료(꽉 참/클램프/백스톱)를 판정. 복원 effect 뒤에 선언해
  // getVisibleLogicalRange가 shift 적용 후 위치를 읽도록 한다.
  useEffect(() => {
    const wasExtending = prevExtendingRef.current;
    prevExtendingRef.current = isExtending;
    if (!chart) return;
    if (!isMinuteTimeframe(timeframe)) return;
    // falling edge만(한 스텝이 막 settle).
    if (!(wasExtending && !isExtending)) return;
    const cur = useLivePageStore.getState().historicalFromDate;
    if (cur === null) return; // 초기/비확장 경로
    if (axis.segments.length === 0) return;
    const ts = chart.timeScale();
    let visibleFrom: number | null = null;
    try {
      visibleFrom = ts.getVisibleLogicalRange()?.from ?? null;
    } catch {
      visibleFrom = null;
    }
    const plan = planFillStep({
      visibleFrom,
      historicalFromDate: cur,
      axisEarliestMs: axis.segments[0].sessionOpenMs,
      earliestAllowedDate: earliestAllowedMinuteDate(todayKstYyyymmdd()),
      stepCalendarDays: stepChunkDays(timeframe),
      stepCount: fillStepCountRef.current,
      maxSteps: 60,
    });
    if (plan.action === 'stop') {
      fillStepCountRef.current = 0; // 다음 사용자 드래그를 위해 리셋
      return;
    }
    // 다음 스텝: 캡처 후 dispatch(복원 effect가 prepend 후 viewport를 보존).
    viewportShiftRef.current = captureViewportShift(ts, axis);
    fillStepCountRef.current += 1;
    useLivePageStore.getState().extendHistoricalRange(plan.nextFrom);
  }, [chart, axis, timeframe, isExtending]);
```

(f) import 보강: `LiveChartRoot.tsx:27`를
```ts
import { nextHistoricalFrom, stepChunkDays, planFillStep, earliestAllowedMinuteDate, todayKstYyyymmdd } from './liveDateTime';
```
(`todayKstYyyymmdd`가 이미 다른 곳에서 import돼 있으면 중복 제거.)

- [ ] **Step 4: prop 배선 (LivePage → LiveWorkarea → LiveChartRoot)**

`LivePage.tsx:78`:
```ts
  const { bundle, clampEngaged, isPastCandlesLoading, isExtending } = useLiveBundle(
    activeCode,
    timeframe,
    today,
    live,
  );
```
`LivePage.tsx`의 `<LiveWorkarea ... />`(line 109 부근)에 `isExtending={isExtending}` 추가.

`LiveWorkarea.tsx`: `LiveWorkareaProps`에 `isExtending: boolean;` 추가하고, 내부 `<LiveChartRoot ... clampEngaged={clampEngaged} isPastCandlesLoading={isPastCandlesLoading} />`에 `isExtending={isExtending}` 추가(기존 `clampEngaged` 전달 지점과 동일 위치).

- [ ] **Step 5: 전체 통과 + 타입 확인**

Run: `cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx src/live/useLiveBundle.test.tsx src/live/liveDateTime.test.ts` 이어서 `npx tsc -b`
Expected: PASS (신규 3 + 기존) + 타입 에러 0.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx frontend/src/live/LivePage.tsx frontend/src/live/LiveWorkarea.tsx
git commit -m "feat(live): 분봉 좌측 팬 고정 3거래일 스텝 점진 채우기 루프 (settle-effect, minute-only)"
```

---

## Task 8: 수동 검증 (`/live`)

순수 커널은 단위 테스트가 덮지만, lwc 렌더 타이밍(복원 shift 후 `getVisibleLogicalRange` 반영, 스텝 사이 viewport 보존)은 실제 차트에서만 확인된다.

**Files:** 없음(검증만)

- [ ] **Step 1: dev 서버 기동**

CLAUDE.md "Dev servers" 절대로:
```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```
별 터미널:
```bash
cd frontend && npm run dev   # http://localhost:5173
```

- [ ] **Step 2: 보통 줌 — 첫 그림 ~3.4초, 1스텝**

`/browse`로 `http://localhost:5173/live` 열고 캐시 없는 종목 1분봉으로 좌측 팬 1회. 직접 API 병행 확인:
```bash
.venv/bin/python3 -c "import urllib.request,time,json; t=time.time(); r=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/live/past-candles?code=<CODE>&from=<5일전>&to=<오늘-1>')); print(round(time.time()-t,2),'s  fresh=',len(r['fresh_dates']),' cached=',len(r['cached_dates']))"
```
Expected: 응답 ~3~4초, `fresh_dates` 길이 ~3거래일(≈5 캘린더일 중 거래일분), 차트가 한 번에 그려짐.

- [ ] **Step 3: 줌아웃 후 팬 — 여러 스텝 점진 채움**

차트를 넓게 줌아웃 후 좌측 팬. 화면이 **3거래일씩 여러 번에 걸쳐 왼쪽으로 채워지는지**, 첫 스텝이 ~3.4초 안에 보이는지 육안 확인. `$B network`로 `/api/live/past-candles` 요청이 연속 여러 번 나가는지 확인.

- [ ] **Step 4: viewport 보존 — 스텝마다 점프 없음**

스텝이 채워지는 동안 사용자가 보던 봉이 **같은 화면 위치·스케일**에 머무는지(스텝마다 점프/깜빡임 없음). 이것이 Task 7 settle-effect의 캡처가 스텝 2..N에서 제대로 도는지의 핵심 검증(spec Risk "스텝 2..N 캡처"). 점프가 보이면 복원 effect와 settle-effect 선언 순서/타이밍 재점검.

- [ ] **Step 5: 연휴 가로지르기 — 동결 없음**

설/추석 구간을 가로질러 팬 → 동결 없이 계속 과거로 채워지는지(첫 통과 시 연휴 헛호출로 약간 지연 가능 — 정상, 후속 범위).

- [ ] **Step 6: 250일 깊이 — 클램프에서 멈춤**

계속 끌어 250일 깊이 도달 → 루프가 멈추고(빈영역 남아도 더 안 받음) `clampEngaged` 표시가 뜨는지.

- [ ] **Step 7: D/W/M 회귀 — one-shot 유지**

일봉으로 좌측 팬 → 기존처럼 ~1년치를 한 번에 그려 채우는지(점진 스텝 아님).

---

## Self-Review

**1. Spec coverage:**
- 고정 3거래일 스텝 사이징 → Task 2 (`stepChunkDays`).
- nextHistoricalFrom chunkDays 주입 → Task 3.
- 진행 루프(viewport 찰 때까지) + 종료 3조건 + 백스톱 → Task 4 (`planFillStep`) + Task 7 (effect).
- 스텝 2..N viewport 캡처(spec Open Question, 기본 settle-effect) → Task 6 (`captureViewportShift` 공유) + Task 7 (settle-effect가 캡처 호출). **결정: option (b) settle-effect 명시 캡처를 구현**(lwc 이벤트 재발화에 비의존). option (a)는 Task 8 Step 4 육안 검증으로 (b)가 충분하면 그대로, 점프 시 재점검.
- 250일 클램프 종료 → Task 1 (`earliestAllowedMinuteDate`) + Task 4 (clamp 분기).
- prefetch 미채택 → 코드 추가 없음(원안 §2는 미구현 설계였으므로 삭제할 코드 없음; `prefetchChunkDaysFor`는 42일 사이징이라 Task 3에서 제거).
- 연휴 처리(백엔드) → Non-Goal, 이 plan 범위 밖.

**2. Placeholder scan:** 모든 step에 실제 코드/명령/기대값 포함. TBD/TODO 없음.

**3. Type consistency:** `stepChunkDays`(Task 2)·`nextHistoricalFrom(…, chunkDays:number)`(Task 3)·`planFillStep`(Task 4)·`isExtending`(Task 5)·`captureViewportShift`(Task 6)·`FillStepArgs` 필드명이 Task 7 effect 호출과 일치. `earliestAllowedMinuteDate`(Task 1)는 Task 5·Task 7 양쪽에서 같은 시그니처로 호출.

**주의 사항(구현 중 확인):**
- Task 7 settle-effect의 `getVisibleLogicalRange()`가 복원 effect의 `setVisibleLogicalRange` 후 위치를 같은 tick에 반영하는지는 lwc 타이밍 의존 — Task 8 Step 3/4가 1차 검증. 경계 근처(from≈0)에서 1스텝 과/소가 나면 cheap(캐시)이므로 수용, 점프가 나면 (a) 핸들러 자가구동으로 전환 검토.
- Task 7 테스트는 `makeTs`+`buildStableCapturingMock`(안정적 ts) 하니스를 쓰고 `ts.getVisibleLogicalRange`를 테스트별로 덮는다 — `buildChartMockCapturing`은 timeScale이 호출마다 새 객체일 수 있어 오버라이드가 안 먹으니 쓰지 않는다. 새 테스트는 그 두 헬퍼가 정의된 describe 블록 안에 둔다.
- 기존 LiveChartRoot 테스트는 `isExtending` 미전달 → optional default false로 무수정 통과.
