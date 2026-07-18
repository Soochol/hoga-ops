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
    return renderHook(
      (p: Props) =>
        useViewportBackfill({
          chart: chartWithCapturedHandler().chart,
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
