# /live 차트 휠 인터랙션 (Modifier-Aware Zoom & Pan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검증 완료된 순수 함수 `computeWheelOutcome`을 /live 차트에 배선해 휠=오른쪽 끝 고정 줌, shift+휠=x축 팬(오른쪽 벽), ctrl/cmd+휠=커서 고정 줌을 제공한다.

**Architecture:** 신규 훅 `useWheelInteractions(chart, containerRef, bundle)`가 차트 컨테이너에 `wheel` 리스너를 chart당 1회 부착하고(`maxTo`는 ref로 SSE bundle 교체마다 값만 갱신), `LiveChartRoot`는 `handleScale: { mouseWheel: false }`로 라이브러리 내장 휠 줌만 끈다. 동작 수식은 기존 `wheelInteractions.ts` 헬퍼를 무변경 재사용.

**Tech Stack:** React 18.3 훅, lightweight-charts 5.2 (`timeScale().getVisibleLogicalRange()/setVisibleLogicalRange()`), Vitest 4 + Testing Library (jsdom), `/browse` 헤드리스 Chromium 수동 검증.

**Spec:** `docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md` — 모든 동작 의문은 스펙이 우선.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `frontend/src/util/wheelInteractions.ts` | 휠 분기 순수 함수 (이미 존재, 테스트 22케이스) | **무변경** — 이 플랜의 어떤 태스크도 이 파일을 건드리면 안 된다 |
| `frontend/src/live/useWheelInteractions.ts` | 배선 훅: wheel 이벤트 → 헬퍼 입력 → `setVisibleLogicalRange` | **신규** |
| `frontend/src/live/useWheelInteractions.test.tsx` | 훅 배선 계약 테스트 (가짜 chart 직접 주입 — lwc 모듈 mock 불필요) | **신규** |
| `frontend/src/live/LiveChartRoot.tsx` | `handleScale` 옵션 1줄 + 훅 호출 1줄 + import 1줄 | 수정 |
| `frontend/src/live/LiveChartRoot.test.tsx` | 배선 회귀 2케이스 추가 (옵션 단언 + 컨테이너 wheel dispatch) | 수정 (파일 끝에 describe 추가) |

