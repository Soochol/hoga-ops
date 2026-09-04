import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { useViewportBackfill } from './useViewportBackfill';
import { useLivePageStore } from '../state/livePage';
import { useWorkspaceStore, type GroupSymbol } from '../state/workspace';
import {
  WindowViewContext,
  type WindowViewValue,
} from './workspace/windowView';
import { createVirtualAxis } from '../util/virtualAxis';
import { livePerfLog } from '../util/perfDebug';
import type { RangeBundle } from '../api/types';

// 반려 사유를 값으로 읽기 위해 계측을 가로챈다. 실제 구현은 debug 플래그가 꺼져 있으면
// no-op 이라 **아무것도 관측되지 않는다** — 테스트에서 사유를 재려면 모킹이 유일한 길이다.
vi.mock('../util/perfDebug', () => ({
  livePerfLog: vi.fn(),
  livePerfDebugEnabled: () => false,
}));

// 09:00–15:30 KST 세션 한 개짜리 축 — segments.length>0 이라 3a/3b 가 조기 반환하지
// 않는다. sessionOpenMs 는 nextHistoricalFrom 의 axisEarliestMs 인자로만 쓰인다.
const KST = 9 * 60 * 60 * 1000;
function axisWithOneSession() {
  const open = Date.UTC(2026, 6, 9, 0, 0) - KST + 9 * 3600_000; // 2026-07-09 09:00 KST
  const close = open + 6.5 * 3600_000;
  return createVirtualAxis([{ date: '20260709', sessionOpenMs: open, sessionCloseMs: close }]);
}

// candleCountRef>0 이 되도록 캔들 1개만 있으면 충분(3a/3b 의 빈 차트 가드 통과).
function bundleWithCandles(code = '005930'): RangeBundle {
  return {
    code,
    from_date: '20260709',
    to_date: '20260709',
    bucket_ms: 60_000,
    segments: [{ date: '20260709', session_open_ms: 0, session_close_ms: 1, source: 'kiwoom_live' }],
    candles: [{ ts_ms: 1_000, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
  };
}

/** 3b lazy-fetch 핸들러를 캡처하는 timeScale mock. 모든 effect(1 스냅샷, 2 재배치,
 * 3a settle-loop, 3b trigger)가 호출하는 API를 no-op 으로 채운다. */
function chartWithCapturedHandler(logicalRange: { from: number; to: number } = { from: -5, to: 100 }) {
  let logicalHandler: ((range: unknown) => void) | null = null;
  const ts = {
    getVisibleLogicalRange: vi.fn(() => logicalRange),
    getVisibleRange: vi.fn(() => ({ from: 1, to: 2 })),
    timeToIndex: vi.fn(() => 0),
    setVisibleLogicalRange: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn((h: (range: unknown) => void) => {
      logicalHandler = h;
    }),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  };
  const chart = { timeScale: () => ts } as never;
  return { chart, ts, fire: (range: unknown) => logicalHandler?.(range) };
}

describe('useViewportBackfill — backpressure gate (3b)', () => {
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  it('does NOT dispatch a new step while a step is already in flight (10× zoom-out @500ms)', () => {
    // 이번 실사용 재현의 박제: 로딩(isExtending) 중 500ms 간격 줌아웃 연타는
    // 150ms 디바운스를 매번 통과하지만, 배압 게이트가 미결 스텝 위에 스텝을
    // 쌓지 못하게 막는다. 수정 전 코드였다면 10회 dispatch(딥 워크백 폭주).
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: true, // 스텝 진행 중
        code: '005930',
        canTriggerBackfill: () => true,
      }),
    );

    for (let i = 0; i < 10; i += 1) {
      cap.fire({ from: -5 - i, to: 100 });
      vi.advanceTimersByTime(500); // 디바운스(150ms) 초과 간격
    }
    vi.runOnlyPendingTimers();

    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('dispatches one step when idle (isExtending=false) — baseline preserved', () => {
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
      }),
    );

    cap.fire({ from: -5, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('발화 시점 뷰포트 재검증: 디바운스 사이에 from≥0 이벤트가 오면 반려한다', () => {
    // 트림(contraction) 커밋의 박제: lwc 내부 re-anchor 가 잠깐 from<0 을 보고해
    // 디바운스를 무장시키고, 같은 커밋의 리포지셔너 보정 set 이 from≥0 이벤트를
    // 낸다 — from≥0 이벤트는 타이머를 걷지 못하므로, 발화 시점 재검증이 없으면
    // 방금 버린 창을 재확장한다(2026-08-25 실측: contract ↔ extend 진동).
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
      }),
    );

    cap.fire({ from: -1180, to: 1 }); // lwc 과도 이벤트 — 타이머 무장
    cap.fire({ from: 1891, to: 3094 }); // 리포지셔너 보정 — 빈공간 없음
    vi.advanceTimersByTime(150);

    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('re-checks backpressure at debounce fire time (step starts during the 150ms wait)', () => {
    // idle 로 시작해 이벤트를 발화(타이머 무장)하고, 디바운스 만료 전에 스텝이
    // 시작(isExtending=true)되면 타이머 내부 재확인이 dispatch 를 막는다.
    const cap = chartWithCapturedHandler();
    const { rerender } = renderHook(
      ({ ext }: { ext: boolean }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '1m',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: () => true,
        }),
      { initialProps: { ext: false } },
    );

    cap.fire({ from: -5, to: 100 }); // 타이머 무장(idle 이라 진입 게이트 통과)
    rerender({ ext: true }); // 디바운스 대기 중 스텝 시작
    vi.advanceTimersByTime(150);

    expect(extendSpy).not.toHaveBeenCalled();
  });
});

