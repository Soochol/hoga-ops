# /live 차트 렌더 경로 최적화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 차트의 프론트엔드 렌더·페치 경로 3건(projectCandle 핫패스 이진화, in-flight 요청 취소, 장중 한정 리페치)을 백엔드/API 계약 변경 없이 최적화한다.

**Architecture:** (1) 캔들 phase 분류의 세그먼트 선형 스캔을 이진 탐색으로 바꾸고(`locateSegment`) projector를 단일-패스로 융합한다. (2) react-query가 주는 `signal`을 `fetch`까지 전달해 키 변경 시 이전 요청을 취소한다. (3) 60초 리페치를 정규장 시간대에만 활성화한다. 도메인 규칙(KRX 세션 phase)은 `sessionTime.ts` 단일 진실을 유지한다.

**Tech Stack:** TypeScript, React, @tanstack/react-query v5, lightweight-charts, vitest, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-09-live-chart-render-path-design.md`

**Test runner:** `cd frontend && npx vitest run <path> -t "<name>"` (단일), `cd frontend && npx vitest run <path>` (파일 전체).

---

## File Structure

- `frontend/src/util/sessionTime.ts` — **수정**: `locateSegment`(이진 탐색, idx+phase 반환) 추가, `sessionPhaseAt`을 그 위로 재구현. 도메인 phase 규칙의 단일 진실.
- `frontend/src/util/sessionTime.test.ts` — **수정**: 선형 레퍼런스 대비 등가성 프로퍼티 테스트 추가.
- `frontend/src/util/virtualAxis.ts` — **수정**: `classifyAndProject(realMs)` 메서드 추가(1회 `locateSegment`로 contained/inAuction/virtual 산출). 기존 `contains`/`toVirtual`/`inClosingAuctionWindow` 공개 API는 무변경.
- `frontend/src/util/virtualAxis.test.ts` — **수정**: `classifyAndProject` 등가성 테스트 추가.
- `frontend/src/chart/projectors/candle.ts` — **수정**: `projectCandle`을 filter+map 2-패스 → 단일 for-루프로 융합, `classifyAndProject` 사용.
- `frontend/src/chart/projectors/candle.perf.test.ts` — **생성**: 깊은 스크롤(170세그먼트×65k캔들) 벽시계 측정.
- `frontend/src/api/livePastCandles.ts`, `range.ts`, `livePastDailyCandles.ts`, `livePastInvestorNet.ts` — **수정**: `queryFn`에 `signal` 전달(항목 3). 리페치 게이트는 60초 리페치를 가진 3개(`livePastCandles`/`livePastDailyCandles`/`livePastInvestorNet`)에만(항목 4) — `range.ts`는 `refetchInterval` 없음(제외).
- `frontend/src/api/livePastCandles.test.tsx`, `range.test.tsx`, `livePastDailyCandles.test.tsx` — **수정**: `toHaveBeenCalledWith` 2-인자로 갱신 + 시그널 전달 테스트.
- `frontend/src/live/liveDateTime.ts` — **수정**: `isKrxRegularSessionNow(nowMs?)` 추가.
- `frontend/src/live/liveDateTime.test.ts` — **생성 또는 수정**: 헬퍼 단위 테스트.

---

## Task 1: `locateSegment` — sessionPhaseAt 이진화 (항목 2a)

**Files:**
- Modify: `frontend/src/util/sessionTime.ts:81` (`sessionPhaseAt`)
- Test: `frontend/src/util/sessionTime.test.ts`

목표: `sessionPhaseAt`의 세그먼트 선형 for-루프를 이진 탐색으로 바꾸되 **모든 입력에서 동일 phase 반환**. owning 세그먼트 인덱스도 함께 반환해 항목 2b가 재사용.

- [ ] **Step 1: 등가성 프로퍼티 테스트 작성 (실패 예정)**

`frontend/src/util/sessionTime.test.ts` 끝에 추가. 파일 상단 import에 `locateSegment`를 추가한다(아직 미존재 → 컴파일 실패가 곧 red).

```ts
// --- 항목 2a: 선형 레퍼런스 대비 등가성 ---