모든 명령은 worktree의 `frontend/` 디렉토리에서 실행한다:

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-wheel-interactions/frontend
```

`package.json`에 `test` 스크립트가 없으므로 vitest는 `npx vitest run <경로>`로 직접 실행한다.

---

### Task 1: `useWheelInteractions` 훅 — 실패하는 테스트 작성 (RED)

**Files:**
- Create: `frontend/src/live/useWheelInteractions.test.tsx`

훅은 `chart`를 **파라미터로** 받으므로 `lightweight-charts` 모듈 mock이 필요 없다.
`timeScale()`만 흉내 낸 가짜 chart 객체를 직접 주입하고, 진짜 DOM div에 진짜
`WheelEvent`를 dispatch한다. 이 테스트는 배선 계약(이벤트 → 헬퍼 입력 →
timeScale 호출)만 잠그고, 분기 수식 회귀는 기존 `wheelInteractions.test.ts`
22케이스에 위임한다(스펙 Testing 절).

- [ ] **Step 1: 테스트 파일 작성**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { useWheelInteractions } from './useWheelInteractions';

// 훅이 실제로 사용하는 timeScale 표면만 흉내 낸다. 테스트별로 필요한
// 메서드만 override.
function makeTs(over: Record<string, unknown> = {}) {
  return {
    getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 100 })),
    setVisibleLogicalRange: vi.fn(),
    coordinateToLogical: vi.fn(() => null),
    ...over,
  };
}

function makeChart(ts: ReturnType<typeof makeTs>): IChartApi {
  return { timeScale: () => ts } as unknown as IChartApi;
}

// RangeBundle 최소 픽스처 — candles 길이만 의미 있다 (maxTo = length - 1).
function makeBundle(candleCount: number): RangeBundle {
  return {
    code: '005930',
    from_date: '20260608',
    to_date: '20260608',
    bucket_ms: 60_000,
    segments: [
      {
        date: '20260608',
        session_open_ms: 1_780_000_000_000,
        session_close_ms: 1_780_023_400_000,
        source: 'kis_live',
      },
    ],
    candles: Array.from({ length: candleCount }, (_, i) => ({
      ts_ms: 1_780_000_000_000 + i * 60_000,
      open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0,
    })),
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
  };
}

function Harness({ chart, bundle }: { chart: IChartApi | null; bundle: RangeBundle | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelInteractions(chart, ref, bundle);
  return <div data-testid="wheel-host" ref={ref} />;
}

// 주의: cancelable: true가 없으면 jsdom에서 preventDefault()가 no-op이라
// defaultPrevented를 단언할 수 없다 (스펙 Testing 절의 공통 Setup).
function wheel(el: Element, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

// deltaY=100 → factor = exp(0.1) ≈ 1.10517 (줌아웃 ~10.5%)
const FACTOR = Math.exp(100 * 0.001);

describe('useWheelInteractions', () => {
  it('plain wheel: 오른쪽 끝 고정 줌 — to 유지, from만 왼쪽으로', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.to).toBe(100);
    expect(arg.from).toBeCloseTo(100 - 100 * FACTOR, 6); // ≈ -10.517
  });

  it('ctrl wheel: 커서 앵커 줌 — 양변이 앵커(50) 기준 확장', () => {
    const ts = makeTs({ coordinateToLogical: vi.fn(() => 50) });
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100, ctrlKey: true, clientX: 50 });
    expect(ts.coordinateToLogical).toHaveBeenCalledWith(50);
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.from).toBeCloseTo(50 - 50 * FACTOR, 6); // ≈ -5.259
    expect(arg.to).toBeCloseTo(50 + 50 * FACTOR, 6);   // ≈ 105.259
  });

  it('shift wheel: 스팬 유지 팬 (+스팬의 10%)', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100, shiftKey: true });
    // bundle=null → maxTo=Infinity → 클램프 미발동 (스펙 공통 Setup).
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 10, to: 110 });
  });

  it('range가 있으면 preventDefault로 페이지 스크롤 차단', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    const e = wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(e.defaultPrevented).toBe(true);
  });

  it('로드 전(visible range null): no-op + 페이지 스크롤 미차단', () => {
    const ts = makeTs({ getVisibleLogicalRange: vi.fn(() => null) });
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    const e = wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('unmount 시 리스너 해제', () => {
    const ts = makeTs();
    const { getByTestId, unmount } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    const host = getByTestId('wheel-host');
    unmount();
    wheel(host, { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('bundle 교체 시 maxTo는 ref로 갱신 — 리스너 재부착 없음', () => {
    const ts = makeTs();
    const chart = makeChart(ts); // 동일 chart identity 유지 — 리스너 effect 재실행 방지
    const { getByTestId, rerender } = render(<Harness chart={chart} bundle={makeBundle(100)} />);
    const host = getByTestId('wheel-host');
    const addSpy = vi.spyOn(host, 'addEventListener');
    rerender(<Harness chart={chart} bundle={makeBundle(50)} />); // maxTo 99 → 49
    // 재부착 없음: bundle 교체가 addEventListener('wheel', ...)를 다시 부르지 않는다.
    expect(addSpy.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(0);
    // 이벤트 시점에 ref에서 새 maxTo(49)를 읽는다: range {0,100}, step +10 →
    // newTo 110 > 49 → 클램프 {from: 49-100, to: 49}. 교체 전 maxTo(99)로
    // 클램프되면 {from: -1, to: 99}가 되어 실패한다.
    wheel(host, { deltaY: 100, shiftKey: true });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledWith({ from: -51, to: 49 });
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `npx vitest run src/live/useWheelInteractions.test.tsx`
Expected: FAIL — `Cannot find module './useWheelInteractions'` (모듈 미존재로 7케이스 전부 실패)

---

### Task 2: `useWheelInteractions` 훅 구현 (GREEN)

**Files:**
- Create: `frontend/src/live/useWheelInteractions.ts`

- [ ] **Step 1: 훅 구현**

```ts
import { useEffect, useRef, type RefObject } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { computeWheelOutcome } from '../util/wheelInteractions';