// ── 3b **진입 배압** 반려의 말하는 횟수 ──────────────────────────────────────
// 이 게이트는 #1739 까지 완전 침묵이었다. 그 침묵이 잠김을 오래 숨겼다 — 좌팬이
// 죽었을 때 「바닥이라 안 온다」(`viewport_backfill_floor`) · 「고장나서 안 온다」 ·
// 「정상적으로 fill 이 진행 중이라 반려」 셋이 로그로 구별되지 않았다. 이 리포는
// 백필 계열을 **로그 유무·박자**로 가르므로 그 공백이 비쌌다(#1739 커밋 메시지가
// "그 자리에는 livePerfLog 가 없어 화면에도 로그에도 흔적이 0" 이라 적은 자리).
//
// ⚠ 그렇다고 무조건 찍으면 안 된다: 3b 는 **뷰포트 이벤트마다** 깨어난다(실드래그
// ~60 event/s). 매번 찍으면 반려가 초당 수십 줄이 되어 **정지 상태가 활동처럼
// 보인다** — #1680 이 3e 에서 다룬, 이 표면에서 가장 비싼 오독이다.
describe('useViewportBackfill — 진입 배압 반려는 에피소드당 한 줄 (3b)', () => {
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // 이력이 describe 를 건너 새는 것을 막는다 — 근거는 위 3b describe 의 주석.
    extendSpy.mockClear();
    vi.mocked(livePerfLog).mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  function busyLogs(): Array<Record<string, unknown>> {
    return vi.mocked(livePerfLog).mock.calls
      .filter(([event]) => event === 'viewport_backfill_busy')
      .map(([, payload]) => payload);
  }

  it('스텝 진행 중(isExtending)의 연타 팬은 한 줄로 끝난다', () => {
    const cap = chartWithCapturedHandler();
    const axis = axisWithOneSession();
    const bundle = bundleWithCandles();
    const canTrigger = () => true;
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis,
        bundle,
        timeframe: '1m',
        isExtending: true, // 스텝 진행 중 = 진입 게이트가 반려한다
        code: '005930',
        canTriggerBackfill: canTrigger,
      }),
    );

    for (let i = 0; i < 10; i += 1) {
      cap.fire({ from: -5 - i, to: 100 });
      vi.advanceTimersByTime(500);
    }
    vi.runOnlyPendingTimers();

    expect(extendSpy).not.toHaveBeenCalled();
    expect(busyLogs()).toHaveLength(1);
    expect(busyLogs()[0]).toMatchObject({ fillKind: null, isExtending: true, from: '20260601' });
  });

  it('활성 fill(fillKind) 이 잠긴 좌팬도 말한다 — 이것이 #1739 가 숨어 있던 축이다', () => {
    // extend 가 모킹돼 창이 움직이지 않으므로 3a 의 두 settle 신호가 다 죽는다 =
    // `fillKind` 가 물린 채 남는다. 실사용에서 잠김이 만들어지는 모양 그대로다.
    const cap = chartWithCapturedHandler();
    const axis = axisWithOneSession();
    const bundle = bundleWithCandles();
    const canTrigger = () => true;
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis,
        bundle,
        timeframe: '1m',
        isExtending: false, // 첫 팬은 게이트를 통과한다
        code: '005930',
        canTriggerBackfill: canTrigger,
      }),
    );

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1); // fillKind='left_pan' 이 섰다
    expect(busyLogs()).toHaveLength(0); // 통과한 이벤트는 말하지 않는다

    // 이제부터 모든 좌팬이 배압에 반려된다 — 종전에는 여기가 완전 침묵이었다.
    for (let i = 0; i < 5; i += 1) {
      cap.fire({ from: -400 - i, to: 100 });
      vi.advanceTimersByTime(200);
    }

    expect(extendSpy).toHaveBeenCalledTimes(1);
    expect(busyLogs()).toHaveLength(1);
    expect(busyLogs()[0]).toMatchObject({ fillKind: 'left_pan', from: '20260601' });
  });

  it('창이 움직이면 다시 말한다 — 침묵은 그 `fillKind|창` 쌍에만 매인다', () => {
    // 건강한 워크백은 스텝마다 창이 앞으로 간다. 그때 새 줄이 나오는 것이 곧
    // 「진행 중」과 「잠김」의 판별식이다: 창이 얼어붙은 채 한 줄이면 잠김이다.
    const cap = chartWithCapturedHandler();
    const axis = axisWithOneSession();
    const bundle = bundleWithCandles();
    const canTrigger = () => true;
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis,
        bundle,
        timeframe: '1m',
        isExtending: true,
        code: '005930',
        canTriggerBackfill: canTrigger,
      }),
    );

    cap.fire({ from: -300, to: 100 });
    expect(busyLogs()).toHaveLength(1);

    // 진행 중인 fill 이 한 스텝 나아갔다(스토어는 imperative 스냅샷으로 읽히므로
    // 리렌더 없이도 게이트가 새 값을 본다).
    useLivePageStore.setState({ historicalFromDate: '20260501' });
    cap.fire({ from: -300, to: 100 });

    expect(busyLogs()).toHaveLength(2);
    expect(busyLogs()[1]).toMatchObject({ from: '20260501' });
  });

  it('반려 래치는 배압이 풀린 뒤의 팬을 막지 않는다 (정지 판정이 아니다)', () => {
    // 래치를 반려 판정 **바깥**에 두면 로그 중복 제거가 아니라 **두 번째 정지 판정**이
    // 되어, 배압이 풀려도 좌팬이 영영 안 선다 — #1662·#1680 이 경고한 그 모양이다.
    const cap = chartWithCapturedHandler();
    const axis = axisWithOneSession();
    const bundle = bundleWithCandles();
    const canTrigger = () => true;
    const { rerender } = renderHook(
      ({ ext }: { ext: boolean }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis,
          bundle,
          timeframe: '1m',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: canTrigger,
        }),
      { initialProps: { ext: true } },
    );

    cap.fire({ from: -300, to: 100 });
    expect(busyLogs()).toHaveLength(1);
    expect(extendSpy).not.toHaveBeenCalled();

    rerender({ ext: false }); // 스텝이 끝났다 = 배압 해제
    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useViewportBackfill — 좌측 바닥 도달 (3b/3e 가 fill 을 세우지 않는다)', () => {
  // 바닥 아래에서는 `historicalFromDate` 를 낮춰도 요청이 클램프돼 **fetch 가 없다**.
  // fetch 가 없으면 3a 의 두 settle 신호가 둘 다 죽어 `endFill()` 에 닿지 못하고
  // `fillKind` 가 영구 non-null 이 된다 → 이후 모든 좌팬이 백프레셔에 **무로그** 반려.
  // 2026-08-30 실측(005930 60분봉 벤더): `clamp_recovery` extend 뒤 `stop` 이 영영
  // 오지 않았고, `logicalFrom=-783` 좌팬에도 로그 0줄이었다.
  //
  // **판별식은 "두 번째 팬이 되는가" 다.** 첫 팬이 반려되는 것만 보면 「바닥이라 안 함」
  // 과 「잠겨서 안 함」이 구별되지 않는다 — 바닥을 치운 뒤 다시 팬해서 살아 있음을 본다.
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  it('3b: 바닥에 닿은 창에는 세우지 않고, 바닥이 풀리면 곧바로 다시 팬된다', () => {
    const cap = chartWithCapturedHandler();
    // axis·bundle·콜백을 렌더 밖으로 올려 3b 가 **재구독하지 않게** 한다 — 그래야
    // 핸들러가 바닥을 클로저가 아니라 미러(ref)로 읽는지까지 함께 재진다.
    const axis = axisWithOneSession();
    const bundle = bundleWithCandles();
    const canTrigger = () => true;
    const { rerender } = renderHook(
      ({ floor }: { floor: string | null }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis,
          bundle,
          timeframe: '1m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: canTrigger,
          minuteScrollbackFloorDate: floor,
        }),
      // 창(20260601)이 바닥과 같다 = 더 내려가도 서빙 창이 안 바뀐다.
      { initialProps: { floor: '20260601' as string | null } },
    );

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).not.toHaveBeenCalled();

    // 바닥이 사라진다(예: 디스크 소스로 전환 — 벤더 250일 벽이 없다).
    // fill 이 잠겨 있었다면 여기서도 침묵한다.
    rerender({ floor: null });
    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('3b: 바닥보다 위면 종전대로 세운다 — 마지막 한 스텝이 바닥을 넘어가는 것은 막지 않는다', () => {
    // 창이 바닥보다 **위**면 그 확장은 요청을 실제로 바꾼다(cur → 바닥). 그 스텝은
    // 정상 fetch·settle 로 끝나고 3a 의 `planFillStep` 이 stop 을 낸다. 여기서 막으면
    // 마지막 구간을 못 받는다.
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        minuteScrollbackFloorDate: '20260501', // 창(20260601)보다 과거 = 아직 여유 있음
      }),
    );

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('3b: 바닥 미상(null)이면 아무것도 막지 않는다 — D/W/M·응답 전 디스크 모드', () => {
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        // minuteScrollbackFloorDate 미지정 = null
      }),
    );

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('3e: 빈 화면 클램프 복구도 바닥에서는 세우지 않는다(실측에서 잠김을 만든 경로)', () => {
    // 빈 화면 판정은 바닥에서도 참이라 3e 가 계속 깨어난다 — 그 확장이 no-op 이므로
    // 첫 발화가 곧바로 fillKind 를 물고 앉았다.
    // 화면 폭의 10% 이하만 데이터: span 101, 덮인 폭 1.
    const cap = chartWithCapturedHandler({ from: -100, to: 1 });
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        minuteScrollbackFloorDate: '20260601', // 창과 같다 = 바닥
      }),
    );

    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('3e: 바닥이 아니면 종전대로 클램프 복구가 발화한다', () => {
    const cap = chartWithCapturedHandler({ from: -100, to: 1 });
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        minuteScrollbackFloorDate: '20260501',
      }),
    );

    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  // ── 3e 바닥 반려의 **말하는 횟수** ────────────────────────────────────────
  // 3e 는 `bundle`·`axis` 를 deps 로 갖는 effect 라 데이터 커밋마다 깨어난다. 바닥에
  // 앉아 있으면 매 커밋이 같은 반려에 도달하는데, 그 분기는 dispatch 가 아니라서
  // 스텝 카운터(상한 3)도 창-동일 래치도 건드리지 않는다 → 같은 줄이 무한히 찍힌다.
  // 2026-08-31 실측(035420 60m 바닥): 4초에 12줄, 약 200ms 간격.
  function floorLogCount(): number {
    return vi.mocked(livePerfLog).mock.calls
      .filter(([event]) => event === 'viewport_backfill_floor').length;
  }

  it('3e: 바닥 반려는 커밋이 반복돼도 한 번만 말한다', () => {
    vi.mocked(livePerfLog).mockClear();
    const cap = chartWithCapturedHandler({ from: -100, to: 1 });
    // axis·콜백을 렌더 밖으로 올려 **bundle 정체성만** 바뀌게 한다 — 그러지 않으면
    // 매 렌더가 모든 deps 를 갈아 "커밋마다 깨어난다" 를 재는 것이 아니게 된다.
    const axis = axisWithOneSession();
    const canTrigger = () => true;
    const { rerender } = renderHook(
      ({ bundle }: { bundle: RangeBundle }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis,
          bundle,
          timeframe: '1m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: canTrigger,
          minuteScrollbackFloorDate: '20260601', // 창(20260601)과 같다 = 바닥
        }),
      { initialProps: { bundle: bundleWithCandles() } },
    );

    expect(floorLogCount()).toBe(1);
    // 데이터 커밋 4회 — 창도 바닥도 그대로다. 새 사실이 없으므로 새 줄도 없다.
    for (let i = 0; i < 4; i++) rerender({ bundle: bundleWithCandles() });
    expect(floorLogCount()).toBe(1);
  });

  it('3e: 바닥이 움직이면 다시 말한다 — 침묵은 그 상태에만 매인다', () => {
    // ⚠ 바닥은 3e 의 deps 가 아니라 **ref 미러**로 읽힌다 — 그 값만 바꿔서는 이
    // effect 가 깨어나지 않는다. 실제로 바닥을 움직이는 사건(hogaplay 소스 토글)은
    // 캔들 소스를 갈아 `bundle` 을 함께 바꾸므로, 프로덕션에서는 둘이 같이 온다.
    // 테스트도 그 쌍으로 민다 — 바닥만 흔드는 것은 존재하지 않는 사건이다.
    vi.mocked(livePerfLog).mockClear();
    const cap = chartWithCapturedHandler({ from: -100, to: 1 });
    const axis = axisWithOneSession();
    const canTrigger = () => true;
    const { rerender } = renderHook(
      ({ floor, bundle }: { floor: string; bundle: RangeBundle }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis,
          bundle,
          timeframe: '1m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: canTrigger,
          minuteScrollbackFloorDate: floor,
        }),
      { initialProps: { floor: '20260601', bundle: bundleWithCandles() } },
    );

    expect(floorLogCount()).toBe(1);
    // 바닥이 더 뒤로 물러났다(여전히 창 위 = 계속 반려). 상태가 달라졌으니 다시 말한다.
    rerender({ floor: '20260701', bundle: bundleWithCandles() });
    expect(floorLogCount()).toBe(2);
  });

  it('3e: 반려 래치는 바닥이 풀린 뒤의 탈출을 막지 않는다 (정지 판정이 아니다)', () => {
    // 이 래치를 바닥 술어 **바깥**에 두면 로그 중복 제거가 아니라 두 번째 정지
    // 판정이 되어, 바닥이 사라져도 3e 가 영영 안 선다 — #1662 가 경고한 그 모양이다.
    const cap = chartWithCapturedHandler({ from: -100, to: 1 });
    const axis = axisWithOneSession();
    const canTrigger = () => true;
    const { rerender } = renderHook(
      ({ floor, bundle }: { floor: string | null; bundle: RangeBundle }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis,
          bundle,
          timeframe: '1m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: canTrigger,
          minuteScrollbackFloorDate: floor,
        }),
      { initialProps: { floor: '20260601' as string | null, bundle: bundleWithCandles() } },
    );

    expect(extendSpy).not.toHaveBeenCalled(); // 바닥 — 반려 래치가 걸린 상태
    // 디스크 소스로 전환 = 좌측 바닥 없음. 소스가 갈리면 캔들도 갈리므로 bundle 도 새것.
    rerender({ floor: null, bundle: bundleWithCandles() });
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useViewportBackfill — 스텝 착지점을 바닥 위로 자른다 (#1662 의 짝)', () => {
  // 위 describe 의 게이트는 **창**을 본다("이미 바닥이면 세우지 않는다"). 그것만으로는
  // 잠김이 남는다 — 창이 바닥 **위**여도 한 스텝이 바닥을 지나칠 수 있고, 그 아래는
  // 요청이 서빙 단계에서 클램프돼(`minutePastFrom`) 서빙 창이 요청과 갈린다. 그러면
  // 3a 의 캐시 settle(`settledFromDate === cur`)이 원리적으로 성립하지 못하고, 같은
  // 바닥 창이 이미 캐시에 있으면 fetch 도 안 나 하강 엣지까지 없다 → `fillKind` 영구 잠금.
  //
  // 2026-08-31 브라우저 실측(035420, 사용자 dev 백엔드, 벤더 모드, floor=20251225):
  //   extend {trigger: clamp_recovery, from: 20260126, nextFrom: 20250530}
  //   stop 없음 · past-candles 요청 0건 → 이후 좌팬 3회에 viewport_backfill_* 0줄
  // 지나치는 것은 예외가 아니라 넓은 분봉의 정상이다 — 60m 스텝(300거래일 ≈ 420캘린더일)
  // 이 250일 벽보다 넓다.
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      // 3b 의 디바운스는 발화 시점에 `viewGuard` 로 봉을 재확인한다 — 스토어 봉이
      // 인자와 다르면 dispatch 전에 반려돼 이 테스트가 아무것도 재지 못한다.
      candleTimeframe: '60m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  /** 스텝 폭이 벽보다 넓은 조합. 창(20260601)은 바닥(20260501) 위라 게이트는 통과한다. */
  const FLOOR = '20260501';

  it('3b(left_pan): 바닥을 지나치는 스텝은 **바닥에 정확히** 앉는다', () => {
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '60m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        minuteScrollbackFloorDate: FLOOR,
      }),
    );

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledWith(FLOOR);
  });

  it('3e(clamp_recovery): 같은 클램프 — 실측에서 잠김을 만든 로그가 이 경로였다', () => {
    // 화면 폭의 10% 이하만 데이터 = 3e 발화 조건(span 101, 덮인 폭 1).
    const cap = chartWithCapturedHandler({ from: -100, to: 1 });
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '60m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        minuteScrollbackFloorDate: FLOOR,
      }),
    );

    expect(extendSpy).toHaveBeenCalledWith(FLOOR);
  });

  it('3c(initial_coverage): 게이트가 아예 없는 경로라 클램프가 유일한 방어다', () => {
    // 3b·3e 와 달리 3c 에는 `canAdvanceHistoricalWindow` 게이트가 없다(#1662 가 coverage
    // 계열을 의도적으로 비켜 갔다). 그래서 초기 표시 판정 **한 번**으로 창이 벽 아래로
    // 내려갈 수 있었다 — 브라우저 실측의 60m 마운트가 정확히 그 자리였다
    // (`extend {trigger: initial_coverage, from: null, nextFrom: 20250630}`, floor 20251225).
    renderHook(() =>
      useViewportBackfill({
        chart: chartWithCapturedHandler().chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '60m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        indicatorCoverageFromDate: '20260715', // viewport('20260709')보다 최근 → 갭
        rangeWindowFromDate: '20260601',
        minuteScrollbackFloorDate: FLOOR,
      }),
    );

    expect(extendSpy).toHaveBeenCalledWith(FLOOR);
  });

  it('바닥을 **모르면** 자르지 않는다 (D/W/M · 디스크 응답 전)', () => {
    // 모르는 것을 바닥이라고 말하지 않는 규율 — `canAdvanceHistoricalWindow` 와 같다.
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '60m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        // minuteScrollbackFloorDate 미지정 = null
      }),
    );

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
    expect(String(extendSpy.mock.calls[0][0]) < FLOOR).toBe(true);
  });

  it('스텝이 바닥에 못 미치면 값이 **비트 단위로** 그대로다', () => {
    // 클램프가 정상 워크백의 보폭을 건드리지 않는다는 것을, 기대값을 손으로 적는
    // 대신 **바닥 없는 같은 실행과 대조**해서 증명한다(커널 재구현이 아니다).
    function dispatchedWith(floor: string | null): unknown {
      extendSpy.mockClear();
      const cap = chartWithCapturedHandler();
      const { unmount } = renderHook(() =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '60m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: () => true,
          minuteScrollbackFloorDate: floor,
        }),
      );
      cap.fire({ from: -300, to: 100 });
      vi.advanceTimersByTime(150);
      const arg = extendSpy.mock.calls[0]?.[0];
      unmount();
      return arg;
    }

    const noFloor = dispatchedWith(null);
    const deepFloor = dispatchedWith('20200101'); // 스텝이 절대 못 닿는 바닥
    expect(deepFloor).toBe(noFloor);
  });

  // ── 3c 는 클램프만으로 부족하다 — 게이트도 물어야 한다 ────────────────────────
  // 클램프는 착지점을 바닥에 앉히는데, 창이 **이미 바닥**이면 그 착지점이 창과 같아진다
  // → `extendHistoricalRange` 의 단조 감소 가드가 dispatch 를 통째로 삼킨다(no-op).
  // 그런데 3c 는 그 전에 이미 `fillKind` 를 세운 뒤다 → 쿼리 키 불변 = fetch 0 →
  // 하강 엣지 없음. 남는 탈출구는 3a 의 캐시 settle 뿐인데, **3c 가 발화하는 조건 자체가
  // 지표 커버리지가 뒤처졌다는 것**이라 `settledFromDate`(= 뒤처진 지표 날짜)가 `cur`
  // (= 바닥)과 갈린다 → 그 신호도 죽는다. 즉 3c 는 클램프 뒤에도 잠길 수 있다.
  function floorLogsFor(trigger: string): string[] {
    return vi.mocked(livePerfLog).mock.calls
      .filter(([event]) => event === 'viewport_backfill_floor')
      .map(([, payload]) => String((payload as { d?: unknown }).d ?? ''))
      .filter((d) => d.includes(`trigger=${trigger}`));
  }

  function renderInitialCoverage(floor: string | null, chart: ReturnType<typeof chartWithCapturedHandler>) {
    return renderHook(() =>
      useViewportBackfill({
        chart: chart.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '60m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        indicatorCoverageFromDate: '20260715', // viewport('20260709')보다 최근 → 갭
        rangeWindowFromDate: '20260601',
        minuteScrollbackFloorDate: floor,
      }),
    );
  }

  it('3c: 바닥에 앉은 창에는 fill 을 세우지 않는다 — 반려를 말한다', () => {
    vi.mocked(livePerfLog).mockClear();
    // 창(스토어 20260601)과 바닥이 같다 = 이미 바닥.
    renderInitialCoverage('20260601', chartWithCapturedHandler());

    expect(extendSpy).not.toHaveBeenCalled();
    expect(floorLogsFor('initial_coverage')).toHaveLength(1);
  });

  it('3c: 그 반려가 **잠금이 아니다** — 다음 좌팬이 여전히 판정에 도달한다', () => {
    // 2단계 red-check(이 표면의 규율): 첫 단언만으로는 "바닥이라 안 함"과 "잠겨서 안 함"
    // 이 구별되지 않는다. 3b 의 백프레셔 게이트는 로그 **앞**이라, fill 이 서 있으면
    // 이후 좌팬은 한 줄도 남기지 못한다. 반려 뒤에도 로그가 나오는 것이 곧 미잠금이다.
    vi.mocked(livePerfLog).mockClear();
    const cap = chartWithCapturedHandler();
    renderInitialCoverage('20260601', cap);
    expect(floorLogsFor('left_pan')).toHaveLength(0);

    cap.fire({ from: -300, to: 100 });
    vi.advanceTimersByTime(150);
    expect(floorLogsFor('left_pan')).toHaveLength(1);
  });

  it('3c: 바닥이 아니면 종전대로 발화한다 — 게이트가 정상 경로를 먹지 않는다', () => {
    renderInitialCoverage('20260501', chartWithCapturedHandler());
    expect(extendSpy).toHaveBeenCalledWith('20260501');
  });
});