// Task 1 이전의 선형 sessionPhaseAt을 그대로 복제한 레퍼런스 구현.
function sessionPhaseAtLinear(
  segments: readonly { sessionOpenMs: number; sessionCloseMs: number }[],
  realMs: number,
): string {
  if (segments.length === 0) return 'pre-axis';
  const first = segments[0];
  if (realMs < first.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'pre-axis';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const preOpenStart = seg.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS;
    if (realMs < preOpenStart) return 'gap';
    if (realMs <= seg.sessionCloseMs) return classifyWithinSegment(seg, realMs);
  }
  return 'post-axis';
}

describe('sessionPhaseAt binary == linear reference', () => {
  // 5거래일치 세그먼트(full-day + half-day 혼합), 현실적 야간 갭(24h 간격).
  const DAY = 24 * 60 * 60 * 1000;
  const FULL = 6.5 * 60 * 60 * 1000;
  const HALF = 3.5 * 60 * 60 * 1000;
  const base = 1_779_062_400_000; // 2026-05-18 09:00 KST
  const segments = [
    { sessionOpenMs: base + 0 * DAY, sessionCloseMs: base + 0 * DAY + FULL },
    { sessionOpenMs: base + 1 * DAY, sessionCloseMs: base + 1 * DAY + HALF },
    { sessionOpenMs: base + 2 * DAY, sessionCloseMs: base + 2 * DAY + FULL },
    { sessionOpenMs: base + 5 * DAY, sessionCloseMs: base + 5 * DAY + FULL }, // 주말 갭
    { sessionOpenMs: base + 6 * DAY, sessionCloseMs: base + 6 * DAY + FULL },
  ];

  // 경계 정확값 + 무작위 샘플.
  const boundaries: number[] = [];
  for (const s of segments) {
    boundaries.push(
      s.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS - 1,
      s.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS,
      s.sessionOpenMs - 1,
      s.sessionOpenMs,
      s.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS - 1,
      s.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS,
      s.sessionCloseMs,
      s.sessionCloseMs + 1,
    );
  }
  const lo = segments[0].sessionOpenMs - 2 * DAY;
  const hi = segments[segments.length - 1].sessionCloseMs + 2 * DAY;
  const random: number[] = [];
  let seed = 12345;
  for (let i = 0; i < 5000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // 결정적 LCG
    random.push(lo + (seed % (hi - lo)));
  }

  it('agrees on every boundary and random sample', () => {
    for (const t of [...boundaries, ...random]) {
      expect(locateSegment(segments, t).phase).toBe(sessionPhaseAtLinear(segments, t));
    }
  });

  it('empty segments → pre-axis, idx -1', () => {
    expect(locateSegment([], 0)).toEqual({ idx: -1, phase: 'pre-axis' });
  });

  it('returns owning index for contained timestamps', () => {
    const mid = segments[2].sessionOpenMs + 60_000;
    expect(locateSegment(segments, mid)).toEqual({ idx: 2, phase: 'regular' });
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd frontend && npx vitest run src/util/sessionTime.test.ts -t "binary == linear"`
Expected: FAIL — `locateSegment` is not exported (import error).

- [ ] **Step 3: `locateSegment` 구현 + `sessionPhaseAt` 재구현**

`frontend/src/util/sessionTime.ts`에서 기존 `sessionPhaseAt`(현재 `:81`의 함수 본문)을 아래로 교체한다. `classifyWithinSegment`/상수들은 그대로 둔다.

```ts
/** Last index whose pre-open band start (`sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS`)
 *  is ≤ realMs. -1 when realMs precedes the first segment's pre-open band.
 *  Equivalent to `sessionOpenMs ≤ realMs + PRE_OPEN_WINDOW_LENGTH_MS`. */
function lowerBoundOwning(segments: readonly SessionSegment[], realMs: number): number {
  const key = realMs + PRE_OPEN_WINDOW_LENGTH_MS;
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].sessionOpenMs <= key) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export interface SegmentLocation {
  /** Owning/candidate segment index, or -1 when realMs is pre-axis. */
  idx: number;
  phase: SessionPhase;
}

/**
 * Binary-search variant of phase classification. Returns both the owning
 * segment index (for callers that also need the segment, e.g. virtual-coord
 * projection) and the phase. Owning segment = last whose pre-open band has
 * started. Assumes inter-session gaps exceed PRE_OPEN_WINDOW_LENGTH_MS (true
 * for daily KRX sessions); the prior linear implementation made the same
 * assumption.
 */
export function locateSegment(
  segments: readonly SessionSegment[],
  realMs: number,
): SegmentLocation {
  if (segments.length === 0) return { idx: -1, phase: 'pre-axis' };
  const idx = lowerBoundOwning(segments, realMs);
  if (idx < 0) return { idx: -1, phase: 'pre-axis' };
  const seg = segments[idx];
  if (realMs <= seg.sessionCloseMs) {
    return { idx, phase: classifyWithinSegment(seg, realMs) };
  }
  // Past this segment's close: gap if another segment follows, else post-axis.
  return { idx, phase: idx === segments.length - 1 ? 'post-axis' : 'gap' };
}

export function sessionPhaseAt(segments: readonly SessionSegment[], realMs: number): SessionPhase {
  return locateSegment(segments, realMs).phase;
}
```

`sessionTime.test.ts` 상단 import에 `locateSegment` 추가:

```ts
import {
  classifyWithinSegment,
  isClosingAuction,
  isPreOpen,
  isRegularSession,
  locateSegment,
  sessionPhaseAt,
  AUCTION_WINDOW_LENGTH_MS,
  PRE_OPEN_WINDOW_LENGTH_MS,
} from './sessionTime';
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd frontend && npx vitest run src/util/sessionTime.test.ts`
Expected: PASS (기존 테스트 + 새 등가성 테스트 모두).

- [ ] **Step 5: 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-perf-spec
git add frontend/src/util/sessionTime.ts frontend/src/util/sessionTime.test.ts
git commit -m "perf(live): sessionPhaseAt 선형→이진(locateSegment), 등가성 프로퍼티 테스트"
```

---

## Task 2: `classifyAndProject` + projectCandle 단일-패스 (항목 2b)

**Files:**
- Modify: `frontend/src/util/virtualAxis.ts` (인터페이스 `:42`, 본문 `:262` Object.freeze)
- Modify: `frontend/src/chart/projectors/candle.ts:26-43`
- Test: `frontend/src/util/virtualAxis.test.ts`, `frontend/src/chart/projectors/candle.test.ts`

목표: 캔들당 3회 조회(`contains`+`inClosingAuctionWindow`+`toVirtual`)를 1회 `locateSegment`로 융합. **그려지는 캔들의 출력 동등성** 보존.

- [ ] **Step 1: `classifyAndProject` 등가성 테스트 작성 (실패 예정)**

`frontend/src/util/virtualAxis.test.ts` 끝에 추가:

```ts
describe('classifyAndProject == contains+inAuction+toVirtual', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FULL = 6.5 * 60 * 60 * 1000;
  const base = 1_779_062_400_000;
  const axis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: base, sessionCloseMs: base + FULL },
    { date: '20260519', sessionOpenMs: base + DAY, sessionCloseMs: base + DAY + FULL },
    { date: '20260522', sessionOpenMs: base + 4 * DAY, sessionCloseMs: base + 4 * DAY + FULL },
  ]);

  it('agrees with the legacy three-call path on random + boundary timestamps', () => {
    const samples: number[] = [];
    let seed = 99;
    const lo = base - DAY;
    const hi = base + 4 * DAY + FULL + DAY;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      samples.push(lo + (seed % (hi - lo)));
    }
    for (const t of samples) {
      const got = axis.classifyAndProject(t);
      expect(got.contained).toBe(axis.contains(t));
      expect(got.inAuction).toBe(axis.inClosingAuctionWindow(t));
      if (got.contained) {
        expect(got.virtual).toBe(axis.toVirtual(t)); // kept 캔들만 virtual 일치
      }
    }
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd frontend && npx vitest run src/util/virtualAxis.test.ts -t "classifyAndProject"`
Expected: FAIL — `axis.classifyAndProject is not a function`.

- [ ] **Step 3: `virtualAxis`에 `classifyAndProject` 추가**

`frontend/src/util/virtualAxis.ts`:

(a) import에 `locateSegment` 추가 (`:33`):

```ts
import { isClosingAuction, isRegularSession, locateSegment } from './sessionTime';
```

(b) `VirtualAxis` 타입(`:42` 블록)의 `inClosingAuctionWindow(realMs): boolean;` 바로 뒤에 추가:

```ts
  /**
   * Single-lookup projection for the candle hot path: one `locateSegment`
   * binary search yields all three of `contains` / `inClosingAuctionWindow` /
   * `toVirtual` for `realMs`. `virtual` is meaningful only when `contained`
   * is true (dropped candles never read it). Equivalent to calling the three
   * methods separately — see virtualAxis.test.ts equivalence test.
   */
  classifyAndProject(realMs: number): { contained: boolean; inAuction: boolean; virtual: number };
```

(c) 본문에서 `contains`/`toVirtual`이 보이는 클로저 스코프(세그먼트 배열 `segments`가 잡히는 곳)에 함수 정의 추가하고, `Object.freeze({...})`(`:262`)에 등록:

```ts
  function classifyAndProject(realMs: number): { contained: boolean; inAuction: boolean; virtual: number } {
    const { idx, phase } = locateSegment(segments, realMs);
    const contained = phase === 'regular' || phase === 'auction';
    if (!contained) return { contained: false, inAuction: false, virtual: 0 };
    const seg = segments[idx];
    return {
      contained: true,
      inAuction: phase === 'auction',
      virtual: seg.virtualStart + (realMs - seg.sessionOpenMs),
    };
  }
```

Object.freeze 등록 (기존 `inClosingAuctionWindow,` 뒤에 한 줄 추가):

```ts
    inClosingAuctionWindow,
    classifyAndProject,
    contains,
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd frontend && npx vitest run src/util/virtualAxis.test.ts`
Expected: PASS.

- [ ] **Step 5: `projectCandle` 단일-패스로 융합**

`frontend/src/chart/projectors/candle.ts`의 `projectCandle`(`:26-43`)를 교체:

```ts
export function projectCandle(bundle: RangeBundle, axis: VirtualAxis): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];
  for (const c of bundle.candles) {
    const { contained, inAuction, virtual } = axis.classifyAndProject(c.ts_ms);
    if (!contained) continue;
    const color = inAuction ? muted : c.close >= c.open ? up : down;
    out.push({
      time: (virtual / 1000) as UTCTimestamp,
      open: c.open,
      close: c.close,
      high: c.high,
      low: c.low,
      color,
      borderColor: color,
      wickColor: color,
    });
  }
  return out;
}
```

- [ ] **Step 6: projectCandle 기존 테스트 실행 → 통과 확인 (동작 보존)**

Run: `cd frontend && npx vitest run src/chart/projectors/candle.test.ts`
Expected: PASS — 기존 테스트가 색/좌표/auction muting을 그대로 검증하므로 동작 보존이 입증됨.

- [ ] **Step 7: 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-perf-spec
git add frontend/src/util/virtualAxis.ts frontend/src/util/virtualAxis.test.ts frontend/src/chart/projectors/candle.ts
git commit -m "perf(live): projectCandle 캔들당 조회 3→1 융합(classifyAndProject)"
```

---

## Task 3: 깊은 스크롤 벽시계 측정 (항목 2 검증)

**Files:**
- Create: `frontend/src/chart/projectors/candle.perf.test.ts`

목표: 스펙이 요구한 "측정으로 win 입증". 170세그먼트 × 65k캔들에서 신규 단일-패스가 레거시 3-콜 합성보다 빠름을 재현 가능하게 기록.

- [ ] **Step 1: 측정 테스트 작성**

```ts
import { describe, it, expect } from 'vitest';
import { projectCandle } from './candle';
import { createVirtualAxis } from '../../util/virtualAxis';

// 레거시 3-콜 경로를 재현한 레퍼런스 projector (측정 비교 기준).
function projectCandleLegacy(bundle: any, axis: any) {
  return bundle.candles
    .filter((c: any) => axis.contains(c.ts_ms))
    .map((c: any) => {
      const inAuction = axis.inClosingAuctionWindow(c.ts_ms);
      return { time: axis.toVirtual(c.ts_ms) / 1000, open: c.open, close: c.close, high: c.high, low: c.low, inAuction };
    });
}

describe('projectCandle deep-scroll wall-clock', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FULL = 6.5 * 60 * 60 * 1000;
  const base = 1_779_062_400_000;
  const segments = [];
  for (let d = 0; d < 170; d++) {
    const open = base + d * DAY;
    segments.push({ date: `2026d${d}`, sessionOpenMs: open, sessionCloseMs: open + FULL });
  }
  const axis = createVirtualAxis(segments);

  // ~65k 캔들: 170일 × 390분봉.
  const candles = [];
  for (let d = 0; d < 170; d++) {
    const open = base + d * DAY;
    for (let m = 0; m < 390; m++) {
      const ts = open + m * 60_000;
      candles.push({ ts_ms: ts, open: 100, close: 101, high: 102, low: 99 });
    }
  }
  const bundle: any = { candles };

  function median(fn: () => void): number {
    const runs: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    return runs.sort((a, b) => a - b)[3];
  }

  it('single-pass projector is faster than the legacy three-call path', () => {
    projectCandle(bundle, axis); // warm-up
    projectCandleLegacy(bundle, axis);
    const fused = median(() => projectCandle(bundle, axis));
    const legacy = median(() => projectCandleLegacy(bundle, axis));
    // eslint-disable-next-line no-console
    console.log(`[perf] candles=${candles.length} segments=${segments.length} fused=${fused.toFixed(1)}ms legacy=${legacy.toFixed(1)}ms`);
    expect(fused).toBeLessThanOrEqual(legacy);
  });
});
```

- [ ] **Step 2: 측정 실행 → 통과 + 수치 기록**

Run: `cd frontend && npx vitest run src/chart/projectors/candle.perf.test.ts`
Expected: PASS. 콘솔의 `[perf] ... fused=Xms legacy=Yms` 줄을 커밋 메시지나 PR에 기록한다. legacy(선형 2회/캔들)가 170세그먼트에서 fused(이진 1회/캔들)보다 느려야 하므로 통과해야 한다. 만약 fused ≤ legacy가 깨지면 항목 2의 효과 가정이 틀린 것 → 머지 전 재검토(스펙 Risks 참조).

- [ ] **Step 3: 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-perf-spec
git add frontend/src/chart/projectors/candle.perf.test.ts
git commit -m "test(live): projectCandle 깊은 스크롤 벽시계 측정(fused vs legacy)"
```

---

## Task 4: react-query `signal`로 in-flight 취소 (항목 3)

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts:37`, `range.ts:41`, `livePastDailyCandles.ts:41`, `livePastInvestorNet.ts:37`
- Modify: `frontend/src/api/livePastCandles.test.tsx:36`, `range.test.tsx:52`, `livePastDailyCandles.test.tsx:34`
- Test: `frontend/src/api/livePastCandles.test.tsx` (시그널 전달 테스트 추가)

목표: 4개 past-data 쿼리의 `queryFn`이 `signal`을 `fetch`까지 전달. 키 변경/언마운트 시 이전 요청 취소. (백엔드 KIS는 안 멈춤 — 토큰 절약 아님.)

- [ ] **Step 1: 기존 단언 갱신 + 시그널 전달 테스트 작성 (실패 예정)**

`frontend/src/api/livePastCandles.test.tsx:36`의 단언을 2-인자로 교체:

```ts
    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-candles?code=005930&from=20260501&to=20260502',
      { signal: expect.any(AbortSignal) },
    );
```

같은 파일에 시그널 전달 검증 테스트 추가:

```ts
  it('passes an AbortSignal to apiCall', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', '20260501', '20260502'), { wrapper: wrap(qc) });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const secondArg = spy.mock.calls[0][1] as RequestInit | undefined;
    expect(secondArg?.signal).toBeInstanceOf(AbortSignal);
  });