/**
 * /live 차트의 modifier-aware 휠 인터랙션 배선.
 *
 *  - 휠: 뷰포트 오른쪽 끝(`range.to`) 고정 줌
 *  - shift+휠: 스팬 유지 팬 (오른쪽 벽 = 마지막 캔들에서 클램프)
 *  - ctrl/cmd+휠: 커서 고정 줌 (클램프 없음 — 앵커 불변식 보존)
 *
 * 분기 수식은 `util/wheelInteractions.ts`의 순수 함수가 소유한다. 이 훅은
 * wheel 이벤트 → 헬퍼 입력 → `setVisibleLogicalRange` 배선만 담당.
 * 전제: `LiveChartRoot`가 `handleScale: { mouseWheel: false }`로 라이브러리
 * 내장 휠 줌을 꺼 둔다 (이중 소유권 레이스 방지). `handleScroll`(deltaX 팬)과
 * `pinch`는 라이브러리 기본값 그대로 둔다.
 *
 * See: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
 */
export function useWheelInteractions(
  chart: IChartApi | null,
  containerRef: RefObject<HTMLDivElement | null>,
  bundle: RangeBundle | null,
): void {
  // maxTo ref — bundle 교체(SSE 푸시 포함)마다 값만 갱신, 리스너는 재부착하지
  // 않는다. candles.length === 0이면 maxTo = -1이 되어 shift 오른쪽 팬이 퇴화
  // 범위({from: -1 - span, to: -1})로 클램프되므로 빈 bundle 윈도우는 Infinity로
  // 벽을 비활성화한다 (maxTo를 읽는 분기는 shift 오른쪽 팬뿐).
  const maxToRef = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    maxToRef.current =
      bundle && bundle.candles.length > 0
        ? bundle.candles.length - 1
        : Number.POSITIVE_INFINITY;
  }, [bundle]);

  // 휠 리스너 — chart당 1회 부착. deps의 containerRef는
  // react-hooks/exhaustive-deps 충족용(레포 선례: useDrawingHost) —
  // ref identity가 안정적이라 재부착을 유발하지 않는다.
  useEffect(() => {
    const container = containerRef.current;
    if (!chart || !container) return;
    const ts = chart.timeScale();

    const onWheel = (e: WheelEvent) => {
      const range = ts.getVisibleLogicalRange();
      if (!range) return; // 데이터 로드 전 — 페이지 스크롤을 방해하지 않는다
      e.preventDefault(); // 페이지 스크롤(특히 shift+휠 가로 스크롤)/브라우저 줌 차단
      const rect = container.getBoundingClientRect();
      const outcome = computeWheelOutcome({
        range,
        deltaY: e.deltaY,
        shiftKey: e.shiftKey,
        ctrlOrMetaKey: e.ctrlKey || e.metaKey,
        mouseX: e.clientX - rect.left,
        coordinateToLogical: (x) => ts.coordinateToLogical(x),
        maxTo: maxToRef.current,
      });
      if (outcome) ts.setVisibleLogicalRange(outcome);
    };

    // passive: false 필수 — 기본값(passive)이면 preventDefault()가 무시되어
    // shift+휠이 페이지 가로 스크롤을 함께 일으킨다.
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [chart, containerRef]);
}
```

- [ ] **Step 2: 테스트 실행 — 통과 확인**

Run: `npx vitest run src/live/useWheelInteractions.test.tsx`
Expected: PASS — 7케이스 전부 통과

- [ ] **Step 3: 헬퍼 무변경 확인 (회귀)**

Run: `npx vitest run src/util/wheelInteractions.test.ts`
Expected: PASS — 기존 22케이스 전부 통과 (이 플랜은 헬퍼를 건드리지 않는다)

- [ ] **Step 4: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-wheel-interactions
git add frontend/src/live/useWheelInteractions.ts frontend/src/live/useWheelInteractions.test.tsx
git commit -m "$(cat <<'EOF'
feat(live): useWheelInteractions 훅 — modifier-aware 휠 줌/팬 배선 (스펙 2026-06-07)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `LiveChartRoot` 배선 — 옵션 + 훅 호출 (TDD)

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx` (import 1줄, 옵션 1줄, 훅 호출 1줄)
- Modify: `frontend/src/live/LiveChartRoot.test.tsx` (파일 끝에 describe 1개 추가)