describe('useViewportBackfill — 소스 토글 창 축소 (1b)', () => {
  // 토글은 캔들 소스 축만 갈리는 재키인데, 창(historicalFromDate)을 그대로 두면
  // 이전 소스가 벌어놓은 깊은 창을 새 소스가 콜드로 전량 재취득한다(2026-08-25
  // 실측 55거래일 = 타일 11개 × 모드 직렬 = 수십 초). 소스 축이 갈리는 커밋에서
  // 창을 뷰포트 기준(planSourceSwapContraction)으로 당기고, 깊이는 이후 좌측
  // 팬(3b)이 지연 로딩으로 번다.
  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '5m',
      historicalFromDate: '20260601',
    });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function renderWithSource(initialSrc: string) {
    const cap = chartWithCapturedHandler();
    return renderHook(
      ({ src }: { src: string }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '5m',
          isExtending: false,
          code: '005930',
          candleSourceKey: src,
          canTriggerBackfill: () => true,
        }),
      { initialProps: { src: initialSrc } },
    );
  }

  it('소스 축이 갈리면 창을 뷰포트 좌단 - 5거래일로 당긴다', () => {
    const { rerender } = renderWithSource('vendor');
    // 마운트 첫 관측은 축이 갈린 것이 아니다 — 당기지 않는다.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260601');

    rerender({ src: 'disk' });
    // axis 세션 = 20260709(목) → 뷰포트 좌단 '20260709' → 5거래일 과거 = '20260702'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260702');
  });

  it('창이 없으면(초기 시드) 아무것도 하지 않는다', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { rerender } = renderWithSource('vendor');
    rerender({ src: 'disk' });
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('같은 축 값의 재실행(dep churn)은 당기지 않는다', () => {
    const { rerender } = renderWithSource('disk');
    rerender({ src: 'disk' });
    rerender({ src: 'disk' });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260601');
  });
});