```

`range.test.tsx:52`와 `livePastDailyCandles.test.tsx:34`의 `toHaveBeenCalledWith(...)`도 동일하게 2번째 인자 `{ signal: expect.any(AbortSignal) }`를 추가한다(첫 인자 URL 문자열은 각 파일의 기존 값 유지).

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx`
Expected: FAIL — queryFn이 아직 signal을 안 넘김(단일 인자로 호출됨).

- [ ] **Step 3: 4개 queryFn에 signal 전달**

`livePastCandles.ts:37`:

```ts
    queryFn: ({ signal }) =>
      apiCall<LivePastCandlesResponse>(
        `/api/live/past-candles?code=${code}&from=${from}&to=${to}`,
        { signal },
      ),
```

`range.ts:41`:

```ts
    queryFn: ({ signal }) =>
      apiCall<RangeBundle>(
        `/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${bucketMs}` +
          `${priceQs}&source_pref=${sourcePref}`,
        { signal },
      ),
```

`livePastDailyCandles.ts:41`:

```ts
    queryFn: ({ signal }) =>
      apiCall<LivePastDailyCandlesResponse>(
        `/api/live/past-daily-candles?code=${code}&from=${from}&to=${to}`,
        { signal },
      ),
```

`livePastInvestorNet.ts:37`:

```ts
    queryFn: ({ signal }) =>
      apiCall<LivePastInvestorNetResponse>(
        `/api/live/past-investor-net?code=${code}&from=${from}&to=${to}`,
        { signal },
      ),
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx src/api/range.test.tsx src/api/livePastDailyCandles.test.tsx`
Expected: PASS (갱신된 단언 + 새 시그널 테스트).

- [ ] **Step 5: 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-perf-spec
git add frontend/src/api/livePastCandles.ts frontend/src/api/range.ts frontend/src/api/livePastDailyCandles.ts frontend/src/api/livePastInvestorNet.ts frontend/src/api/livePastCandles.test.tsx frontend/src/api/range.test.tsx frontend/src/api/livePastDailyCandles.test.tsx
git commit -m "perf(live): past-data 쿼리에 AbortSignal 전달 — 드래그 중 stale 커밋 방지"
```

---

## Task 5: `isKrxRegularSessionNow` 헬퍼 (항목 4a)

**Files:**
- Modify: `frontend/src/live/liveDateTime.ts`
- Test: `frontend/src/live/liveDateTime.test.ts` (없으면 생성)

목표: 현재 KST 시각이 정규장 시간대(평일 09:00–15:30 KST)인지 판별. **공휴일 미인식**(의도적, 백엔드 책임).

- [ ] **Step 1: 단위 테스트 작성 (실패 예정)**

`frontend/src/live/liveDateTime.test.ts`에 추가(파일 없으면 아래로 생성):

```ts
import { describe, it, expect } from 'vitest';
import { isKrxRegularSessionNow } from './liveDateTime';

