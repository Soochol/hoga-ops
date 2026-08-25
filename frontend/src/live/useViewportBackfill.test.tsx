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
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    extendSpy.mockRestore();
  });

  type Props = { savedRangeFromDate?: string | null; isExtending?: boolean; rangeWindowFromDate?: string | null };
  function renderSaved(initialProps: Props) {
    return renderHook(
      (p: Props) =>
        useViewportBackfill({
          chart: chartWithCapturedHandler().chart,
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