describe('useViewportBackfill — settle-loop continuity (3a) is unaffected by the gate', () => {
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // 'D' 프레임: 3a 의 earliestAllowedDate 가 null 이라 minute 클램프 가드에
    // 의존하지 않는다(분봉/캘린더 공통 경로).
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: 'D',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  it('runs the frozen gesture budget to completion, then stops (viewport 재측정 없음)', () => {
    // 제스처 예산 모델: 트리거 순간의 빈공간(-60바, D=스텝당 50봉 → 예산 2)으로
    // fill이 동결되고, falling edge마다 예산을 소진하며 진행한다. 예산이 다하면
    // 뷰포트에 빈공간이 남아 있어도(mock getVisibleLogicalRange from=-5) 멈춘다 —
    // fill 도중 뷰포트를 다시 측정하지 않는다는 계약의 박제.
    const cap = chartWithCapturedHandler();
    const { rerender } = renderHook(
      ({ ext }: { ext: boolean }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: 'D',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: () => true,
        }),
      { initialProps: { ext: false } },
    );

    // 트리거: 빈공간 60바 → 예산 ceil(60/50)=2, 스텝 1 dispatch.
    cap.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);

    rerender({ ext: true }); // 스텝 1 진행
    rerender({ ext: false }); // settle → 하강 엣지 → 스텝 2 (예산 소진)
    expect(extendSpy).toHaveBeenCalledTimes(2);

    rerender({ ext: true }); // 스텝 2 진행
    rerender({ ext: false }); // settle → 예산 0 → stop (빈공간 남아도 무시)
    expect(extendSpy).toHaveBeenCalledTimes(2);
  });

  it('mid-fill trigger events cannot extend the frozen budget', () => {
    // fill 활성 중(예산 소진 전) 새 뷰포트 이벤트가 와도 예산이 덮어써지지
    // 않는다 — "첫 동작의 필요량을 다 가져올 때까지 추가 인터랙션의 호출 차단".
    const cap = chartWithCapturedHandler();
    const { rerender } = renderHook(
      ({ ext }: { ext: boolean }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: 'D',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: () => true,
        }),
      { initialProps: { ext: false } },
    );

    cap.fire({ from: -60, to: 100 }); // 예산 2로 동결
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);

    rerender({ ext: true });
    // fill 도중 훨씬 큰 빈공간 이벤트(-500) 연타 — 전부 무시되어야 한다.
    for (let i = 0; i < 5; i += 1) {
      cap.fire({ from: -500, to: 100 });
      vi.advanceTimersByTime(200);
    }
    rerender({ ext: false }); // 스텝 2 (동결 예산의 마지막)
    expect(extendSpy).toHaveBeenCalledTimes(2);

    rerender({ ext: true });
    rerender({ ext: false }); // 예산 소진 → stop. -500 이벤트가 연장 못함
    expect(extendSpy).toHaveBeenCalledTimes(2);
  });
});

