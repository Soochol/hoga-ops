import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useViewportBackfill } from './useViewportBackfill';
import { useLivePageStore } from '../state/livePage';
import { createVirtualAxis } from '../util/virtualAxis';
import type { RangeBundle } from '../api/types';

// 09:00–15:30 KST 세션 한 개짜리 축 — segments.length>0 이라 3a/3b 가 조기 반환하지
// 않는다. sessionOpenMs 는 nextHistoricalFrom 의 axisEarliestMs 인자로만 쓰인다.
const KST = 9 * 60 * 60 * 1000;
function axisWithOneSession() {
  const open = Date.UTC(2026, 6, 9, 0, 0) - KST + 9 * 3600_000; // 2026-07-09 09:00 KST
  const close = open + 6.5 * 3600_000;
  return createVirtualAxis([{ date: '20260709', sessionOpenMs: open, sessionCloseMs: close }]);
}

// candleCountRef>0 이 되도록 캔들 1개만 있으면 충분(3a/3b 의 빈 차트 가드 통과).
function bundleWithCandles(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260709',
    to_date: '20260709',
    bucket_ms: 60_000,
    segments: [{ date: '20260709', session_open_ms: 0, session_close_ms: 1, source: 'kis_live' }],
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
function chartWithCapturedHandler() {
  let logicalHandler: ((range: unknown) => void) | null = null;
  const ts = {
    getVisibleLogicalRange: vi.fn(() => ({ from: -5, to: 100 })),
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
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  it('dispatches the next step on the isExtending falling edge when whitespace remains', () => {
    // 배압으로 3b 가 skip 한 수요는 유실되지 않는다: 스텝이 settle(true→false)되고
    // 뷰포트가 아직 빈영역(visibleFrom<0)이면 settle-loop 가 다음 스텝을 스스로
    // dispatch 한다. 이 계약이 배압 게이트와 함께 점진 렌더링을 복원한다.
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
      { initialProps: { ext: true } },
    );

    expect(extendSpy).not.toHaveBeenCalled(); // 아직 하강 엣지 아님
    rerender({ ext: false }); // 스텝 settle → 하강 엣지

    expect(extendSpy).toHaveBeenCalledTimes(1);
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