- [ ] **Step 1: 실패하는 배선 테스트 추가**

`frontend/src/live/LiveChartRoot.test.tsx` **파일 맨 끝**에 추가
(파일 상단에 이미 있는 `render`/`screen`/`vi`/`createChartEx`/`DEFAULT_BUNDLE`/
`wrapper`/`useLivePageStore`를 그대로 사용한다):

```tsx
// ---------------------------------------------------------------------------
// Wheel interactions wiring (spec 2026-06-07-live-wheel-interactions)
// ---------------------------------------------------------------------------

describe('LiveChartRoot wheel interactions wiring', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null });
    vi.mocked(createChartEx).mockClear();
  });

  it('disables the library wheel zoom via handleScale.mouseWheel: false', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    // createChartEx(el, behavior, options) — options는 3번째 인자.
    const options = vi.mocked(createChartEx).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(options).toMatchObject({ handleScale: { mouseWheel: false } });
  });

  it('container wheel → right-edge-anchored zoom via setVisibleLogicalRange', () => {
    // useWheelInteractions가 읽는 getVisibleLogicalRange / coordinateToLogical을
    // 갖춘 ts mock (기본 모듈 mock에는 둘 다 없다).
    const ts = {
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleRange: vi.fn(() => null),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
      getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 100 })),
      coordinateToLogical: vi.fn(() => null),
    };
    const chart = {
      addSeries: vi.fn(() => ({
        setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(),
        applyOptions: vi.fn(), priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ts),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    // containerRef div = live-chart-root의 첫 번째 자식 (chart 슬롯).
    const container = screen.getByTestId('live-chart-root').firstElementChild!;
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));

    // 마지막 호출이 휠 결과여야 한다 (초기 뷰 effect의 호출이 선행할 수 있음).
    const last = ts.setVisibleLogicalRange.mock.calls.at(-1)![0] as { from: number; to: number };
    expect(last.to).toBe(100);
    expect(last.from).toBeCloseTo(100 - 100 * Math.exp(0.1), 6); // ≈ -10.517
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `npx vitest run src/live/LiveChartRoot.test.tsx -t "wheel interactions wiring"`
Expected: FAIL — 옵션 테스트는 `handleScale` 부재로, dispatch 테스트는 `setVisibleLogicalRange` 미호출(휠 리스너 부재)로 실패. 기존 케이스는 영향 없음.

- [ ] **Step 3: `LiveChartRoot.tsx` 수정 (3줄)**

(1) import 추가 — 기존 `import { useViewportBackfill } from './useViewportBackfill';` 줄 바로 아래:

```ts
import { useWheelInteractions } from './useWheelInteractions';
```

(2) 훅 호출 추가 — 기존 `useViewportBackfill({ chart, axis, bundle, timeframe, isExtending, code: code ?? '' });` 줄 바로 아래:

```ts
// Modifier-aware 휠 줌/팬 — handleScale.mouseWheel: false(아래 createChartEx
// 옵션)와 한 쌍. 스펙: docs/superpowers/specs/2026-06-07-live-wheel-interactions-design.md
useWheelInteractions(chart, containerRef, bundle);
```

(3) `createChartEx` 옵션 추가 — `crosshair: CHART_CROSSHAIR_OPTIONS,` 줄 바로 아래:

```ts
// 라이브러리 내장 휠 줌(마우스 앵커) 비활성 — useWheelInteractions가 wheel을
// 단독 소유한다(이중 소유권 레이스 방지). handleScale의 나머지 sub-option
// (pinch, axisPressedMouseMove, axisDoubleClickReset)과 handleScroll(트랙패드
// deltaX 팬)은 기본값 유지.
handleScale: { mouseWheel: false },
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `npx vitest run src/live/LiveChartRoot.test.tsx`
Expected: PASS — 신규 2케이스 + 기존 케이스 전부 통과 (기존 케이스가 깨지면
휠 리스너가 mock에 없는 메서드를 mount 경로에서 호출한 것 — 훅은 wheel 이벤트
핸들러 안에서만 `getVisibleLogicalRange`를 호출해야 한다)