describe('useViewportBackfill — coverage-gap trigger (3b, A안)', () => {
  // 이 현상의 박제: 탭 전환 후 캔들은 병합 캐시로 몇 달치 복원되는데 range 지표는
  // 5거래일 창만 커버해, viewport 좌단(readViewportLeftDate)이 지표 커버리지 밖이면
  // whitespace(logical.from<0)가 없어도 range 창을 확장해야 한다. mock 의
  // getVisibleRange().from=1 → axisWithOneSession 기준 viewportLeftDate='20260709'.
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  function renderCoverage(props: {
    indicatorCoverageFromDate?: string | null;
    rangeWindowFromDate?: string | null;
    isExtending?: boolean;
  }) {
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: props.isExtending ?? false,
        code: '005930',
        canTriggerBackfill: () => true,
        indicatorCoverageFromDate: props.indicatorCoverageFromDate,
        rangeWindowFromDate: props.rangeWindowFromDate,
      }),
    );
    return cap;
  }

  it('extends the range window when viewport left is older than indicator coverage (no whitespace)', () => {
    // 회귀 가드: logical.from>=0 라 기존(whitespace-only) 코드였다면 즉시 return →
    // dispatch 0. coverage 술어가 있어야 발화한다.
    const cap = renderCoverage({
      indicatorCoverageFromDate: '20260715', // viewport('20260709')보다 최근 → 갭
      rangeWindowFromDate: '20260601',
    });

    cap.fire({ from: 5, to: 100 }); // whitespace 없음(from>=0)
    vi.advanceTimersByTime(150);

    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT extend when indicator coverage already reaches the viewport left edge', () => {
    const cap = renderCoverage({
      indicatorCoverageFromDate: '20260601', // viewport('20260709')보다 과거 → 갭 없음
      rangeWindowFromDate: '20260601',
    });

    cap.fire({ from: 5, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('is inert when coverage props are absent (D/W/M or index — backward compat)', () => {
    const cap = renderCoverage({}); // coverage/window 미전달 → null

    cap.fire({ from: 5, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).not.toHaveBeenCalled();
  });

  // ── 바닥에 앉은 창의 coverage 분기 ────────────────────────────────────────────
  // 종전 주석은 "바닥에서는 커버리지도 함께 바닥에 서 있어 갭 조건이 성립하지 않는다"
  // 며 이 분기에 술어를 생략했다. 2026-08-31 실측이 그 전제를 뒤집었다 — 창이 바닥
  // (20251225)에 앉은 채 갭이 서서 `extend {coverage_gap, from: 20251225,
  // next: 20251225}` 라는 no-op dispatch 가 나갔다.
  function coverageFloorLogs(): string[] {
    return vi.mocked(livePerfLog).mock.calls
      .filter(([event]) => event === 'viewport_backfill_floor')
      .map(([, payload]) => String((payload as { d?: unknown }).d ?? ''))
      .filter((d) => d.includes('trigger=coverage_gap'));
  }

  function renderCoverageAtFloor(floor: string | null) {
    const cap = chartWithCapturedHandler();
    renderHook(() =>
      useViewportBackfill({
        chart: cap.chart,
        axis: axisWithOneSession(),
        bundle: bundleWithCandles(),
        timeframe: '1m',
        isExtending: false,
        code: '005930',
        canTriggerBackfill: () => true,
        indicatorCoverageFromDate: '20260715', // viewport('20260709')보다 최근 → 갭 있음
        rangeWindowFromDate: '20260601',
        minuteScrollbackFloorDate: floor,
      }),
    );
    return cap;
  }

  it('바닥에 앉은 창에는 coverage fill 도 세우지 않는다 — 반려를 말한다', () => {
    vi.mocked(livePerfLog).mockClear();
    const cap = renderCoverageAtFloor('20260601'); // 창(20260601)과 같다 = 바닥

    cap.fire({ from: 5, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).not.toHaveBeenCalled();
    expect(coverageFloorLogs()).toHaveLength(1);
  });

  it('⚠ 반려해도 **축소는 살아 있다** — 조기 반환이면 여기서 스스로 빠져나올 길이 닫힌다', () => {
    // 이 표면의 급소. 확장·축소가 같은 이벤트 핸들러를 공유하므로, 바닥 반려를
    // `return` 으로 처리하면 잠긴 창을 되감는 유일한 경로까지 함께 죽는다.
    // 바닥에 앉은 창이야말로 되감을 여지가 가장 큰 상태다.
    const contractSpy = vi
      .spyOn(useLivePageStore.getState(), 'contractHistoricalRange')
      .mockImplementation(() => {});
    try {
      const cap = renderCoverageAtFloor('20260601');
      cap.fire({ from: 5, to: 100 });
      vi.advanceTimersByTime(150);

      // 창(20260601)이 뷰포트 좌단(20260709)보다 3스텝 넘게 과거 → 히스테리시스 발동.
      // 리테인 1스텝 = 20260709 의 5거래일 전 = 20260702.
      expect(contractSpy).toHaveBeenCalledWith('20260702');
    } finally {
      contractSpy.mockRestore();
    }
  });

  it('반려는 **에피소드당 한 줄** — 3b 는 이벤트마다 깨어난다(#1680 과 같은 규율)', () => {
    vi.mocked(livePerfLog).mockClear();
    // 축소를 no-op 으로 묶어 **창을 고정**한다 — 안 그러면 첫 이벤트의 축소가 창을
    // 바닥 밖으로 빼내 두 번째 이벤트부터는 반려 자체가 사라진다(그 탈출은 아래
    // 별도 테스트가 잰다). 여기서 재려는 것은 "같은 `창|바닥` 에서 몇 줄인가" 다.
    const contractSpy = vi
      .spyOn(useLivePageStore.getState(), 'contractHistoricalRange')
      .mockImplementation(() => {});
    try {
      const cap = renderCoverageAtFloor('20260601');
      // 실제 드래그는 초당 수십 이벤트다. 창도 바닥도 그대로면 새 사실이 없다.
      for (let i = 0; i < 8; i += 1) {
        cap.fire({ from: 5 + i, to: 100 + i });
        vi.advanceTimersByTime(150);
      }

      expect(coverageFloorLogs()).toHaveLength(1);
      expect(extendSpy).not.toHaveBeenCalled();
    } finally {
      contractSpy.mockRestore();
    }
  });

  it('반려 → 축소 → 정상 확장으로 **스스로 빠져나온다** (막다른 길이 아니다)', () => {
    // 위 두 테스트를 잇는 종단 단언. 이것이 초록이어야 "바닥 반려" 가 정지가 아니라
    // **경유지**임이 증명된다 — 축소가 창을 바닥 밖으로 빼내면 같은 핸들러가 다음
    // 이벤트에서 종전대로 확장한다. (이 동작은 축소를 스텁하지 않은 실제 스토어로
    // 잰다 — 첫 발견이 「스텁 없는 반복 이벤트 테스트」의 실패였다.)
    vi.mocked(livePerfLog).mockClear();
    const cap = renderCoverageAtFloor('20260601');

    cap.fire({ from: 5, to: 100 });
    vi.advanceTimersByTime(150);
    expect(coverageFloorLogs()).toHaveLength(1);
    expect(extendSpy).not.toHaveBeenCalled();
    // 축소가 창을 뷰포트 기준으로 당겼다 = 더 이상 바닥이 아니다.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260702');

    cap.fire({ from: 6, to: 101 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('바닥이 아니면 종전대로 확장한다 — 게이트가 정상 경로를 먹지 않는다', () => {
    const cap = renderCoverageAtFloor('20260501'); // 창(20260601)보다 과거 = 여유 있음

    cap.fire({ from: 5, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('respects backpressure: no coverage step while a step is already in flight', () => {
    const cap = renderCoverage({
      indicatorCoverageFromDate: '20260715',
      rangeWindowFromDate: '20260601',
      isExtending: true, // 스텝 진행 중
    });

    cap.fire({ from: 5, to: 100 });
    vi.advanceTimersByTime(150);

    expect(extendSpy).not.toHaveBeenCalled();
  });
});

describe('useViewportBackfill — initial-display coverage trigger (3c, PR-3)', () => {
  // 3b(coverage-gap)는 뷰포트 이벤트에만 발화하므로 저장 뷰포트가 처음부터 지표
  // 커버리지 밖이면 사용자 무조작 시 지표가 빈 채 방치됐다. 3c는 최초 캔들+지표 신호
  // 준비 커밋에서 이벤트 없이 1회 판정한다. mock getVisibleRange().from=1 →
  // viewportLeftDate='20260709'.
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  type Props = {
    bundle?: RangeBundle | null;
    indicatorCoverageFromDate?: string | null;
    rangeWindowFromDate?: string | null;
    canTrigger?: boolean;
  };
  function renderInitial(initialProps: Props) {
    // 차트 참조는 **렌더를 건너 안정적이다** — 프로덕션의 `LiveChartRoot` 에서 chart 는
    // state(`chartEntry`)에 담긴 인스턴스라 viewKey remount 때만 갈린다. 렌더마다 새로
    // 만들면 뷰 경계가 매 커밋 서는 것으로 읽혀 fill 수명 계약이 테스트에서만 달라진다.
    const { chart } = chartWithCapturedHandler();
    return renderHook(
      (p: Props) =>
        useViewportBackfill({
          chart,
          axis: axisWithOneSession(),
          bundle: p.bundle === undefined ? bundleWithCandles() : p.bundle,
          timeframe: '1m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: () => p.canTrigger ?? true,
          indicatorCoverageFromDate: p.indicatorCoverageFromDate === undefined ? '20260715' : p.indicatorCoverageFromDate,
          rangeWindowFromDate: p.rangeWindowFromDate === undefined ? '20260601' : p.rangeWindowFromDate,
        }),
      { initialProps },
    );
  }

  it('dispatches once on initial display when viewport starts older than coverage (no viewport event)', () => {
    // 핵심: cap.fire 없이 초기 렌더만으로 발화. coverage('20260715') > viewport('20260709') → 갭.
    renderInitial({});
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT dispatch when indicator coverage already reaches the viewport left edge', () => {
    renderInitial({ indicatorCoverageFromDate: '20260601' }); // viewport보다 과거 → 갭 없음
    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('holds until candles arrive, then dispatches on the candle-landing commit', () => {
    const { rerender } = renderInitial({ bundle: null });
    expect(extendSpy).not.toHaveBeenCalled();
    rerender({ bundle: bundleWithCandles() });
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('holds until the coverage signal is non-null, then dispatches (candles-first commit does not consume the one-shot)', () => {
    // 마킹 함정 가드: 캔들이 지표 신호보다 먼저 도착하므로 coverage=null 커밋에서
    // 마킹하면 지표 도착 후 재판정을 영영 못 한다. null 커밋은 미마킹, 신호 도착 발화.
    const { rerender } = renderInitial({ indicatorCoverageFromDate: null });
    expect(extendSpy).not.toHaveBeenCalled();
    rerender({ indicatorCoverageFromDate: '20260715' });
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('holds while initial viewport placement is in progress (canTriggerBackfill false), then dispatches', () => {
    const { rerender } = renderInitial({ canTrigger: false });
    expect(extendSpy).not.toHaveBeenCalled();
    rerender({ canTrigger: true });
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('checks at most once — no re-dispatch on later commits (SSE ticks)', () => {
    const { rerender } = renderInitial({});
    expect(extendSpy).toHaveBeenCalledTimes(1);
    rerender({}); // SSE 틱 시뮬 재렌더
    rerender({});
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useViewportBackfill — 저장뷰 구간 백필 (3d)', () => {
  /**
   * 저장뷰 적용은 **팬 없이 순간 이동**하므로 3b(좌측 팬 이벤트)가 발화하지 않는다.
   * 그래서 3c 와 같은 형태로 fill 을 세워 진행 루프(3a)에 워크백을 넘긴다.
   *
   * ── 이 describe 가 막는 방향 ────────────────────────────────────────────
   * **단발 `extend` 로 되돌아가는 것.** `historicalRange.extend(target)` 한 번은
   * 백엔드에서 한 청크만 받고 끝나고 `fillKind` 를 세우지 않아 3a 가 이어받지 못한다 —
   * 저장뷰 적용에는 팬이 없으니 그대로 멎는다(2026-08-21 실측: 3개월 전 저장뷰가
   * 3분 20초를 기다려도 오늘 화면 그대로였다). 아래 "연속 워크백" 테스트가 그 축이다.
   *
   * ── 이 describe 가 못 보는 것 ──────────────────────────────────────────
   * 착석(뷰포트를 저장 끝에 앉히는 것)은 `LiveChartRoot` 소유라 여기서 재지 않는다.
   * 여기는 **데이터를 그 구간까지 끌어오는가**만 본다.
   */
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260801',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  type Props = { savedRangeFromDate?: string | null; isExtending?: boolean; rangeWindowFromDate?: string | null };
  function renderSaved(initialProps: Props) {
    // 차트 참조는 **렌더를 건너 안정적이다** — 프로덕션의 `LiveChartRoot` 에서 chart 는
    // state(`chartEntry`)에 담긴 인스턴스라 viewKey remount 때만 갈린다. 렌더마다 새로
    // 만들면 뷰 경계가 매 커밋 서는 것으로 읽혀 fill 수명 계약이 테스트에서만 달라진다.
    const { chart } = chartWithCapturedHandler();
    return renderHook(
      (p: Props) =>
        useViewportBackfill({
          chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '1m',
          isExtending: p.isExtending ?? false,
          code: '005930',
          canTriggerBackfill: () => true,
          // 3a·3d 가 같은 값을 읽는다 — null 이면 둘 다 판정을 보류/종료한다.
          rangeWindowFromDate: p.rangeWindowFromDate === undefined ? '20260801' : p.rangeWindowFromDate,
          savedRangeFromDate: p.savedRangeFromDate ?? null,
        }),
      { initialProps },
    );
  }

  it('저장 구간이 로드 범위보다 과거면 **뷰포트 이벤트 없이** 발화한다', () => {
    renderSaved({ savedRangeFromDate: '20260520' }); // 현재 창 20260801 보다 과거
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('요청 창 신호(rangeWindowFromDate)가 아직 없으면 보류했다가, 도착하면 발화한다', () => {
    // 폴백으로 밀고 나가면 3a 가 첫 settle 에서 stop 해 한 스텝만 가고 멎는다.
    const { rerender } = renderSaved({ savedRangeFromDate: '20260520', rangeWindowFromDate: null });
    expect(extendSpy).not.toHaveBeenCalled();
    rerender({ savedRangeFromDate: '20260520', rangeWindowFromDate: '20260801' });
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('저장뷰가 없으면 발화하지 않는다', () => {
    renderSaved({ savedRangeFromDate: null });
    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('이미 저장 구간까지 로드돼 있으면 발화하지 않는다', () => {
    useLivePageStore.setState({ historicalFromDate: '20260501' }); // 목표보다 과거
    renderSaved({ savedRangeFromDate: '20260520' });
    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('같은 저장뷰로는 재발화하지 않는다 — SSE 틱마다 밀면 안 된다', () => {
    const { rerender } = renderSaved({ savedRangeFromDate: '20260520' });
    expect(extendSpy).toHaveBeenCalledTimes(1);
    rerender({ savedRangeFromDate: '20260520' });
    rerender({ savedRangeFromDate: '20260520' });
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('**다른** 저장뷰로 바꾸면 그 구간까지 다시 채운다', () => {
    const { rerender } = renderSaved({ savedRangeFromDate: '20260520' });
    expect(extendSpy).toHaveBeenCalledTimes(1);
    rerender({ savedRangeFromDate: '20260301' });
    expect(extendSpy).toHaveBeenCalledTimes(2);
  });

  it('fill 을 세우므로 진행 루프(3a)가 이어받는다 — 단발 extend 면 여기서 멎는다', () => {
    // 3a 는 settle 신호(isExtending 하강 엣지)에서 다음 스텝을 낸다. fill 이 활성이
    // 아니면(=단발 extend) 곧바로 return 하므로 두 번째 호출이 없다.
    const { rerender } = renderSaved({ savedRangeFromDate: '20260101' });
    expect(extendSpy).toHaveBeenCalledTimes(1);
    rerender({ savedRangeFromDate: '20260101', isExtending: true });
    rerender({ savedRangeFromDate: '20260101', isExtending: false }); // 하강 엣지 = 스텝 settle
    expect(extendSpy.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('useViewportBackfill — warm-cache settle signal (3a)', () => {
  /**
   * 종목 A→B→A 복귀 후 일봉 재-팬의 박제(2026-08-15 실측).
   *
   * 복귀는 fresh-view 라 `historicalFromDate=null` 이고, 그 상태의 첫 스텝 from 은
   * 결정적이다(`nextHistoricalFrom` 이 axis 최좌단을 base 로 삼는다) — 1차 방문의
   * 쿼리 키와 **정확히 같다**. 그 키는 웜이라 fetch 가 아예 없고, 일봉의
   * `isExtending`(=isPlaceholderData && isFetching)이 한 번도 뜨지 않는다. fetch 의
   * falling edge 만 스텝 완료로 읽으면 fill 이 영구 non-null 로 잠겨 이후 트리거가
   * 전부 3b 가드에 막힌다(실측 증상: 복귀 후 1청크만 받고 정지).
   *
   * 그래서 스텝 완료를 **데이터 기준**으로도 판정한다: "지금 서빙 중인 창의 from 이
   * 방금 요청한 from 과 같다".
   */
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: 'D',
      // fresh view — setGroupSymbol(종목 교체)이 런타임을 리셋한 직후 상태.
      historicalFromDate: null,
    });
    // **passthrough 스파이**(다른 블록의 no-op mock 과 다르다): 스토어가 실제로
    // 움직여야 `snapshot().historicalFromDate` 가 요청한 from 과 같아진다 —
    // no-op 이면 캐시 분기의 전제가 원리적으로 성립하지 않아 테스트가 무의미해진다.
    extendSpy = vi.spyOn(useLivePageStore.getState(), 'extendHistoricalRange');
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
    useLivePageStore.setState({ historicalFromDate: null });
  });

  function renderWarm() {
    const cap = chartWithCapturedHandler();
    const hook = renderHook(
      ({ settled, ext }: { settled: string | null; ext: boolean }) =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: 'D',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: () => true,
          settledFromDate: settled,
        }),
      { initialProps: { settled: null as string | null, ext: false } },
    );
    return { cap, ...hook };
  }

  it('advances the fill when a step settles from cache (no fetch, so no falling edge)', () => {
    const { cap, rerender } = renderWarm();

    // 빈공간 60바 → D 예산 ceil(60/50)=2. 첫 스텝 dispatch.
    cap.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
    const step1 = extendSpy.mock.calls[0][0] as string;

    // 웜 히트: 그 창이 즉시 서빙된다 — isExtending 은 내내 false.
    rerender({ settled: step1, ext: false });

    expect(extendSpy).toHaveBeenCalledTimes(2);
  });

  it('consumes one budget unit when both signals fire for the same step', () => {
    // 멱등 가드: 콜드 스텝의 falling edge 와 (뒤늦게 도착한) settled 신호가 같은
    // 스텝을 가리키면 진행은 한 번만이어야 한다 — 아니면 예산이 두 배로 집행돼
    // fill 이 목표를 넘어간다.
    const { cap, rerender } = renderWarm();

    cap.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    const step1 = extendSpy.mock.calls[0][0] as string;

    rerender({ settled: null, ext: true }); // 스텝 1 fetch 진행
    rerender({ settled: step1, ext: false }); // settle: falling edge + settled 동시

    expect(extendSpy).toHaveBeenCalledTimes(2);
  });

  it('releases the fill on budget exhaustion so a later pan can start a new one', () => {
    // 잠금 해제까지 확인한다 — 진행만 되고 endFill 에 못 닿으면 증상은 그대로다.
    const { cap, rerender } = renderWarm();

    cap.fire({ from: -60, to: 100 }); // 예산 2
    vi.advanceTimersByTime(150);
    const step1 = extendSpy.mock.calls[0][0] as string;

    rerender({ settled: step1, ext: false }); // 스텝 2 (예산 소진)
    expect(extendSpy).toHaveBeenCalledTimes(2);
    const step2 = extendSpy.mock.calls[1][0] as string;

    rerender({ settled: step2, ext: false }); // 예산 0 → stop → fill 해제
    expect(extendSpy).toHaveBeenCalledTimes(2);

    // 해제됐으므로 새 제스처가 새 예산으로 다시 시작한다.
    cap.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(3);
  });

  it('does not advance on a settled date that is not the requested one', () => {
    // 스테일 응답(이전 창의 from)이 스텝 완료로 위장하지 못한다.
    const { cap, rerender } = renderWarm();

    cap.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);

    rerender({ settled: '20991231', ext: false }); // 요청한 from 과 무관한 값

    expect(extendSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * 창 스코프(Provider 안) 경로 — 위 describe 들은 전부 **전역 폴백**만 검증한다.
 *
 * 그 비대칭이 실제 결함을 숨겼다: 워크스페이스 창에서는 가드가 어댑터에 코드를 묻고,
 * 지수 그룹의 심볼 코드(`'KOSPI'`)가 차트가 받은 prop(`'index:KOSPI'`)과 달라 3b
 * 디스패치가 **매번 조용히 반려**됐다. 전역 경로는 지수에서 `activeCode=null` 이라
 * `view.code &&` 가 단락돼 공허하게 통과했으므로 이 경로로는 영원히 드러나지 않는다.
 *
 * 두 케이스를 **교대 대조**로 둔다 — 지수와 종목이 같은 하니스를 타므로, 종목 쪽이
 * 초록인데 지수 쪽만 빨갛다면 원인은 하니스가 아니라 가드다. 지수만 단독으로 두면
 * "디바운스가 아예 안 돌았다" 와 구별되지 않는다.
 */
describe('useViewportBackfill — 창 스코프(Provider 안)', () => {
  const WINDOW_ID = 'w-chart';
  let extendSpy: ReturnType<typeof vi.spyOn>;

  function seedWindow(symbol: GroupSymbol): void {
    useWorkspaceStore.setState({
      windows: [{
        id: WINDOW_ID,
        kind: 'chart',
        group: 1,
        rect: { x: 0, y: 0, w: 400, h: 300 },
        chart: { timeframe: '1m' },
      }],
      zOrder: [WINDOW_ID],
      groupSymbols: { 1: symbol },
      chartRuntime: {},
    });
  }

  /** `ChartWindow` 가 싣는 값의 축소판. 지수의 `code` 는 null 이다(공간 C 미러). */
  function provider(code: string | null) {
    const value: WindowViewValue = {
      windowId: WINDOW_ID,
      group: 1,
      code,
      timeframe: '1m',
      historicalFromDate: '20260601',
      };
    return ({ children }: { children: ReactNode }) => (
      <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>
    );
  }

  /** 좌측 팬 1회 → 디바운스 만료. `code` 는 `LiveChartRoot` 가 넘기는 workarea 코드. */
  function panLeft(workareaCode: string, ctxCode: string | null) {
    const cap = chartWithCapturedHandler();
    renderHook(
      () =>
        useViewportBackfill({
          chart: cap.chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(workareaCode),
          timeframe: '1m',
          isExtending: false,
          code: workareaCode,
          canTriggerBackfill: () => true,
        }),
      { wrapper: provider(ctxCode) },
    );
    cap.fire({ from: -5, to: 100 });
    vi.advanceTimersByTime(150);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    extendSpy = vi
      .spyOn(useWorkspaceStore.getState(), 'extendChartHistoricalRange')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  it('지수 창: 좌측 팬이 창의 from-date 를 확장한다', () => {
    seedWindow({ code: 'KOSPI', name: '코스피', kind: 'index' });
    panLeft('index:KOSPI', null);
    expect(extendSpy).toHaveBeenCalledTimes(1);
    expect(extendSpy).toHaveBeenCalledWith(WINDOW_ID, expect.any(String));
  });

  it('종목 창: 같은 하니스에서 동일하게 확장한다(대조군)', () => {
    seedWindow({ code: '005930', name: '삼성전자' });
    panLeft('005930', '005930');
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('창의 종목이 팬 도중 바뀌면 반려한다 — 가드가 닫는 방향', () => {
    seedWindow({ code: '005930', name: '삼성전자' });
    panLeft('000660', '000660'); // 차트가 든 코드와 창의 현재 종목이 불일치
    expect(extendSpy).not.toHaveBeenCalled();
  });
});

describe('useViewportBackfill — 빈 화면 클램프 탈출 (3e)', () => {
  // 3b 는 `subscribeVisibleLogicalRangeChange` 에만 발화한다. 그런데 데이터 좌단까지
  // 팬하면 lwc 가 화면 폭만큼의 whitespace 만 허용하고 **클램프**하므로 논리 범위가
  // 더 변하지 않고 → 이벤트가 끊기고 → 트리거도 함께 죽는다. 그 상태에서 화면은
  // whitespace 100% 인 채 멈춘다(2026-08-25 실측: 드래그 7회 + 60초 대기에 로그 0줄).
  //
  // 3e 는 3c/3d 와 같은 계열이다 — "뷰포트 이벤트가 없는 자리"를 커밋으로 메운다.
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  /** 클램프된 차트 — 화면 402바 중 데이터는 우측 끝 1바뿐. **이벤트는 쏘지 않는다.** */
  function chartWithViewport(from: number, to: number) {
    const ts = {
      getVisibleLogicalRange: vi.fn(() => ({ from, to })),
      getVisibleRange: vi.fn(() => ({ from: 1, to: 2 })),
      timeToIndex: vi.fn(() => 0),
      setVisibleLogicalRange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    };
    return { chart: { timeScale: () => ts } as never, ts };
  }

  type Props = { from?: number; to?: number; isExtending?: boolean; historicalFromDate?: string };
  function renderClamped(initialProps: Props = {}) {
    // indicatorCoverage 를 뷰포트 좌단보다 과거로 줘 **3c 를 잠재운다** — 안 그러면
    // 3c 의 발화를 3e 의 것으로 오독한다.
    return renderHook(
      (p: Props) => {
        if (p.historicalFromDate) {
          useLivePageStore.setState({ historicalFromDate: p.historicalFromDate });
        }
        return useViewportBackfill({
          chart: chartWithViewport(p.from ?? -401, p.to ?? 1).chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '1m',
          isExtending: p.isExtending ?? false,
          code: '005930',
          canTriggerBackfill: () => true,
          indicatorCoverageFromDate: '20260601',
          rangeWindowFromDate: '20260601',
        });
      },
      { initialProps },
    );
  }

  it('화면이 사실상 빈 채 멈춰 있으면 **뷰포트 이벤트 없이** 확장한다', () => {
    renderClamped();
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  it('데이터가 화면을 덮고 있으면 발화하지 않는다 — 정상 좌팬은 3b 의 일이다', () => {
    renderClamped({ from: -5, to: 100 });
    expect(extendSpy).not.toHaveBeenCalled();
  });

  it('창이 그대로면 재발화하지 않는다 — 바닥에서 커밋마다 밀면 안 된다', () => {
    const { rerender } = renderClamped();
    expect(extendSpy).toHaveBeenCalledTimes(1);
    // ⚠ **백프레셔를 먼저 풀어야 이 테스트가 뭔가를 증명한다.** 첫 발화가 세운
    // `fillKind` 가 남아 있으면 그 가드에 먼저 막혀, 창 동일 반려를 통째로 지워도
    // 초록이다(2026-08-25 red-check 에서 실제로 그랬다). settle 을 태워 백프레셔를
    // 걷고, `historicalFromDate` 만 그대로 두는 것이 이 판정의 유일 변수다.
    rerender({ isExtending: true });
    rerender({ isExtending: false }); // 창이 안 움직였다 — 확장이 아무 데도 못 갔다
    rerender({});
    expect(extendSpy).toHaveBeenCalledTimes(1);
  });

  /** 한 스텝의 실제 수명: 확장 → fetch(isExtending↑) → settle(↓)에서 3a 가 예산
   *  소진을 보고 `endFill`. 그 해제가 있어야 다음 3e 판정이 백프레셔를 통과한다 —
   *  **토글 없이 rerender 만 하면 자기가 세운 fillKind 에 자기가 막힌다.** */
  function settleStep(
    rerender: (p: Props) => void,
    historicalFromDate: string,
  ) {
    rerender({ isExtending: true });
    rerender({ isExtending: false, historicalFromDate });
  }

  it('창이 실제로 뒤로 갔으면 다음 스텝을 잇는다 — 구멍 구간을 건너려면 필요하다', () => {
    const { rerender } = renderClamped();
    expect(extendSpy).toHaveBeenCalledTimes(1);
    settleStep(rerender, '20260501');
    expect(extendSpy).toHaveBeenCalledTimes(2);
  });

  it('재시도 상한을 넘으면 멈춘다 — 디스크 모드엔 좌측 바닥이 없다(무한 방지)', () => {
    const { rerender } = renderClamped();
    for (const d of ['20260501', '20260401', '20260301', '20260201', '20260101']) {
      settleStep(rerender, d);
    }
    expect(extendSpy.mock.calls.length).toBe(3);
  });

  it('화면이 다시 채워지면 상한이 되돌아온다 — 다음 구간은 새 예산을 받는다', () => {
    const { rerender } = renderClamped();
    settleStep(rerender, '20260501');
    settleStep(rerender, '20260401');
    expect(extendSpy).toHaveBeenCalledTimes(3); // 상한 소진
    rerender({ from: -5, to: 100, historicalFromDate: '20260401' }); // 데이터가 화면을 덮었다
    settleStep(rerender, '20260301');
    expect(extendSpy).toHaveBeenCalledTimes(4);
  });

  it('백프레셔: 진행 중인 스텝이 있으면 발화하지 않는다', () => {
    renderClamped({ isExtending: true });
    expect(extendSpy).not.toHaveBeenCalled();
  });
});

describe('useViewportBackfill — 재투영 자격 배선 (2, 프리펜드 계열)', () => {
  // 커널(`viewportHasReprojectableAnchor`)의 판정은 minuteViewportPolicy.test 가 테이블로
  // 잰다. 여기서 재는 것은 **그 커널이 실제로 이 경로에 물려 있는가** 하나다 —
  // 2026-08-26 사용자 로그의 실패는 판정이 틀려서가 아니라 **판정이 없어서** 났다.
  beforeEach(() => {
    vi.mocked(livePerfLog).mockClear();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      // 프리펜드 게이트("좌측 팬을 한 적이 있다")를 통과시킨다.
      historicalFromDate: '20260601',
    });
  });

  /** 스냅샷이 저장할 뷰포트를 지정하는 차트. 이벤트는 쏘지 않는다. */
  function chartAt(from: number, to: number) {
    const ts = {
      getVisibleLogicalRange: vi.fn(() => ({ from, to })),
      getVisibleRange: vi.fn(() => ({ from: 1, to: 2 })),
      timeToIndex: vi.fn(() => 7),
      setVisibleLogicalRange: vi.fn(),
      scrollPosition: vi.fn(() => 0),
      scrollToPosition: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      width: vi.fn(() => 640),
    };
    return { chart: { timeScale: () => ts } as never, ts };
  }

  /** 캔들 좌단이 과거로 늘어난 번들 — 프리펜드 커밋을 흉내낸다.
   *
   * ⚠ 시각은 **축 세션 안**이어야 한다. 리포지셔너는 `axis.contains(ts_ms)` 로 캔들을
   * 거르므로, 축 밖 시각이면 `newEarliest === null` 로 **게이트 앞에서 조기 반환**한다
   * — 이 테스트를 처음 쓸 때 그 픽스처(`ts_ms: 1_000`)로 빨간 결과를 얻고 코드를
   * 의심했다. 빨간 이유가 대상 코드인지 탐침인지부터 가를 것. */
  const SESSION_OPEN_MS = Date.UTC(2026, 6, 9, 0, 0); // 2026-07-09 09:00 KST
  function bundleFrom(offsetsMin: number[]): RangeBundle {
    const base = bundleWithCandles();
    return {
      ...base,
      candles: offsetsMin.map((m) => ({
        ts_ms: SESSION_OPEN_MS + m * 60_000,
        open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0,
      })),
    };
  }

  function skipReasons(): string[] {
    return vi.mocked(livePerfLog).mock.calls
      .filter(([event]) => event === 'viewport_reseat_skip')
      .map(([, payload]) => String((payload as { d?: unknown }).d ?? ''));
  }

  /** 첫 렌더는 prevAxis 를 세우기만 한다(스냅샷은 두 번째 커밋부터 존재). */
  function renderPrepend(from: number, to: number) {
    const { chart } = chartAt(from, to);
    const view = renderHook(
      (p: { bundle: RangeBundle }) =>
        useViewportBackfill({
          chart,
          axis: axisWithOneSession(),
          bundle: p.bundle,
          timeframe: '1m',
          isExtending: false,
          code: '005930',
          canTriggerBackfill: () => true,
        }),
      { initialProps: { bundle: bundleFrom([120]) } },
    );
    // 스냅샷은 **두 번째 커밋부터** 존재한다(첫 커밋엔 prevAxis 가 없다). 프리펜드를
    // 세 번째 커밋에 두어 snap·prevShape·prevEarliest 가 모두 선 상태에서 재도록 한다.
    view.rerender({ bundle: bundleFrom([120]) });
    vi.mocked(livePerfLog).mockClear();
    // 좌단이 과거로 이동 = 프리펜드.
    view.rerender({ bundle: bundleFrom([30, 120]) });
    return view;
  }

  it('화면이 거의 전부 whitespace 면 재투영을 **반려하고 그 사실을 로그로 남긴다**', () => {
    renderPrepend(-2226, 1);
    expect(skipReasons().some((d) => d.includes('viewport_mostly_whitespace'))).toBe(true);
  });

  it('데이터가 화면을 덮고 있으면 그 사유로 반려하지 않는다 — 정상 좌팬은 종전대로다', () => {
    renderPrepend(-5, 100);
    expect(skipReasons().some((d) => d.includes('viewport_mostly_whitespace'))).toBe(false);
  });
});

describe('useViewportBackfill — 기간 점프 뒤의 좌측 팬 (fill 상태 기계의 수명)', () => {
  let extendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: '20260601',
    });
    extendSpy = vi
      .spyOn(useLivePageStore.getState(), 'extendHistoricalRange')
      .mockImplementation(() => {});
    // ⚠ **호출 이력을 명시적으로 비운다.** `afterEach` 의 `mockRestore()` 로는 부족하다:
    // 테스트가 `setState` 를 부르면 zustand 가 상태 객체를 새로 만들고, 복원은 **옛
    // 객체**에 원본 함수를 되돌려 놓는다. 살아 있는 객체에는 mock 이 남아 다음
    // `vi.spyOn` 이 **같은 스파이를 재사용**하므로 이전 describe 의 호출이 그대로
    // 딸려 온다(실측: 새 describe 첫 줄에서 `[["20260518"]]`). 절대 개수를 재는
    // 단언이 그 잔재를 자기 것으로 셈해 조용히 틀린다.
    extendSpy.mockClear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  it('점프가 진행 중이던 fill 의 하강 엣지를 삼켜도 이후 좌팬이 산다', () => {
    // 「분봉으로」 실사용 신고의 박제(2026-09-04). 점프는 (code, timeframe) 을
    // **아무것도 바꾸지 않으면서** 창을 리셋하고 차트를 remount 한다. 그 조합이
    // fill 상태 기계를 푸는 유일한 신호를 통째로 삼킨다:
    //   ① `historicalRange.reset()` → `historicalFromDate=null` → `isExtending`
    //      이 그 자리에서 false 로 떨어진다(useLiveBundle 의 `extending` 이
    //      `historicalFromDate != null` 게이트를 쓴다) = 진행 중이던 fill 의 하강 엣지.
    //   ② 같은 커밋에 차트가 remount 되어 `lastAppliedCountRef` 가 null 이 되고
    //      창도 null 이라 `canTriggerBackfill()` 이 **false** 다.
    //   ③ 3a 는 `prevExtendingRef` 를 먼저 갱신한 뒤 그 게이트에서 반환하므로
    //      엣지를 **소비만 하고 버린다** → `fillKind` 가 영구 non-null.
    // 그 뒤로는 3b 의 배압 게이트(로그도 없는 자리)가 모든 좌팬을 반려한다 —
    // 사용자에게는 "초기 캔들만 보이고 과거 스크롤이 아무 일도 안 하는" 상태다.
    const before = chartWithCapturedHandler();
    const after = chartWithCapturedHandler();
    const { rerender } = renderHook(
      ({ chart, ext, canTrigger }: { chart: never; ext: boolean; canTrigger: boolean }) =>
        useViewportBackfill({
          chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '1m',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: () => canTrigger,
        }),
      { initialProps: { chart: before.chart, ext: false, canTrigger: true } },
    );

    // 1. 좌팬 → fill 무장 + 1스텝 dispatch.
    before.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);

    // 2. 그 스텝이 아직 나는 중.
    rerender({ chart: before.chart, ext: true, canTrigger: true });

    // 3. 「분봉으로」 — 창 리셋 + 차트 remount. 이 커밋의 게이트는 닫혀 있다.
    useLivePageStore.setState({ historicalFromDate: null });
    rerender({ chart: after.chart, ext: false, canTrigger: false });

    // 4. 새 차트의 초기 뷰포트가 적용되어 게이트가 다시 열린다.
    rerender({ chart: after.chart, ext: false, canTrigger: true });

    // 5. 새 차트에서 좌팬 — 여기서 데이터를 가져와야 한다.
    after.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(2);
  });

  it('하강 엣지가 **차트 없는 커밋**에 와도(remount 중간) 잠기지 않는다', () => {
    // 위 테스트의 짝 — 같은 잠김의 **다른 순서**다. remount 는 `chart` 가 한 커밋
    // 동안 null 인 구간을 지나고(`chartEntry.key !== viewKey`), 창 리셋이 그 커밋에
    // 떨어지면 하강 엣지는 3a 의 **첫 줄**(`if (!chart) return`)에서 버려진다.
    // 위 경로는 `canTriggerBackfill()` 이, 이 경로는 `chart` 가 엣지를 삼키므로,
    // 둘 중 하나만 막는 수정은 나머지 순서에서 그대로 재발한다.
    const before = chartWithCapturedHandler();
    const after = chartWithCapturedHandler();
    const { rerender } = renderHook(
      ({ chart, ext, canTrigger }: { chart: never; ext: boolean; canTrigger: boolean }) =>
        useViewportBackfill({
          chart,
          axis: axisWithOneSession(),
          bundle: bundleWithCandles(),
          timeframe: '1m',
          isExtending: ext,
          code: '005930',
          canTriggerBackfill: () => canTrigger,
        }),
      { initialProps: { chart: before.chart, ext: false, canTrigger: true } },
    );

    before.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(1);
    rerender({ chart: before.chart, ext: true, canTrigger: true });

    // remount 중간 커밋 — 차트가 아직 없다. 창 리셋의 하강 엣지가 여기 떨어진다.
    useLivePageStore.setState({ historicalFromDate: null });
    rerender({ chart: null as never, ext: false, canTrigger: true });

    // 새 차트가 게시되고 초기 뷰포트도 적용됐다.
    rerender({ chart: after.chart, ext: false, canTrigger: true });

    after.fire({ from: -60, to: 100 });
    vi.advanceTimersByTime(150);
    expect(extendSpy).toHaveBeenCalledTimes(2);
  });
});