// 2026-05-18은 월요일. 09:00 KST = 2026-05-18 00:00 UTC = 1_779_062_400_000.
const MON_OPEN_MS = 1_779_062_400_000;
const HOUR = 3_600_000;

describe('isKrxRegularSessionNow', () => {
  it('true during weekday regular session (10:00 KST Mon)', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS + 1 * HOUR)).toBe(true);
  });
  it('true at exact open and close boundaries', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS)).toBe(true);
    expect(isKrxRegularSessionNow(MON_OPEN_MS + 6.5 * HOUR)).toBe(true);
  });
  it('false after close (18:00 KST Mon)', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS + 9 * HOUR)).toBe(false);
  });
  it('false before open (08:00 KST Mon)', () => {
    expect(isKrxRegularSessionNow(MON_OPEN_MS - 1 * HOUR)).toBe(false);
  });
  it('false on weekend (Sat 10:00 KST)', () => {
    const SAT_OPEN_MS = MON_OPEN_MS + 5 * 24 * HOUR; // +5 days → Saturday
    expect(isKrxRegularSessionNow(SAT_OPEN_MS + 1 * HOUR)).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts -t "isKrxRegularSessionNow"`
Expected: FAIL — `isKrxRegularSessionNow` not exported.

- [ ] **Step 3: 헬퍼 구현**

`frontend/src/live/liveDateTime.ts`의 `regularSessionCloseMs` 정의 바로 뒤에 추가:

```ts
/** KST 요일(0=일 … 6=토)을 YYYYMMDD에서 계산. 달력 날짜는 tz 무관이라
 *  Date.UTC 기준 getUTCDay로 안전하게 구한다. */
function kstWeekday(yyyymmdd: string): number {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10);
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * True iff `nowMs` falls within the KRX Regular Session wall-clock window —
 * a weekday between 09:00 and 15:30 KST. **Holiday-unaware by design**: a
 * weekday public holiday still reads true (holiday gating is the backend
 * calendar's responsibility, not this frontend predicate). Used to gate the
 * 60s past-data refetch so it stops outside trading hours.
 */
export function isKrxRegularSessionNow(nowMs: number = Date.now()): boolean {
  const today = realMsToYyyymmdd(nowMs);
  const wd = kstWeekday(today);
  if (wd === 0 || wd === 6) return false; // 주말
  return nowMs >= regularSessionOpenMs(today) && nowMs <= regularSessionCloseMs(today);
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `cd frontend && npx vitest run src/live/liveDateTime.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-perf-spec
git add frontend/src/live/liveDateTime.ts frontend/src/live/liveDateTime.test.ts
git commit -m "feat(live): isKrxRegularSessionNow — 정규장 시간대 판별(공휴일 미인식)"
```

---

## Task 6: 60초 리페치 장중 게이트 적용 (항목 4b)

**Files:**
- Modify: `frontend/src/api/livePastCandles.ts:44`, `livePastDailyCandles.ts:47`, `livePastInvestorNet.ts:43`

목표: 60초 리페치를 가진 3개 쿼리를 정규장 시간대에만 폴링. `range.ts`는 `refetchInterval`이 없으므로 제외. 함수 형태(`() => ...`)로 두어 페이지 열린 채 09:00을 넘으면 자동 활성화.

- [ ] **Step 1: 3개 쿼리의 `refetchInterval`을 게이트 함수로 교체**

각 파일 상단 import에 헬퍼 추가:

```ts
import { isKrxRegularSessionNow } from '../live/liveDateTime';
```

`livePastCandles.ts:44`, `livePastDailyCandles.ts:47`, `livePastInvestorNet.ts:43`의 `refetchInterval: 60_000,`을 각각 교체:

```ts
    refetchInterval: () => (isKrxRegularSessionNow() ? 60_000 : false),
```

`staleTime: 60_000`은 **그대로 유지**한다(포커스/리마운트 즉시 재페치 억제). `queryKey`/`placeholderData` 무변경.

- [ ] **Step 2: 기존 쿼리 테스트 실행 → 통과 확인 (회귀 없음)**

Run: `cd frontend && npx vitest run src/api/livePastCandles.test.tsx src/api/livePastDailyCandles.test.tsx`
Expected: PASS — `refetchInterval` 변경은 기존 단언(초기 fetch 호출)에 영향 없음.

- [ ] **Step 3: 전체 프론트 테스트 + 타입체크**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: 모든 테스트 PASS, 타입 에러 0.

- [ ] **Step 4: 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-kis-perf-spec
git add frontend/src/api/livePastCandles.ts frontend/src/api/livePastDailyCandles.ts frontend/src/api/livePastInvestorNet.ts
git commit -m "perf(live): 60초 past-data 리페치를 정규장 시간대에만 활성화"
```

- [ ] **Step 5: 수동 검증 (`/browse`)**

스펙 §Manual verification 수행:
1. 백엔드+프론트 dev 서버 기동(CLAUDE.md "Dev servers").
2. 장외 시간(또는 시스템 시계가 장외)에서 `$B goto http://localhost:5173/live` 후 60초 대기 → `$B network`로 `past-candles`/`past-daily-candles`/`past-investor-net` **재요청 없음** 확인.
3. 빠르게 좌측 연속 드래그 → `$B network`에서 이전 `past-candles` 요청이 취소(canceled)되는지, `$B console --errors`로 에러 없는지 확인.
4. 깊은 스크롤백 후 체감 부드러움 확인(항목 2). 측정 수치는 Task 3의 `[perf]` 로그로 갈음.

---

## Self-Review

**Spec coverage:**
- 항목 2a (sessionPhaseAt 이진화) → Task 1 ✓
- 항목 2b (projectCandle 융합) → Task 2 ✓
- 항목 2 측정 (필수) → Task 3 ✓
- 항목 3 (signal 취소, 4개 쿼리) → Task 4 ✓
- 항목 4a (isKrxRegularSessionNow) → Task 5 ✓
- 항목 4b (3개 쿼리 게이트, range 제외) → Task 6 ✓
- Invariant: Phase classification fidelity → Task 1 등가성 테스트 ✓ / Virtual mapping → Task 2 `virtual===toVirtual` ✓ / Code-aware placeholder·Segments-identity → 미변경(Task 2·4·6에서 해당 코드 무수정) ✓

**Type consistency:** `locateSegment` 반환 `SegmentLocation{idx,phase}`는 Task 1 정의 → Task 2에서 동일 시그니처 사용 ✓. `classifyAndProject` 반환 `{contained,inAuction,virtual}`는 Task 2 타입 정의 → projectCandle/테스트에서 동일 키 ✓. `isKrxRegularSessionNow(nowMs?)`는 Task 5 정의 → Task 6에서 무인자 호출(기본 `Date.now()`) ✓.

**Placeholder scan:** Task 4의 3개 형제 쿼리 URL 표현식을 실제 값으로 박음(코멘트 placeholder 제거). TBD/TODO/"implement later" 없음. Task 4의 `range.test.tsx:52`/`livePastDailyCandles.test.tsx:34` 단언 갱신은 "첫 인자 URL 유지 + 2번째 인자 추가"로 구체 지시.