- [ ] **Step 5: Commit**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-wheel-interactions
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx
git commit -m "$(cat <<'EOF'
feat(live): LiveChartRoot 휠 배선 — 라이브러리 휠 줌 비활성 + useWheelInteractions 연결

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 전체 게이트 — 테스트 스위트 / 타입체크 / lint

**Files:** (변경 없음 — 검증만. 실패 시 고치고 해당 태스크 커밋에 fixup)

- [ ] **Step 1: 프론트엔드 전체 테스트**

Run: `npx vitest run`
Expected: PASS — 전체 스위트 통과 (e2e는 `vite.config.ts`의 exclude로 제외됨)

- [ ] **Step 2: 타입체크**

Run: `npx tsc -b`
Expected: 출력 없이 종료 코드 0

- [ ] **Step 3: lint (변경 파일 스코프)**

리포 전체에는 이번 작업과 무관한 기존 lint 에러가 다수 있으므로(Task 1+2 품질
리뷰에서 167건 확인) 게이트는 **이번 플랜이 만들거나 수정한 파일로 한정**한다:

Run: `npx eslint src/live/useWheelInteractions.ts src/live/useWheelInteractions.test.tsx src/live/LiveChartRoot.tsx src/live/LiveChartRoot.test.tsx`
Expected: 이 4개 파일에서 에러·경고 0 — 특히 `useWheelInteractions.ts`의 effect
deps에서 `react-hooks/exhaustive-deps` 경고가 없어야 한다 (deps
`[chart, containerRef]`가 이를 충족한다; `[chart]`만 쓰면 경고 발생).
단, `LiveChartRoot.tsx`에 이번 변경 **이전부터** 존재하던 에러는 게이트 실패로
보지 않는다 (기준: `git stash` 후 같은 명령으로 비교하거나, 에러 라인이 이번
diff 밖인지 확인).

- [ ] **Step 4: 게이트에서 수정이 나왔다면 커밋**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/live-wheel-interactions
git add -A
git commit -m "$(cat <<'EOF'
fix(live): 휠 배선 게이트 수정 (타입/lint)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

(수정이 없으면 이 스텝은 건너뛴다)

---

### Task 5: 브라우저 수동 검증 — `/browse` (스펙 Manual verification 7항목)

**Files:** (변경 없음 — 검증만)

전제: backend CORS는 `:5173` origin만 허용한다. worktree의 프론트 dev 서버를
**5173 포트에서** 띄워야 한다 (다른 프로세스가 5173을 점유 중이면 먼저 내린다).

- [ ] **Step 1: dev 서버 기동 (백그라운드)**

```bash
# backend (워크트리 루트에서)
cd /home/dev/code/hoga-ops/.claude/worktrees/live-wheel-interactions
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

```bash
# frontend (새 worktree 첫 실행이면 npm install 선행)
cd /home/dev/code/hoga-ops/.claude/worktrees/live-wheel-interactions/frontend
npm install   # node_modules 없을 때만
npm run dev   # http://localhost:5173
```

확인: `curl -s http://127.0.0.1:8000/api/events | head -c 100` 응답, Vite `ready in` 출력.

- [ ] **Step 2: /live 진입 + 종목 선택**

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B text          # 페이지 상태 확인 (KIS 자격증명 배너 여부 등)
$B snapshot -i   # 관심종목/검색에서 종목 하나 선택해 차트 로드
```

차트 로드 후 dev 핸들로 뷰포트를 수치로 읽을 수 있다:

```bash
$B js "JSON.stringify(window.__liveChart.timeScale().getVisibleLogicalRange())"
```

- [ ] **Step 3: 스펙 7항목 검증 (각 항목: 휠 전후 logical range를 수치 비교)**

휠 주입은 차트 컨테이너에 대한 합성 WheelEvent로 한다 (CDP 주입 동등 — 리스너는
isTrusted를 검사하지 않는다):

```bash
# 예: plain wheel 줌아웃 1틱 (컨테이너 = live-chart-root 첫 자식)
$B js "const el = document.querySelector('[data-testid=live-chart-root]').firstElementChild;
el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true }));
JSON.stringify(window.__liveChart.timeScale().getVisibleLogicalRange())"
```

검증 항목 (스펙 Manual verification — 통과 기준 포함):

1. **plain wheel**: 줌인/아웃 전후 `to` 불변, `from`만 변화. 과거로 스크롤한
   상태에서도 동일 (뷰가 "지금"으로 끌려가지 않음).
2. **ctrl+wheel**: `ctrlKey: true, clientX: <차트 중앙 x>`로 주입 — 줌 전후
   `coordinateToLogical(중앙 x)` 값이 (소수 오차 내) 불변.
3. **shift+wheel**: `shiftKey: true` — 전후 `to - from`(스팬) 불변. 오른쪽 연타
   시 `to`가 `마지막 캔들 인덱스`에서 멈춤(첫 틱에 우측 패딩 15칸 스냅 회수 포함).
   `$B js "document.scrollingElement.scrollLeft"` 가 0 유지(페이지 스크롤 없음).
4. **전 페인 동기**: 줌/팬 후 스크린샷(`$B screenshot`)에서 캔들·거래량·호가
   페인의 x축이 함께 움직였는지 확인.
5. **백필 연동**: 줌아웃/좌측 팬으로 `from < 0` 진입 → 네트워크 탭
   (`$B network`)에 과거 청크 fetch 발생 → 로드 후 보던 구간 유지(텔레포트 없음).
6. **타임프레임/종목 전환**: 전환 후 초기 뷰 정상 + 휠이 새 bundle 기준 동작.
7. **사이드바 영역**: 차트 밖(사이드바) 휠은 차트 뷰포트를 바꾸지 않는다
   (사이드바에 dispatch 후 logical range 불변 확인).

`$B console --errors`로 JS 에러 0 확인.

- [ ] **Step 4: 결과 기록**

7항목 결과를 작업 로그(대화)에 정리한다. 실패 항목은 스펙과 대조해 수정 후
해당 태스크부터 재실행.

---

## Post-plan amendments (2026-06-08 /ship 리뷰)

플랜 5태스크 실행 완료 후 /ship 적대 리뷰에서 확정된 추가 변경 2건 — 위
태스크들의 코드 블록은 실행 당시 기준이며, 최종 출하 코드는 다음이 더해진
상태다 (스펙 결정 사항 #8·#9 참조):

1. **deltaMode 정규화** (`useWheelInteractions.ts` onWheel): lwc가 하던
   LINE ×32 / PAGE ×120 환산을 훅에서 재현 — Firefox 휠 줌 ~35배 약화 회귀
   차단. 테스트 1케이스 추가 (`deltaMode=LINE` ×32 환산, 총 8케이스).
2. **onWheel try/catch 가드**: 레포의 lwc viewport 호출 컨벤션 정합
   (teardown 경합 — 현재 effect 순서상 도달 불가, 리팩토링 내성용).

## Self-Review 체크 (플랜 작성 시 수행 완료)

- 스펙 커버리지: 훅(Task 1-2), LiveChartRoot 2곳(Task 3), 기존 22케이스 무변경
  확인(Task 2 Step 3), 신규 7케이스(Task 1), 배선 회귀 2케이스(Task 3), 수동
  검증 7항목(Task 5) — 스펙 Testing 절과 1:1.
- 타입 일관성: `useWheelInteractions(chart: IChartApi | null, containerRef:
  RefObject<HTMLDivElement | null>, bundle: RangeBundle | null)` — Task 1 테스트
  Harness·Task 2 구현·Task 3 호출부 모두 동일 시그니처.
- 자리표시자 없음: 모든 코드 스텝에 전체 코드 포함.
