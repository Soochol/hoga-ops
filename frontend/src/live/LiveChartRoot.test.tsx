import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, createEvent, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const resizeObserverCallbacks: ResizeObserverCallback[] = [];

// jsdom does not implement ResizeObserver — provide a controllable stub before
// the component module is loaded so resize-driven viewport behavior is testable.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

import { LiveChartRoot, SIDECAR_REVEAL_CAP_MS, shouldShowTradeVolumePocOverlay, shouldShowDepthHeatmapOverlay, shouldShowDepthDeltaOverlay } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { CandlestickSeries, createChartEx, LineSeries, TickMarkType } from 'lightweight-charts';
import { createVirtualAxis } from '../util/virtualAxis';
import { INTER_SEGMENT_GAP_MS } from '../util/time';
import { realMsToVirtualSeconds } from './viewportAnchor';
import type { RangeBundle } from '../api/types';
import { useChartPrefsStore } from '../state/chartPrefs';
import { CHART_LAYOUT_OPTIONS, CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

/** 일봉 윈도잉 산식은 rightOffset(밀도 파생)을 더한다 — 기대값을 상수에서 유도해
 *  밀도 다이얼 변경 시 테스트가 마법수로 깨지지 않게 한다. */
const RIGHT_OFFSET = CHART_TIMESCALE_OPTIONS.rightOffset ?? 0;

vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChartEx: vi.fn(() => ({
      addSeries: vi.fn(() => ({
        setData: vi.fn(),
        update: vi.fn(),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn(),
        detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
        scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(), getVisibleLogicalRange: vi.fn(() => null),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        coordinateToTime: vi.fn(() => null),
        width: vi.fn(() => 800),
        height: vi.fn(() => 28),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 })),
    })),
  };
});

const DEFAULT_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260527', session_open_ms: 1748275200000, session_close_ms: 1748298600000, source: 'kiwoom_live' },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('LiveChartRoot', () => {
  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    useChartPrefsStore.getState().resetToDefaults();
    // 분봉 커버리지 복원(1-샷)의 재료 — 남으면 뒤 테스트의 분봉 초기 배치가
    // extendHistoricalRange를 dispatch해 상태가 샌다.
    useLivePageStore.setState({ lastMinuteHistoricalFromDate: null });
  });

  it('크로스헤어 구독 해제가 throw 해도 teardown 꼬리가 끝까지 돈다', () => {
    // 차트 파괴 레이스 재현 — 부모의 chart.remove() 가 먼저 돌면 lightweight-charts 가
    // 핸들이 dangling 이라며 던진다. 해제는 이 cleanup 의 **첫 줄**이라 가드가 없으면
    // 뒤따르는 rAF 취소·타이머 취소·커서 스토어 리셋이 전부 스킵된다(그냥 JS 다).
    const series = {
      setData: vi.fn(),
      update: vi.fn(),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      setMarkers: vi.fn(),
    };
    const chart = {
      addSeries: vi.fn(() => series),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
        scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        getVisibleLogicalRange: vi.fn(() => null),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        coordinateToTime: vi.fn(() => null),
        coordinateToLogical: vi.fn(() => null),
        timeToIndex: vi.fn(() => null),
        width: vi.fn(() => 800),
        height: vi.fn(() => 28),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(() => {
        throw new Error('Value is undefined');
      }),
      chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 })),
    };
    vi.mocked(createChartEx).mockReturnValueOnce(chart as never);

    const { unmount } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      useLiveCursorStore.setState({ cursorMs: 123, sidebarCursorMs: 123 });
    });

    expect(() => unmount()).not.toThrow();
    // 가드가 없으면 해제에서 던지고 이 리셋까지 못 온다 — 커서가 굳은 채 남는다.
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });

  /**
   * 호출자 쪽 가드 고정 — 스토어 단위 테스트(useLiveCursorStore.test.ts)가 못 보는
   * 자리다. 저기서는 `ownedBy` 만 고정되므로, 이 cleanup 이 여전히 export 되어 있는
   * `resetCursor()` 로 되돌아가도 스토어 테스트는 전부 초록이다.
   *
   * **막는 방향**: 발행자가 **아닌** 차트 창의 teardown 이 남의 발행분을 지우는 것.
   * **못 보는 것**: 발행자 자신의 teardown(그건 지워야 맞다 — 위 테스트가 본다).
   */
  it('다른 창이 발행한 스팟 커서를 이 창의 teardown 이 지우지 않는다', () => {
    const { unmount } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    // 옆 차트 창 'hovered' 가 호버 중이라 스팟을 발행한 상태. 이 창은 Provider 밖이라
    // windowId 가 null 이므로 주인이 아니다.
    act(() => {
      useLiveCursorStore.getState().setCursor(1748400000123);
      useLiveCursorStore.getState().setSidebarCursor(1748400000000, {
        windowId: 'hovered', group: 1, code: '005930', timeframe: '1m',
      });
    });

    unmount();

    // 이 세 줄이 회귀의 본체다 — 가드가 없으면 셋 다 null 이 되고, 10호가 창이
    // latest 로 떨어진다(2026-08-12 실측: 29초에 19회).
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1748400000000);
    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.windowId).toBe('hovered');
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
  });

  it('남의 스팟은 남겨도 자기 sync 발행은 teardown 에서 걷는다', () => {
    const { unmount } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      // 주인은 옆 창인데(leave 타이머 사이 옆 창이 발행한 상황),
      useLiveCursorStore.getState().setSidebarCursor(1748400000000, {
        windowId: 'hovered', group: 1, code: '005930', timeframe: '1m',
      });
      // 이 창이 띄워 둔 sync 크로스헤어는 아직 살아 있다.
      useLiveCursorStore.getState().setSyncCursor(1748400000999, {
        windowId: null, group: 1, code: '005930', timeframe: '1m',
      });
    });

    unmount();

    // sync 를 따로 걷지 않으면 옆 창에 크로스헤어가 눌어붙는다.
    expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
    // 그러면서 남의 스팟은 그대로다.
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1748400000000);
  });

  it('renders root container with chart slot', () => {
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
    expect(screen.getByTestId('live-chart-root')).toBeTruthy();
  });

  // 배선 테스트 — 문구 결정(hogaMissingNotice.test)과 표시(HogaMissingNotice.test)는
  // 각각 따로 검증한다. 여기서 보는 것은 **번들의 사유가 화면까지 도달하는가** 하나다.
  // #1133 의 원인이 정확히 이 종류였다: 값은 정확히 계산됐는데 소비자가 다른 경로를
  // 봐서 도달하지 않았다.
  it('호가 결손 사유가 번들에서 화면까지 이어진다', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={{ ...DEFAULT_BUNDLE, missing_dates: [{ date: '20260527', reason: 'source_missing' }] }}
        venue="NXT"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('hoga-missing-notice')).toHaveTextContent('NXT 호가 기록 없음');
  });

  // #1133 후속 — 이 테스트가 prop 경로의 **존재 이유**다. 사유를 번들에만 실으면
  // 캔들이 없는 순간(자격증명 미설정·벤더 장애) 번들이 null 이 되어 안내가 함께
  // 사라진다. 정작 "왜 비었나" 를 물어야 할 상황에서 답이 없어지는 셈이다.
  it('캔들 번들이 없어도 결손 사유는 표시된다', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={null}
        hogaMissingDates={[{ date: '20260527', reason: 'source_missing' }]}
        venue="NXT"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('hoga-missing-notice')).toHaveTextContent('NXT 호가 기록 없음');
  });

  /**
   * 미캡처(`not_captured`) 는 **얼린 창에서만** 말한다.
   *
   * ── 막는 방향 ─────────────────────────────────────────────────────────
   * ① **켜는 사람이 사라지는 것.** 이 축은 원래 `/study` 가 소유했고, 그 페이지를
   *    지우자 `true` 를 주는 곳이 없어져 기능이 **조용히 죽었다** — 프롭·파생·순수
   *    함수·그 테스트가 전부 남아 있어 타입체크도 테스트도 빨개지지 않았다.
   *    지금은 별도 프롭이 아니라 `savedRangeFrozen` 에서 파생하므로 그 재발이
   *    구조적으로 어렵다(얼림은 다른 소비자가 여럿이라 혼자 죽지 않는다).
   * ② **평소 창에서 켜지는 것.** 얼린 창은 fetch 범위가 곧 저장 구간이지만, 다른
   *    종목·일봉 창은 자기 평소 구간을 받는다. 거기서 켜면 사용자가 고르지도 않은
   *    구간의 미캡처를 상시로 말해 진짜 결손이 묻힌다(`hogaMissingNotice` 의
   *    `IGNORED_REASONS` 주석이 기록한 실측: 90일 창에 22일 미캡처).
   *
   * ── 못 보는 것 ────────────────────────────────────────────────────────
   * 어느 창이 `savedRangeFrozen` 을 받는가 — 그 판정은 `ChartWindow` 소유다
   * (`SavedRangeChip.test.tsx` 가 `krxPinned` 에 대해 같은 경계를 긋는다).
   */
  it('얼린 창에서는 미캡처를 말한다', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        hogaMissingDates={[{ date: '20260527', reason: 'not_captured' }]}
        savedRangeFrozen
        venue="KRX"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('hoga-missing-notice')).toHaveTextContent('미캡처');
  });

  it('평소 창에서는 미캡처를 말하지 않는다 — 대조군', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        hogaMissingDates={[{ date: '20260527', reason: 'not_captured' }]}
        venue="KRX"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.queryByTestId('hoga-missing-notice')).toBeNull();
  });

  it('prop 이 없으면 번들에서 읽는다 — 구 호출부 하위호환', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={{ ...DEFAULT_BUNDLE, missing_dates: [{ date: '20260527', reason: 'venue_unsupported' }] }}
        venue="UN"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('hoga-missing-notice')).toHaveTextContent('통합 호가 기록 없음');
  });

  // 둘 다 참일 수 있다(캔들도 없고 호가 기록도 없음). 그때 무엇을 말하느냐가 계약이다 —
  // 차트 자체가 없는데 "호가 기록 없음" 부터 읽히면 무엇을 고쳐야 할지 알 수 없고,
  // 실제로 고칠 수 있는 쪽은 캔들이다(벤더가 과거를 다시 준다).
  it('캔들이 없으면 캔들 결손만 말한다', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={null}
        hogaMissingDates={[{ date: '20260527', reason: 'source_missing' }]}
        candleEmpty={{ text: '벤더 연결이 설정되지 않아 캔들을 받지 못했다', action: 'settings', actionLabel: '설정 열기' }}
        venue="NXT"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('candle-empty-state')).toHaveTextContent('벤더 연결');
    expect(screen.queryByTestId('hoga-missing-notice')).toBeNull();
  });

  it('캔들이 있으면 호가 결손을 말한다', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        hogaMissingDates={[{ date: '20260527', reason: 'source_missing' }]}
        candleEmpty={null}
        venue="NXT"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('hoga-missing-notice')).toHaveTextContent('NXT 호가 기록 없음');
    expect(screen.queryByTestId('candle-empty-state')).toBeNull();
  });

  it('결손이 없으면 안내가 뜨지 않는다', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        venue="NXT"
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.queryByTestId('hoga-missing-notice')).toBeNull();
  });

  it('prevents the browser image context menu inside the chart area', () => {
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

    const root = screen.getByTestId('live-chart-root');
    const chartSlot = root.firstElementChild;
    expect(chartSlot).toBeTruthy();

    const event = createEvent.contextMenu(chartSlot!);
    fireEvent(chartSlot!, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('allows saved study views to restore trade-volume POC overlays outside the live minute gate', () => {
    expect(shouldShowTradeVolumePocOverlay('D', true, 1)).toBe(true);
    expect(shouldShowTradeVolumePocOverlay('D', true, 0)).toBe(false);
    expect(shouldShowTradeVolumePocOverlay('D', false, 1)).toBe(false);
    expect(shouldShowTradeVolumePocOverlay('1m', false, 0)).toBe(true);
  });

  it('depthHeatmap 게이트: 분봉 + enabled + 데이터 있을 때만', () => {
    expect(shouldShowDepthHeatmapOverlay('1m', true, 5)).toBe(true);
    expect(shouldShowDepthHeatmapOverlay('30m', true, 5)).toBe(true);
    expect(shouldShowDepthHeatmapOverlay('1m', false, 5)).toBe(false);
    expect(shouldShowDepthHeatmapOverlay('1m', true, 0)).toBe(false);
    expect(shouldShowDepthHeatmapOverlay('D', true, 5)).toBe(false);
    expect(shouldShowDepthHeatmapOverlay('W', true, 5)).toBe(false);
    expect(shouldShowDepthHeatmapOverlay('M', true, 5)).toBe(false);
  });

  it('depthDelta 게이트: 분봉 + enabled + 데이터 있을 때만', () => {
    expect(shouldShowDepthDeltaOverlay('1m', true, 5)).toBe(true);
    expect(shouldShowDepthDeltaOverlay('30m', true, 5)).toBe(true);
    expect(shouldShowDepthDeltaOverlay('1m', false, 5)).toBe(false);
    // 오늘 소스가 없는 뷰(과거일 전용·/study)는 pointCount 0 으로 자연히 닫힌다.
    expect(shouldShowDepthDeltaOverlay('1m', true, 0)).toBe(false);
    expect(shouldShowDepthDeltaOverlay('D', true, 5)).toBe(false);
    expect(shouldShowDepthDeltaOverlay('W', true, 5)).toBe(false);
    expect(shouldShowDepthDeltaOverlay('M', true, 5)).toBe(false);
  });

  it('creates moving-average overlays before candles when candles are always on top', async () => {
    useChartPrefsStore.getState().setToggle('candleAlwaysOnTop', true);
    const addSeries = vi.fn((_type: unknown, _options?: unknown, _paneIndex?: number) => ({
      setData: vi.fn(),
      update: vi.fn(),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      setMarkers: vi.fn(),
    }));
    const chart = {
      addSeries,
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
        scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        getVisibleLogicalRange: vi.fn(() => null),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        coordinateToTime: vi.fn(() => null),
        coordinateToLogical: vi.fn(() => null),
        timeToIndex: vi.fn(() => 0),
        width: vi.fn(() => 800),
        height: vi.fn(() => 28),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      subscribeClick: vi.fn(),
      unsubscribeClick: vi.fn(),
      chartElement: vi.fn(() => ({ clientWidth: 800, clientHeight: 400 })),
    };
    vi.mocked(createChartEx).mockReturnValueOnce(chart as never);
    const open = Date.UTC(2026, 5, 19, 0, 0, 0);
    const bundle: RangeBundle = {
      ...DEFAULT_BUNDLE,
      from_date: '20260619',
      to_date: '20260619',
      segments: [{ date: '20260619', session_open_ms: open, session_close_ms: open + 23_400_000, source: 'kiwoom_live' }],
      candles: [
        { ts_ms: open, open: 100, high: 110, low: 90, close: 105, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 60_000, open: 105, high: 115, low: 100, close: 112, vol_a: 1, vol_b: 0 },
      ],
    };

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const seriesTypes = addSeries.mock.calls.map((call) => call[0]);
    const firstMovingAverageIndex = seriesTypes.findIndex((type) => type === LineSeries);
    const candleIndex = seriesTypes.findIndex((type) => type === CandlestickSeries);
    expect(firstMovingAverageIndex).toBeGreaterThanOrEqual(0);
    expect(candleIndex).toBeGreaterThan(firstMovingAverageIndex);
  });

  it('publishes index sector basis hover dates from crosshair movement', async () => {
    let crosshairHandler: ((param: { time?: unknown; point?: { x: number } | null }) => void) | null = null;
    const chart = {
      addSeries: vi.fn(() => ({
        setData: vi.fn(),
        update: vi.fn(),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn(),
        detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
        scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        getVisibleLogicalRange: vi.fn(() => null),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        coordinateToLogical: vi.fn(() => null),
        width: vi.fn(() => 800),
        height: vi.fn(() => 28),
        timeToIndex: vi.fn(() => null),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn((handler) => { crosshairHandler = handler; }),
      unsubscribeCrosshairMove: vi.fn(),
      subscribeClick: vi.fn(),
      unsubscribeClick: vi.fn(),
    };
    vi.mocked(createChartEx).mockReturnValueOnce(chart as never);
    const onCandleBasisHover = vi.fn();
    const realMs = Date.UTC(2026, 5, 19, 0, 0, 0);
    const basisBundle: RangeBundle = {
      ...DEFAULT_BUNDLE,
      from_date: '20260619',
      to_date: '20260619',
      segments: [{ date: '20260619', session_open_ms: realMs, session_close_ms: realMs + 23400000, source: 'kiwoom_live' }],
      candles: [{ ts_ms: realMs, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
    };

    render(
      <LiveChartRoot
        code="index:KOSPI"
        timeframe="1m"
        bundle={basisBundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onCandleBasisHover={onCandleBasisHover}
      />,
      { wrapper },
    );

    expect(crosshairHandler).not.toBeNull();
    const axis = createVirtualAxis([
      { date: '20260619', sessionOpenMs: realMs, sessionCloseMs: realMs + 23400000 },
    ], realMs);
    act(() => {
      crosshairHandler?.({
        time: realMsToVirtualSeconds(axis, realMs),
        point: { x: 10 },
      });
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(onCandleBasisHover).toHaveBeenCalledWith('20260619');
  });

  it('publishes index sector basis click dates and clears on chart whitespace click', () => {
    let clickHandler: ((param: { time?: unknown; point?: { x: number } | null }) => void) | null = null;
    const chart = {
      addSeries: vi.fn(() => ({
        setData: vi.fn(),
        update: vi.fn(),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn(),
        detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
        scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        getVisibleLogicalRange: vi.fn(() => null),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        coordinateToLogical: vi.fn(() => null),
        width: vi.fn(() => 800),
        height: vi.fn(() => 28),
        timeToIndex: vi.fn(() => null),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      subscribeClick: vi.fn((handler) => { clickHandler = handler; }),
      unsubscribeClick: vi.fn(),
    };
    vi.mocked(createChartEx).mockReturnValueOnce(chart as never);
    const onCandleBasisClick = vi.fn();
    const realMs = Date.UTC(2026, 5, 19, 0, 0, 0);
    const basisBundle: RangeBundle = {
      ...DEFAULT_BUNDLE,
      from_date: '20260619',
      to_date: '20260619',
      segments: [{ date: '20260619', session_open_ms: realMs, session_close_ms: realMs + 23400000, source: 'kiwoom_live' }],
      candles: [{ ts_ms: realMs, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
    };

    render(
      <LiveChartRoot
        code="index:KOSPI"
        timeframe="1m"
        bundle={basisBundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onCandleBasisClick={onCandleBasisClick}
      />,
      { wrapper },
    );

    expect(clickHandler).not.toBeNull();
    const axis = createVirtualAxis([
      { date: '20260619', sessionOpenMs: realMs, sessionCloseMs: realMs + 23400000 },
    ], realMs);
    act(() => {
      clickHandler?.({
        time: realMsToVirtualSeconds(axis, realMs),
        point: { x: 10 },
      });
      clickHandler?.({ point: null });
    });

    expect(onCandleBasisClick).toHaveBeenNthCalledWith(1, '20260619');
    expect(onCandleBasisClick).toHaveBeenNthCalledWith(2, null);
  });

  it('clears transient hover basis when callback wiring is removed', () => {
    const onCandleBasisHover = vi.fn();
    const { rerender } = render(
      <LiveChartRoot
        code="index:KOSPI"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onCandleBasisHover={onCandleBasisHover}
      />,
      { wrapper },
    );

    rerender(
      <LiveChartRoot
        code="index:KOSPI"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );

    expect(onCandleBasisHover).toHaveBeenLastCalledWith(null);
  });

  it('passes rightmost visible candle cutoff to peak wall overlays when cutoff toggles are enabled', async () => {
    const previousAskPeakEnabled = useLivePageStore.getState().askPeakEnabled;
    const previousBidPeakEnabled = useLivePageStore.getState().bidPeakEnabled;
    const attachedPeakWallPrimitives: Array<{ segmentsForTest: () => Array<{ price: number }> }> = [];
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
      getVisibleLogicalRange: vi.fn(() => null),
      getVisibleRange: vi.fn(() => ({
        from: TODAY_OPEN_MS / 1000,
        to: (TODAY_OPEN_MS + 120_000) / 1000,
      })),
      options: vi.fn(() => ({ barSpacing: 12 })),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
      coordinateToTime: vi.fn(() => null),
      coordinateToLogical: vi.fn(() => null),
      timeToIndex: vi.fn(() => 0),
      width: vi.fn(() => 800),
      height: vi.fn(() => 28),
    };
    const makeSeries = (chart: {
      timeScale: () => typeof ts;
    }) => {
      const series = {
        setData: vi.fn(),
        update: vi.fn(),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        priceToCoordinate: vi.fn((price: number) => price),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn((primitive: {
          attached?: (param: unknown) => void;
          segmentsData?: () => Array<{ price: number }>;
        }) => {
          primitive.attached?.({ chart, series, requestUpdate: vi.fn() });
          attachedPeakWallPrimitives.push({
            segmentsForTest: () => primitive.segmentsData?.() ?? [],
          });
        }),
        detachPrimitive: vi.fn((primitive: { detached?: () => void }) => {
          primitive.detached?.();
        }),
        setMarkers: vi.fn(),
      };
      return series;
    };
    const chart = {
      addSeries: vi.fn(),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ts),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      subscribeClick: vi.fn(),
      unsubscribeClick: vi.fn(),
      chartElement: vi.fn(() => ({ clientWidth: 800, clientHeight: 400 })),
    };
    chart.addSeries.mockImplementation(() => makeSeries(chart));
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    useChartPrefsStore.getState().setToggle('askPeakVisibleTimeCutoff', true);
    useChartPrefsStore.getState().setToggle('bidPeakVisibleTimeCutoff', true);
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });

    const candles = [
      { ts_ms: TODAY_OPEN_MS, open: 100, high: 101, low: 100, close: 100, vol_a: 1, vol_b: 0 },
      { ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 100, close: 100, vol_a: 1, vol_b: 0 },
      { ts_ms: TODAY_OPEN_MS + 120_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
    ];
    const bundle: RangeBundle = {
      ...TODAY_ONLY_BUNDLE,
      from_date: '20260527',
      to_date: '20260527',
      candles,
      ask_peaks: [{
        date: '20260527',
        price: 100,
        qty: 100,
        t_ms: TODAY_OPEN_MS + 60_000,
        max_price: 100,
        max_qty: 100,
        max_t_ms: TODAY_OPEN_MS + 60_000,
        traded_peaks: [
          { price: 100, qty: 100, t_ms: TODAY_OPEN_MS + 60_000 },
          { price: 101, qty: 900, t_ms: TODAY_OPEN_MS + 180_000 },
        ],
      }],
    };

    try {
      render(
        <LiveChartRoot
          code="005930"
          timeframe="1m"
          bundle={bundle}
          chartBundle={bundle}
          clampEngaged={false}
          isPastCandlesLoading={false}
          todayKst="20260527"
          dayAskPeaks={bundle.ask_peaks}
          dayBidPeaks={[{
            date: '20260527',
            price: 99,
            qty: 90,
            t_ms: TODAY_OPEN_MS + 60_000,
            max_price: 99,
            max_qty: 90,
            max_t_ms: TODAY_OPEN_MS + 60_000,
          }]}
        />,
        { wrapper },
      );

      await waitFor(() => expect(attachedPeakWallPrimitives.length).toBeGreaterThanOrEqual(2));
      const renderedPrices = attachedPeakWallPrimitives.flatMap((primitive) =>
        primitive.segmentsForTest().map((segment) => segment.price));
      expect(renderedPrices).toContain(100);
      expect(renderedPrices).toContain(99);
      expect(renderedPrices).not.toContain(101);
      expect(renderedPrices).not.toContain(98);
    } finally {
      useLivePageStore.setState({
        askPeakEnabled: previousAskPeakEnabled,
        bidPeakEnabled: previousBidPeakEnabled,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Initial-view application across (code, timeframe) and candle-count growth.
  //
  // Regression: on D/W/M the daily endpoint returns a small initial fetch
  // (~14 bars for 20 days) and then a much larger extension fetch (~250
  // bars for 250 days). Without re-fitting when the count grows, the chart
  // stays zoomed on the early window and the latest data ends up off the
  // right edge — the exact symptom the user hit on watchlist clicks in D.
  // ─────────────────────────────────────────────────────────────────────────

  function makeCandles(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      ts_ms: TODAY_OPEN_MS + i * 60_000,
      open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0,
    }));
  }

  function makeBundleWithCandles(n: number): RangeBundle {
    return { ...TODAY_ONLY_BUNDLE, candles: makeCandles(n) };
  }

  function kstDateFromMsForTest(ms: number): string {
    const d = new Date(ms + 9 * 3600_000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  function makeDailyCalendarBundle(n: number): RangeBundle {
    const dayMs = 86_400_000;
    const sessionLen = 6.5 * 3600_000;
    const segments = Array.from({ length: n }, (_, i) => {
      const open = TODAY_OPEN_MS + i * dayMs;
      return {
        date: kstDateFromMsForTest(open),
        session_open_ms: open,
        session_close_ms: open + sessionLen,
        source: 'kiwoom_live' as const,
      };
    });
    const candles = segments.map((s) => ({
      ts_ms: s.session_open_ms,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      vol_a: 1,
      vol_b: 0,
    }));
    return {
      ...TODAY_ONLY_BUNDLE,
      from_date: segments[0]?.date ?? TODAY_ONLY_BUNDLE.from_date,
      to_date: segments[segments.length - 1]?.date ?? TODAY_ONLY_BUNDLE.to_date,
      segments,
      candles,
    };
  }

  function buildChartMockWithStableTS() {
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
      getVisibleLogicalRange: vi.fn((): { from: number; to: number } | null => null),
      getVisibleRange: vi.fn((): { from: number; to: number } | null => null),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
      coordinateToLogical: vi.fn((): number | null => null),
      width: vi.fn(() => 800),
      height: vi.fn(() => 28),
      timeToIndex: vi.fn((): number | null => null),
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
    return { chart, ts };
  }

  it('D timeframe: applies an adaptive legible range when candle count changes', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(14)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 14 + RIGHT_OFFSET });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(250)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Count growth from placeholder/extension must re-window so the extended
    // daily history stays legible instead of letting fitContent settle twice.
    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 250 + RIGHT_OFFSET - 228, to: 250 + RIGHT_OFFSET });

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(80)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Shrink still re-windows; otherwise a placeholder/wider previous calendar
    // response can leave the D chart at stale spacing.
    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 80 + RIGHT_OFFSET });
  });

  it('D timeframe: caps a long daily history by pane width so bodies do not collapse', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    ts.width.mockReturnValue(628);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(464)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.fitContent).not.toHaveBeenCalled();
    // 628px / 3.5px = 179 logical bars. fitContent would ask lightweight-charts
    // to settle all 464 daily bars, which is the visible jump users report.
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 464 + RIGHT_OFFSET - 179, to: 464 + RIGHT_OFFSET });
  });

  it('D timeframe: re-applies the daily window after an initially narrow time scale width', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    // 폭은 **상태 변수**로 준다 — `mockReturnValueOnce(24).mockReturnValue(800)` 는
    // "첫 **호출자**가 24 를 받는다" 는 뜻이라, 같은 트리의 다른 컴포넌트가
    // `timeScale().width()` 를 읽기 시작하면 좁은 값이 엉뚱한 곳으로 새고 이 테스트가
    // 무관한 변경에 깨진다(2026-08-18, PaneLegendOverlay 가 pane 우측 정렬을 위해
    // 폭을 읽으면서 실제로 그랬다). 재고 싶은 것은 호출 순서가 아니라 "처음엔 좁고
    // 다음 렌더엔 넓다" 는 **상태**다.
    let timeScaleWidth = 24;
    ts.width.mockImplementation(() => timeScaleWidth);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(60)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).not.toHaveBeenCalled();

    timeScaleWidth = 800;
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(60)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 60 + RIGHT_OFFSET });
  });

  it('D timeframe: keeps the daily viewport contiguous when raw segment dates are sparse', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    ts.timeToIndex
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(649);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(60)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 60 + RIGHT_OFFSET });
  });

  it('D timeframe: captures the actual live-edge viewport without daily clamping', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    const bundle = makeDailyCalendarBundle(250);
    const last = bundle.candles[bundle.candles.length - 1];
    let capture: () => unknown = () => null;
    ts.getVisibleLogicalRange.mockReturnValue({ from: 100, to: 178.25 });
    ts.getVisibleRange.mockReturnValue({ from: TODAY_OPEN_MS / 1000, to: last.ts_ms / 1000 });
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onViewportCaptureReady={(fn) => { capture = fn; }}
      />,
      { wrapper },
    );

    expect(capture()).toMatchObject({ barSpan: 78.25, atLiveEdge: true });
  });

  it('does not invent live-edge right padding when timeToIndex is not settled and no stable index is known', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    const bundle = makeDailyCalendarBundle(250);
    const last = bundle.candles[bundle.candles.length - 1];
    let capture: () => unknown = () => null;
    ts.getVisibleLogicalRange.mockReturnValue({ from: 200, to: 278.25 });
    ts.getVisibleRange.mockReturnValue({ from: TODAY_OPEN_MS / 1000, to: last.ts_ms / 1000 });
    ts.timeToIndex.mockReturnValue(null);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onViewportCaptureReady={(fn) => { capture = fn; }}
      />,
      { wrapper },
    );

    expect(capture()).toMatchObject({
      barSpan: 78.25,
      atLiveEdge: true,
    });
    expect(capture()).not.toHaveProperty('rightPaddingBars');
  });

  it('reuses the last stable latest-candle logical index when capture timeToIndex is temporarily unsettled', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    const bundle = makeDailyCalendarBundle(250);
    const last = bundle.candles[bundle.candles.length - 1];
    let capture: () => unknown = () => null;
    ts.getVisibleLogicalRange.mockReturnValue({ from: 200, to: 291 });
    ts.getVisibleRange.mockReturnValue({ from: TODAY_OPEN_MS / 1000, to: last.ts_ms / 1000 });
    ts.timeToIndex.mockReturnValue(260);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onViewportCaptureReady={(fn) => { capture = fn; }}
      />,
      { wrapper },
    );
    expect(capture()).toMatchObject({ rightPaddingBars: 30 });

    ts.timeToIndex.mockReturnValue(null);

    expect(capture()).toMatchObject({ rightPaddingBars: 30 });
  });

  it('reuses the initial viewport latest-candle index when the first live-tab capture is unsettled', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    const bundle = makeBundleWithCandles(250);
    const last = bundle.candles[bundle.candles.length - 1];
    let capture: () => unknown = () => null;
    ts.getVisibleLogicalRange.mockReturnValue({ from: 200, to: 291 });
    ts.getVisibleRange.mockReturnValue({ from: TODAY_OPEN_MS / 1000, to: last.ts_ms / 1000 });
    ts.timeToIndex.mockReturnValue(260);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onViewportCaptureReady={(fn) => { capture = fn; }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(ts.setVisibleLogicalRange).toHaveBeenCalled());
    ts.timeToIndex.mockReturnValue(null);

    expect(capture()).toMatchObject({ rightPaddingBars: 30 });
  });

  it('D timeframe: marks captures as user-adjusted after wheel viewport changes', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    const bundle = makeDailyCalendarBundle(250);
    const last = bundle.candles[bundle.candles.length - 1];
    let capture: () => unknown = () => null;
    ts.getVisibleLogicalRange.mockReturnValue({ from: 242, to: 255 });
    ts.getVisibleRange.mockReturnValue({ from: TODAY_OPEN_MS / 1000, to: last.ts_ms / 1000 });
    ts.coordinateToLogical.mockReturnValue(248);
    ts.timeToIndex.mockReturnValue(249);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { container } = render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onViewportCaptureReady={(fn) => { capture = fn; }}
      />,
      { wrapper },
    );

    act(() => {
      container.querySelector('[data-testid="live-chart-root"]')!.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -160,
          clientX: 400,
          clientY: 120,
        }),
      );
    });

    expect(capture()).toEqual({
      rightEdgeMs: last.ts_ms,
      // 좌측 끝도 실데이터에 앵커된다(위 getVisibleRange mock 의 from).
      leftEdgeMs: TODAY_OPEN_MS,
      barSpan: 13,
      atLiveEdge: true,
      rightPaddingBars: 5,
      userAdjusted: true,
    });
  });

  it('D timeframe: replaces candle data fully when the latest daily OHLC changes', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const candleSeries = {
      setData: vi.fn(),
      update: vi.fn(),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      setMarkers: vi.fn(),
    };
    const { chart } = buildChartMockWithStableTS();
    chart.addSeries.mockImplementationOnce(() => candleSeries);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);
    const first = makeBundleWithCandles(2);
    const next: RangeBundle = {
      ...first,
      candles: [
        first.candles[0],
        { ...first.candles[1], close: first.candles[1].close + 1, high: first.candles[1].high + 1 },
      ],
    };

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={first}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    candleSeries.setData.mockClear();
    candleSeries.update.mockClear();

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={next}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );

    expect(candleSeries.update).not.toHaveBeenCalled();
    expect(candleSeries.setData).toHaveBeenCalledTimes(1);
  });

  it('1m timeframe: setVisibleLogicalRange applied once even as bars grow (SSE pushes preserved)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(105)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Minute path stays "apply once" — SSE pushes inside today must not
    // snap the user's scroll back to the right edge.
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
  });

  it('1m timeframe: one-shot coverage restore re-extends historicalFromDate right after initial placement', () => {
    // 분봉→D/W/M→분봉 복귀: setCandleTimeframe이 남긴 lastMinuteHistoricalFromDate를
    // 초기 뷰 배치 직후 extendHistoricalRange로 1-샷 복원한다. 배치(setVisibleLogicalRange)가
    // 먼저고 확장이 나중 — "fresh 로드 = historicalFromDate null" 게이트와 경합하지 않는다.
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: '20250712',
    });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(useLivePageStore.getState().historicalFromDate).toBe('20250712');
  });

  it('1m timeframe: activeCode mismatch blocks the coverage restore (study-mount guard)', () => {
    // StudyPage 등 다른 마운트의 분봉 배치가 live store를 extend하지 못하도록,
    // 복원 dispatch는 activeCode === code 엄격 동등일 때만 발화한다.
    useLivePageStore.setState({
      activeCode: '000660',
      candleTimeframe: '1m',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: '20250712',
    });
    const { chart } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    expect(useLivePageStore.getState().lastMinuteHistoricalFromDate).toBe('20250712');
  });

  // Regression guard for the canvas font. CHART_LAYOUT_OPTIONS used to be spread
  // at the chart-options ROOT rather than under `layout`, so lightweight-charts
  // ignored it entirely and the axis kept the library's own font stack through
  // the 2026-07-15 density dial and both font migrations. chartScale.test.ts
  // passed the whole time — it asserts the constant's value, and the value was
  // never wrong, it just never arrived. So assert the NESTING here.
  it('passes canvas font options under layout, not at the chart-options root', () => {
    const { chart } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    const options = vi.mocked(createChartEx).mock.calls.at(-1)?.[2] as
      | { layout?: { fontFamily?: string; fontSize?: number }; fontFamily?: string; fontSize?: number }
      | undefined;
    expect(options?.layout?.fontFamily).toBe(CHART_LAYOUT_OPTIONS.fontFamily);
    expect(options?.layout?.fontSize).toBe(CHART_LAYOUT_OPTIONS.fontSize);
    // Root placement is the bug being guarded — these must stay undefined.
    expect(options?.fontFamily).toBeUndefined();
    expect(options?.fontSize).toBeUndefined();
  });

  // 어트리뷰션 로고는 lightweight-charts 가 메인 페인에 직접 심는 앵커라
  // 기본값 true 를 옵션으로 명시해 꺼야만 사라진다(CSS 로 덮는 것이 아니다).
  // jsdom 은 캔버스를 그리지 않아 로고 자체를 볼 수 없으므로, 위 폰트 회귀와
  // 같은 이유로 옵션이 `layout` 아래로 도착하는지를 잰다 — 값이 맞아도 닿지
  // 않으면 무의미하다. 로고의 실제 부재는 실브라우저에서만 확인된다.
  it('disables the TradingView attribution logo under layout', () => {
    const { chart } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    const options = vi.mocked(createChartEx).mock.calls.at(-1)?.[2] as
      | { layout?: { attributionLogo?: boolean } }
      | undefined;
    expect(options?.layout?.attributionLogo).toBe(false);
  });

  // Crosshair axis-label chips (2026-08-10). lightweight-charts 5.2.0 defaults
  // BOTH labels to `#131722` and we only overrode `mode`, so the chip shipped
  // theme-blind: measured against our chart background that is 1.04:1 on
  // Obsidian and 1.00:1 on Toss Dark — the chip was indistinguishable from the
  // canvas. These labels are the only value readout on the chart (DESIGN.md
  // 2026-05-23 turned off priceLineVisible/lastValueVisible everywhere), so the
  // guard asserts the token ARRIVES, not just that the helper returns it —
  // chartScale.test.ts already covers the helper, and a correct constant that
  // never reaches the canvas is exactly how the font bug above survived.
  function readCrosshairLabelColors() {
    const options = vi.mocked(createChartEx).mock.calls.at(-1)?.[2] as
      | {
          crosshair?: {
            vertLine?: { labelBackgroundColor?: string };
            horzLine?: { labelBackgroundColor?: string };
          };
        }
      | undefined;
    return {
      time: options?.crosshair?.vertLine?.labelBackgroundColor,
      price: options?.crosshair?.horzLine?.labelBackgroundColor,
    };
  }

  it('paints both crosshair axis labels with the live --accent token', () => {
    // 테마 이름을 유니크하게 둔다 — resolveTokensThemed 는 (spec, theme) 로
    // 캐시하므로 다른 테스트가 채운 'obsidian' 항목을 건드리지 않는다.
    document.documentElement.style.setProperty('--accent', '#3182f6');
    document.documentElement.setAttribute('data-theme', 'test-crosshair-chip');
    try {
      const { chart } = buildChartMockWithStableTS();
      vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

      render(
        <LiveChartRoot
          code="005930"
          timeframe="1m"
          bundle={makeBundleWithCandles(100)}
          clampEngaged={false}
          isPastCandlesLoading={false}
        />,
        { wrapper },
      );

      const { time, price } = readCrosshairLabelColors();
      expect(time).toBe('#3182f6');
      expect(price).toBe('#3182f6');
      // The library default. Seeing it again means the token never arrived —
      // either the option was dropped or only one axis got it.
      expect(time).not.toBe('#131722');
      expect(price).not.toBe('#131722');
    } finally {
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.removeAttribute('data-theme');
    }
  });

  it('re-resolves the crosshair chip when the theme swaps mid-mount', () => {
    // 이 옵션이 모듈 상수였다면 앱 부팅 시점 테마에 얼어붙는다(chartScale.ts
    // 헤더의 경고). 재해석은 viewKey 의 테마 세그먼트가 차트를 remount 시키는
    // 것에 의존하므로, 그 연결이 끊기면 여기서 걸린다.
    document.documentElement.style.setProperty('--accent', '#f0b429');
    document.documentElement.setAttribute('data-theme', 'test-crosshair-a');
    try {
      const before = vi.mocked(createChartEx).mock.calls.length;
      vi.mocked(createChartEx).mockImplementationOnce(
        () => buildChartMockWithStableTS().chart as never,
      );
      const props = {
        code: '005930',
        timeframe: '1m' as const,
        bundle: makeBundleWithCandles(100),
        clampEngaged: false,
        isPastCandlesLoading: false,
      };
      const { rerender } = render(<LiveChartRoot {...props} />, { wrapper });
      expect(readCrosshairLabelColors().price).toBe('#f0b429');

      document.documentElement.style.setProperty('--accent', '#3182f6');
      document.documentElement.setAttribute('data-theme', 'test-crosshair-b');
      vi.mocked(createChartEx).mockImplementationOnce(
        () => buildChartMockWithStableTS().chart as never,
      );
      rerender(<LiveChartRoot {...props} />);

      expect(vi.mocked(createChartEx).mock.calls.length).toBe(before + 2);
      const { time, price } = readCrosshairLabelColors();
      expect(time).toBe('#3182f6');
      expect(price).toBe('#3182f6');
    } finally {
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.removeAttribute('data-theme');
    }
  });

  it('1m timeframe: no remembered window → historicalFromDate stays null after placement', () => {
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: null,
    });
    const { chart } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('D timeframe: the calendar branch never dispatches the minute coverage restore', () => {
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: 'D',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: '20250712',
    });
    const { chart } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeDailyCalendarBundle(30)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    // 기억 자체는 소모되지 않는다 — 분봉 복귀 시 쓰인다.
    expect(useLivePageStore.getState().lastMinuteHistoricalFromDate).toBe('20250712');
  });

  it('1m timeframe: initial apply includes pixel-safe right whitespace', () => {
    // The live edge should look like W/M: latest candle visible with an empty
    // band to its right. The range owns that padding directly instead of
    // scrollToPosition(0), which snaps the candle tight to the right edge.
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 130 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('minute timeframes: widen live-edge whitespace enough to clear the right axis labels', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    ts.width.mockReturnValue(1495);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(400)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 100, to: 442 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('10m timeframe: uses the same pixel-gutter policy as 1m', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    ts.width.mockReturnValue(1495);
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="10m"
        bundle={makeBundleWithCandles(400)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 100, to: 442 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('1m timeframe: UN initial view keeps the standard 300-bar viewport', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        venue="UN"
        bundle={makeBundleWithCandles(900)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 600, to: 988 });
  });

  it('1m timeframe: code change re-applies setVisibleLogicalRange with new count', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    // A code switch is a viewKey change, which REMOUNTS the chart (cross-view
    // staleness guard) — so the new count's viewport must land on the SECOND
    // chart instance, while the first keeps only its own initial placement.
    const first = buildChartMockWithStableTS();
    const second = buildChartMockWithStableTS();
    vi.mocked(createChartEx)
      .mockImplementationOnce(() => first.chart as never)
      .mockImplementationOnce(() => second.chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(first.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 130 });

    // Watchlist switch: new code, new (smaller-or-larger) bundle. The fresh
    // chart instance must receive the new code's 300-bar window — and the
    // removed instance must NOT be touched again (keyed chart entry).
    rerender(
      <LiveChartRoot
        code="000660"
        timeframe="1m"
        bundle={makeBundleWithCandles(400)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    expect(second.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 100, to: 488 });
    expect(first.ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cold-load reveal cover (/diagnose 2026-06-05).
  //
  // Bug: on a cold load the hoga panes resolve ~2.5s before the candles and
  // establish lightweight-charts' default ~60-bar fit on the shared timeScale;
  // when the candles land the initial-view effect re-applies the 300-bar window,
  // but lwc paints the visible-WIDTH change one frame late, so the candles flash
  // in zoomed to ~60 bars then zoom out to ~300 (the "drawn twice" feeling).
  // Fix: keep an opaque cover over the chart from the (code, timeframe) switch
  // until two rAFs after the viewport is applied, then fade it out.
  // ─────────────────────────────────────────────────────────────────────────

  // Run N animation frames, flushing React after each so a setState inside a
  // nested rAF is committed to the DOM before we assert.
  async function flushFrames(n: number) {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    }
  }

  it('mounts an opaque reveal cover before the viewport settles', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const cover = screen.getByTestId('chart-reveal-cover');
    // Synchronously after mount the reveal rAFs have NOT fired yet → opaque.
    expect(cover.style.opacity).toBe('1');
  });

  it('paints the cover above the chart pane content (z-index guard)', () => {
    // Load-bearing: lightweight-charts canvases paint at z-index 1 and pane
    // overlays at 4–20, so a default `auto` cover masks nothing (verified via
    // /browse 2026-07-08 — the hoga panes bled through as the cold-load desync).
    // The cover must stay above all pane content (≤20) and below the drawing
    // toolbar (z:49-50). This guards against a regression that silently
    // un-masks the reveal.
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const z = Number(screen.getByTestId('chart-reveal-cover').style.zIndex);
    expect(z).toBeGreaterThan(20);
    expect(z).toBeLessThan(49);
  });

  it('fades the cover out (opacity 0) two rAFs after the initial viewport is applied', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('keeps the cover opaque while past candles are still loading (no candles yet)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(0)}
        clampEngaged={false}
        isPastCandlesLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // Candles still loading → the reveal must wait, cover stays opaque so the
    // user never sees the candle pane paint at the wrong zoom.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
  });

  it('reveals the empty chart once the candle fetch settles with no candles', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(0)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // No candles but loading settled → reveal so the cover doesn't linger over
    // an empty (but legitimately data-less) chart.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('reveals when the load settles with a null bundle (cover must not wedge opaque)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={null}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // Null bundle + settled fetch → no data is pending, so reveal rather than
    // leave the cover stuck over a chartless surface.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('keeps the cover opaque while a null-bundle load is still in flight', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={null}
        clampEngaged={false}
        isPastCandlesLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // Still loading → hold the cover so the candles can't appear at the wrong zoom.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
  });

  it('reveals on a cold restore of a scrolled-back tab without a saved viewport (historicalFromDate gate)', async () => {
    // Regression (ADR-0069 A안 side-fix): the historicalFromDate gate in the
    // initial-view effect used to `return` WITHOUT reveal(). Switching back to a
    // tab that had panned past history (hfd != null) but carries NO saved
    // viewport — a migrated tab, or one whose viewport was cleared by a
    // timeframe change — left the opaque cover wedged over a fully-drawn chart.
    // The fix reveals unconditionally on that gate (reveal() is idempotent, so an
    // in-session pan where the chart is already revealed is a harmless no-op).
    useLivePageStore.setState({ historicalFromDate: '20260601' }); // scrolled-back tab
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  // 데이터 홀드: 캔들이 먼저 도착해도 호가 경로가 settle될 때까지 reveal을 홀드해
  // 캔들+호가 pane이 한 번의 reveal로 등장하게 한다(초기 로드/전환).
  it('holds the cover while the hoga path is still loading (candles present)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // 캔들은 도착했지만 호가 미도착 → 커버 유지 + 호가 홀드 노트 표시.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
    expect(screen.getByTestId('hoga-loading-note').textContent).toContain('지표 불러오는 중');
  });

  it('reveals once the hoga path settles (candles already present)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
      />,
    );
    await flushFrames(3);
    // 호가 settle → reveal, 홀드 노트 소멸.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
    expect(screen.queryByTestId('hoga-loading-note')).toBeNull();
  });

  // 개선안 1-A: 사이드카 지표(최대벽·POC·거래량분포·프로그램매매)도 캔들과 한 번의
  // reveal로 등장하도록 홀드. 캔들·호가가 settle돼도 사이드카가 아직이면 커버 유지.
  it('holds the cover while the sidecar path is still loading (candles+hoga settled)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
        isSidecarLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
    // 커버가 떠 있으면 **왜 떠 있는지도 보여야 한다.** 종전엔 문구 게이트가 `isHogaLoading`
    // 만 봐서 이 조성(호가 settle · 사이드카 pending)에서 글자 없는 단색 사각형이 됐다.
    // 실측으로 사이드카는 호가보다 두 자릿수 느리다(콜드 44ms vs 4.68s) — 즉 종목 첫
    // 방문에서 사용자가 실제로 오래 보는 화면이 바로 이 조성이다.
    // 위 테스트 셋이 opacity 만 재고 문구는 안 봤기 때문에 결함이 숨어 있었다.
    expect(screen.getByTestId('hoga-loading-note').textContent).toContain('지표 불러오는 중');
  });

  it('reveals once the sidecar path settles (candles+hoga already present)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
        isSidecarLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
        isSidecarLoading={false}
      />,
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
    // 문구도 함께 사라진다 — 넓힌 술어가 revealed 차트 위에 글자를 남기지 않는지 확인.
    expect(screen.queryByTestId('hoga-loading-note')).toBeNull();
  });

  it('사이드카가 늦으면 캡 경과 후 캔들을 먼저 공개한다 (SIDECAR_REVEAL_CAP_MS)', async () => {
    // 막는 방향: 사이드카 하나가 늦다고 캔들이 **무기한** 인질이 되는 쪽.
    // #579 는 이 캡을 제거했고("기다림 > 따로 뜸"), 그 근거는 사이드카 실측 220ms 였다.
    // 그 전제가 뒤에 반박됐다(콜드 5거래일 4.68s, 한 달 창 11.7s) → 2026-08-19 캡 복원.
    // 근거 전문은 LiveChartRoot 의 SIDECAR_REVEAL_CAP_MS 주석.
    //
    // 못 보는 것: 캡 **값**(700ms)이 적절한지는 이 테스트가 말하지 않는다. 캡 이전에
    // 홀드하고 이후에 열린다는 **분기**만 고정한다.
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
        isSidecarLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // 캡 이전: 사이드카를 기다리며 홀드 — 빠른 경로의 "한 장면 등장" 이 여기서 성립한다.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
    // 캡 경과: 사이드카는 **여전히 loading 인 채**로 커버가 걷혀야 한다.
    // 벽시계 상수로 단언하지 않는다 — 캡(700ms) 소진은 실타이머로 흘려보내되,
    // 이후 rAF 2틱이 필요한 reveal 은 waitFor 로 기다린다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SIDECAR_REVEAL_CAP_MS + 100));
    });
    await waitFor(() =>
      expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0'),
    );
    // 캡으로 열렸으므로 지표 문구도 함께 사라진다(!chartReady 가드) — 걷힌 차트 위에
    // "지표 불러오는 중…" 이 남으면 안 된다.
    expect(screen.queryByTestId('hoga-loading-note')).toBeNull();
  });

  it('캡은 viewKey 마다 리셋된다 — 이전 뷰의 소진이 새 종목을 조기 공개하지 않는다', async () => {
    // 캡 상태가 뷰를 넘어 새면, 한 번 늦은 종목을 본 뒤로는 **모든** 종목이 캡 없이
    // 즉시 열려 "한 장면 등장" 이 영구히 깨진다. 리셋이 그걸 막는 유일한 장치다.
    useLivePageStore.setState({ historicalFromDate: null });
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
        isSidecarLoading={true}
      />,
      { wrapper },
    );
    // 첫 뷰에서 캡을 소진시킨다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SIDECAR_REVEAL_CAP_MS + 100));
    });
    await waitFor(() =>
      expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0'),
    );
    // 종목 전환 = 새 viewKey. 사이드카는 여전히 loading 이다.
    rerender(
      <LiveChartRoot
        code="000660"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
        isSidecarLoading={true}
      />,
    );
    await flushFrames(3);
    // 새 뷰는 자기 캡을 처음부터 다시 센다 → 지금은 홀드여야 한다.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
  });

  it('holds an empty-candle chart until the hoga path also settles', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(0)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // 캔들 settle(0개)이어도 호가 pending이면 커버 유지.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(0)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={false}
      />,
    );
    await flushFrames(3);
    // 호가도 settle → 신규상장 등 데이터 없는 코드도 reveal(커버가 wedge되지 않게).
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('does not gate the reveal on a panned view (historicalFromDate set), even while hoga loads', async () => {
    // 팬 경로는 이미 과거를 보고 있는 뷰라 데이터 홀드 대상이 아니다 — reveal 즉시.
    useLivePageStore.setState({ historicalFromDate: '20260601' });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isHogaLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  // (c) /diagnose 2026-06-09 후속: rate-limit/부분로딩 상태 표시. 백엔드 data_warnings를
  // 살려 빈칸 문구 전환 + 부분로딩 칩으로 "고장?" 오해를 없앤다.
  // ADR-0143: 유량 판정 축이 사유 문자열 → 백엔드가 실은 `kind` 로 바뀌었다.
  // 픽스처도 wire 가 실제로 내려보내는 모양을 쓴다.
  const RL_WARNINGS = [
    { reason: 'rate_limit_upstream', kind: 'rate_limit' as const, msg: 'rate limit' },
  ];

  it('캔들 없음 + rate-limit 경고 → 빈칸 노트가 한도 문구로 전환', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(0)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={RL_WARNINGS} />,
      { wrapper },
    );
    expect(screen.getByTestId('past-candles-loading-note').textContent).toContain('호출 한도');
  });

  it('캔들 없음 + 로딩 중 + 경고 없음 → 기존 "분봉 불러오는 중…"', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(0)}
        clampEngaged={false} isPastCandlesLoading={true} />,
      { wrapper },
    );
    expect(screen.getByTestId('past-candles-loading-note').textContent).toContain('분봉 불러오는 중');
  });

  it('캔들 없음 + 로딩 아님 + 경고 없음 → 노트 없음(정말 데이터 없음)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(0)}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    expect(screen.queryByTestId('past-candles-loading-note')).toBeNull();
  });

  it('캔들 있음 + 경고 있음 → 부분로딩 칩 표시', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={RL_WARNINGS} />,
      { wrapper },
    );
    expect(screen.getByTestId('partial-load-chip').textContent).toContain('일부 과거구간');
  });

  it('부분로딩 칩 title 에 벤더 원문이 실린다(원인이 화면에서 닿아야 한다)', () => {
    // 칩 문구는 rate-limit 여부 2분류라 원인이 안 보인다. 키움 토큰이 벤더 측에서
    // 무효화(8005)돼 과거 캔들이 통째로 멎었을 때 화면만으로는 진단이 불가능했다
    // (2026-08-04). 그때 필요했던 문자열이 여기 실려야 한다.
    useLivePageStore.setState({ historicalFromDate: null });
    const warnings = [
      { reason: 'api_error', msg: '인증에 실패했습니다[8005:Token이 유효하지 않습니다]' },
    ];
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={warnings} />,
      { wrapper },
    );
    const chip = screen.getByTestId('partial-load-chip');
    expect(chip.getAttribute('title')).toContain('8005');
    expect(chip.textContent).toContain('실패');
    expect(chip.style.pointerEvents).toBe('auto');
  });

  it('캔들 있음 + 경고 없음 → 부분로딩 칩 미표시(회귀가드)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={[]} />,
      { wrapper },
    );
    expect(screen.queryByTestId('partial-load-chip')).toBeNull();
  });

  it('clamp + 부분로딩 동시 → 두 칩 모두 표시(bottom-left 스택)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={true} isPastCandlesLoading={false} pastDataWarnings={RL_WARNINGS} />,
      { wrapper },
    );
    expect(screen.getByTestId('partial-load-chip')).toBeTruthy();
    expect(screen.getByTestId('clamp-engaged-chip')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Lazy fetch trigger — eng review C2/C3 regression coverage
// ---------------------------------------------------------------------------

// 2026-05-27 00:00 UTC = 09:00 KST (matches the buildLiveBundle test convention).
const TODAY_OPEN_MS = Date.UTC(2026, 4, 27, 0, 0, 0);
const TODAY_CLOSE_MS = TODAY_OPEN_MS + 6.5 * 3600 * 1000;
const YESTERDAY_OPEN_MS = TODAY_OPEN_MS - 86_400_000;
const YESTERDAY_CLOSE_MS = YESTERDAY_OPEN_MS + 6.5 * 3600 * 1000;

// NOTE: these two fixtures carry a candle each. The lazy-fetch trigger (3b) and
// settle-loop (3a) only run once data has loaded (candleCountRef guard, /diagnose
// 2026-06-09) — pan/fill are behaviors of a POPULATED chart. An empty-candle
// bundle exercises the cold-load guard instead; the dedicated "no candles loaded
// yet" tests below use { ...BUNDLE, candles: [] } for that.
const TODAY_ONLY_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kiwoom_live' },
  ],
  candles: [{ ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 }],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

const TWO_SEGMENT_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260526',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260526', session_open_ms: YESTERDAY_OPEN_MS, session_close_ms: YESTERDAY_CLOSE_MS, source: 'kiwoom_live' },
    { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kiwoom_live' },
  ],
  candles: [
    { ts_ms: YESTERDAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
    { ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
  ],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

describe('LiveChartRoot lazy fetch trigger', () => {
  beforeEach(() => {
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      historicalFromDate: null,
      lastMinuteHistoricalFromDate: null,
    });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT fire extendHistoricalRange when logical from is inside loaded data', () => {
    // logical.from >= 0 means the visible-range origin is inside loaded
    // bars — no extension needed.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    expect(handlers.length).toBeGreaterThan(0);
    act(() => {
      handlers.forEach((h) => h({ from: 10.5, to: 200.5 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('does NOT fire extendHistoricalRange when multi-segment axis is still inside loaded bars', () => {
    // Yesterday (today - 1) is comfortably inside the 20-day initial window,
    // so scrolling there is already covered by the seeded fetch and must NOT
    // trigger an additional extension.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: 1000, to: 2000 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('fires extendHistoricalRange with one chunk past current earliest when logical from goes negative', () => {
    // Axis with yesterday + today. lightweight-charts emits negative
    // logical.from when the visible-range origin is past the leftmost
    // loaded bar (fractional bar index can go negative beyond the data).
    // Handler should prepend one step of STEP_TRADING_DAYS['1m']=5 trading days,
    // weekend-skipped (subtractWeekdaysKst) — one backend date-parallel batch.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    // Negative fractional logical = viewport past leftmost loaded bar.
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // currentEarliest = '20260526'(화), minus 5 trading days → '20260519'(화).
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260519');
  });

  it('does NOT fire extendHistoricalRange before any candle has loaded (cold-load empty chart)', () => {
    // Regression (/diagnose 2026-06-09): a still-loading chart has zero candles
    // but a today-session axis, so lwc reports a NEGATIVE visible logical `from`
    // (no bars to clamp the origin). Without the candleCountRef guard the trigger
    // misreads this as "panned past the leftmost bar" and walks
    // historicalFromDate to the 250-day clamp, spamming uncached past-candles
    // fetches that never settle → permanent blank chart. With data loaded the
    // SAME `from` legitimately extends (test above); with NO data it must not.
    const emptyBundle = { ...TWO_SEGMENT_BUNDLE, candles: [] };
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={emptyBundle}
        clampEngaged={false}
        isPastCandlesLoading={true}
      />,
      { wrapper },
    );

    expect(handlers.length).toBeGreaterThan(0);
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('does NOT fire extendHistoricalRange before the initial viewport has been applied', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const chart = buildChartMockCapturing(handlers) as any;
    const ts = chart.timeScale();
    ts.subscribeVisibleLogicalRangeChange = vi.fn((h: (r: unknown) => void) => {
      handlers.push(h);
      h({ from: -50.3, to: 100.7 });
    });
    vi.mocked(createChartEx).mockImplementationOnce(() => chart);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    expect(ts.setVisibleLogicalRange).toHaveBeenCalled();
  });

  it('does NOT apply a stale backfill debounce after the timeframe changed', () => {
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);
    useLivePageStore.setState({ activeCode: '005930', candleTimeframe: '1m', historicalFromDate: null });

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      // 봉 전환은 프로덕션 경로인 projectActiveView 로 — 전환 시 historicalFromDate 는 null 리셋.
      useLivePageStore.getState().projectActiveView({ code: '005930', timeframe: '3m', historicalFromDate: null });
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().candleTimeframe).toBe('3m');
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('(auto-fill 불변식) 캔들 로드 후 초기 빈영역(from<0)은 사용자 팬 없이 자동 백필 — small-window 보장', () => {
    // (a) 초기 창 5거래일 축소(/diagnose 2026-06-09 후속)의 안전성 고정: 받아둔 양이
    // 적어도, 화면에 빈영역이 보이면 사용자 액션 없이 채워진다. 여기선 그 시작점인 3b
    // 트리거가 candles>0(데이터 도착) + from<0(빈영역)에 자동 dispatch함을 잠근다.
    // 연속 스텝(settle-loop)은 'dispatches the next step ... while whitespace remains'가 커버.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    // 사용자 입력 없음 — 초기 커밋의 visibleLogicalRangeChange가 빈영역(from<0)을 보고.
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // candles>0(TWO_SEGMENT_BUNDLE) → 가드 통과 → 자동으로 한 청크 백필.
    // axisEarliest '20260526'(화) − 5거래일 → '20260519'(화).
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260519');
  });

  it('bases next chunk on historicalFromDate (not axis) when axis did not advance', () => {
    // Holiday/long-weekend regression: if the prior chunk fetched only
    // non-trading days, axis.segments[0] stays put. Without basing the
    // next chunk off historicalFromDate, the trigger would recompute the
    // same target, the store's monotonic-decrease guard would reject it,
    // and extension would freeze. Verify the next pan steps another full
    // chunk back from the already-requested boundary instead.
    useLivePageStore.setState({ historicalFromDate: '20260519' }); // earlier than axisEarliest '20260526'

    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // base = historicalFromDate '20260519'(화) (earlier than axisEarliest
    // '20260526'), minus 5 trading days → '20260512'(화). If the trigger had
    // re-based on axis instead, it would compute '20260519' and the store
    // guard would reject that as not strictly earlier than '20260519'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260512');
  });

  it('fires extendHistoricalRange on D timeframe when logical from goes negative', () => {
    // Lazy fetch must run for D/W/M too. The candle backfill is timeframe-
    // independent (useLiveBundle re-aggregates the same 1m bars into D/W/M
    // on the client), so dragging past the leftmost bar on D should
    // extend the same way as on minute timeframes. Prior behavior had a
    // `!isMinuteTimeframe` early-return that blocked D/W/M users from
    // ever seeing more history; this guards against that regression.
    useLivePageStore.setState({ candleTimeframe: 'D' });
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // D-timeframe chunk: STEP_TRADING_DAYS['D']=50 weekdays = 70 calendar days
    // (50 daily candles). axis.segments[0] = '20260526'(화), minus 50 weekdays
    // = 70 calendar days → '20260317'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260317');
  });

  it('does NOT fire extendHistoricalRange when logical from is non-negative', () => {
    // The handler should only trigger when the viewport's logical origin
    // is past the leftmost loaded bar (= negative fractional index).
    // Any positive 'from' means the user is still inside the loaded
    // range and we should NOT prefetch yet.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: 1000, to: 2000 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Historical-prepend viewport repositioning (/diagnose 2026-05-31 → 2026-06-05 ×2)
//
// Contract (v3, 2026-06-05 round 2): a historical prepend must keep the SAME
// BARS on screen, and the reposition target must be computed from the view AS
// OF THE PREPEND COMMIT — never from a position captured earlier.
//
// Why (measured in-browser, lwc 5.2.0, stack-attributed monkey-patch + real
// synthetic-mouse drags): lwc's own setData re-anchor is position-DEPENDENT —
//   ① view at the live edge → preserved exactly (no help needed);
//   ② view deep in left whitespace → lands near the new/old data seam;
//   ③ view mid-data → logical indices FROZEN, content slides by the inserted
//     count (days-scale teleport; reproduced on the user's build).
// The original restore corrected ③ but captured its anchor at the FETCH
// TRIGGER — by the time the prepend landed the chart had moved (kept dragging,
// panned back), so the re-assert teleported (30-bar wobble fresh; thousands of
// bars stale). The v3 design closes the staleness window structurally: a
// parent useLayoutEffect snapshots the view in the SAME commit as the bundle
// swap (layout effects run before RangeSeriesPane's passive setData), and the
// post-setData repositioner re-projects that snapshot through the new axis —
// skipping the set entirely when lwc already landed on the target (case ①).
//
// Seam limit (stated, not papered over): this mock's setData is a NO-OP and
// its range getters are static, so these tests lock the CALL CONTRACT (when a
// reposition fires, its target, and the staleness-freedom of the capture); the
// rendered-pixels half is browser-only evidence (diagnose notes 2026-06-05).
//
// Harness: a stable timeScale object shared across commits, capturing the
// logical-range handler and returning controllable range getters.
describe('LiveChartRoot historical-prepend viewport preservation', () => {
  beforeEach(() => {
    // candleTimeframe도 리셋 — D 예산 테스트가 'D'를 남기면 뒤의 1m 테스트의
    // 3b 디바운스 타이머가 타임프레임 불일치로 dispatch를 반려한다.
    useLivePageStore.setState({ historicalFromDate: null, candleTimeframe: '1m' });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Visible window the user is parked on, in virtual SECONDS (both within
  // today's 6.5h session: 1h and 2h past open). The /live axis is
  // real-anchored (origin = segments[0]'s real open — the stale-tick-label
  // fix), so the today-only axis the chart is initially drawn with starts at
  // TODAY_OPEN, not 0.
  const VR_FROM_SEC = TODAY_OPEN_MS / 1000 + 3600;
  const VR_TO_SEC = TODAY_OPEN_MS / 1000 + 7200;
  // Visible LOGICAL range (bar indices) the mock's getVisibleLogicalRange
  // returns — read by the settle-loop's planFillStep viewport gate.
  const LR_FROM = 100;
  const LR_TO = 400;

  function buildStableCapturingMock(ts: Record<string, unknown>) {
    return {
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
  }

  function makeTs(handlers: Array<(r: unknown) => void>) {
    return {
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: (h: (r: unknown) => void) => { handlers.push(h); },
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleRange: vi.fn(() => ({ from: VR_FROM_SEC, to: VR_TO_SEC })),
      getVisibleLogicalRange: vi.fn(() => ({ from: LR_FROM, to: LR_TO })),
      // Stand-in union index = the (integer) virtual-second value, so the test
      // can derive the expected shift from the same axis math production uses.
      timeToIndex: vi.fn((t: unknown): number | null => Math.round(t as number)),
      width: vi.fn(() => 800),
      height: vi.fn(() => 28),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    };
  }

  const todayBundle = (candleTsList: number[]): RangeBundle => ({
    ...TODAY_ONLY_BUNDLE,
    candles: candleTsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });
  const twoSegBundle = (candleTsList: number[]): RangeBundle => ({
    ...TWO_SEGMENT_BUNDLE,
    candles: candleTsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });

  /** Mirror production's prepend reprojection (real-anchored origins, same
   * axes LiveChartRoot builds): snapshot right edge (virtual sec on the
   * today-only axis) → real ms → two-segment axis virtual sec (rounded).
   * Returns the logical shift newIdx − refIdx under makeTs's
   * index = virtual-second stand-in. */
  function expectedPrependShift(rightEdgeSec: number): number {
    const oldAxis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    const refMs = oldAxis.toReal(rightEdgeSec * 1000);
    const newAxis = createVirtualAxis(
      [
        { date: '20260526', sessionOpenMs: YESTERDAY_OPEN_MS, sessionCloseMs: YESTERDAY_CLOSE_MS },
        { date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS },
      ],
      YESTERDAY_OPEN_MS,
    );
    return Math.round(newAxis.toVirtual(refMs) / 1000) - rightEdgeSec;
  }

  it('repositions to the pre-swap view (same bars) after a historical prepend', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 1) Initial paint: today-only, historicalFromDate=null. The initial-view
    //    effect owns the FIRST viewport placement; the layout-effect snapshot
    //    also primes prevAxisRef with the today-only axis here.
    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    const beforePan = ts.setVisibleLogicalRange.mock.calls.length; // initial-view call(s)

    // 2) User pans past the leftmost bar: logical.from < 0 → the handler
    //    debounces extendHistoricalRange. Data IS fetched ("데이터만 fetch").
    //    NOTE: nothing is captured here — that's the v3 point.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforePan);

    // 3) Grown bundle lands: yesterday PREPENDED. The layout-effect snapshot
    //    (same commit, pre-setData) reads the mock's current view (VR/LR) and
    //    converts the right edge through the PREVIOUS axis; the repositioner
    //    re-projects it through the rebuilt two-segment axis.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    // Expected shift: refIdx = timeToIndex(VR_TO_SEC) = VR_TO_SEC (mock);
    // refMs reprojects through old→new axis exactly as production does.
    const shift = expectedPrependShift(VR_TO_SEC);

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM + shift,
      to: LR_TO + shift,
    });
    // Width invariant → barSpacing (candle scale) does not move.
    const last = ts.setVisibleLogicalRange.mock.calls.at(-1)![0] as { from: number; to: number };
    expect(last.to - last.from).toBe(LR_TO - LR_FROM);
    // The mock's timeToIndex stand-in equates union index with virtual
    // seconds, so under the real-anchored axis a prepend shifts the stand-in
    // by (stride − real gap) = 23401 − 86400 < 0 — gap compression pulls the
    // virtual value of an existing bar DOWN once the origin moves to the
    // prepended day. Production's timeToIndex returns true union list
    // indices (shift = +inserted count); only "a reposition happened with
    // preserved width" is contract here, not the stand-in's sign.
    expect(shift).not.toBe(0);
  });

  it('skips the reposition when lwc already landed on the target (live-edge case)', () => {
    // Regime ①: at the live edge lwc preserves the view natively. shift=0 here
    // (timeToIndex returns the same index pre/post), so target == current and
    // the repositioner must NOT issue a redundant setVisibleLogicalRange.
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex = vi.fn(() => VR_TO_SEC); // index unchanged across the swap
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    const before = ts.setVisibleLogicalRange.mock.calls.length;
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(before);
  });

  // ── 탭 viewport 복원 (ADR-0069 A안) ──
  // The restore branch runs in the initial-view effect BEFORE the
  // historicalFromDate gate / default minute window. Seam limit (same as the
  // reposition tests above): setData is a no-op so we lock the CALL CONTRACT
  // (the reprojected target / live-edge pin), not the rendered pixels.
  it('restore: a scrolled-back tab reprojects its saved time anchor to a logical range', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const rightEdgeMs = TODAY_OPEN_MS + 2 * 3600_000; // 2h past open, mid-session
    const barSpan = 120;
    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs, barSpan, atLiveEdge: false }} />,
      { wrapper },
    );
    // The component builds a today-only real-anchored axis (origin = today open).
    // idx = mock timeToIndex(realMsToVirtualSeconds(axis, rightEdgeMs)) (round of
    // an already-integer value). Computed here with the same axis math.
    const axis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    const idx = realMsToVirtualSeconds(axis, rightEdgeMs);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: idx - barSpan, to: idx });
    // NOT a live-edge restore → no scrollToPosition snap.
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: a live-edge tab preserves right-offset whitespace with the saved zoom', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(99);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 100 candles + saved span 50 + rightOffset 15 → from max(0,100-50)=50,
    // to 115. Distinct from the default 300-window ({from:0,to:115}) so this
    // proves the live-edge branch.
    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs: TODAY_OPEN_MS + 100 * 60_000, barSpan: 50, atLiveEdge: true }} />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 50, to: 115 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: a live-edge tab preserves captured right-side padding and is not reset by fitting', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(99);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{
          rightEdgeMs: TODAY_OPEN_MS + 100 * 60_000,
          barSpan: 80,
          atLiveEdge: true,
          rightPaddingBars: 30,
        }} />,
      { wrapper },
    );

    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 50, to: 130 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: a live-edge tab preserves padding from the latest candle logical index when the scale has extra points', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(249);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 200 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{
          rightEdgeMs: TODAY_OPEN_MS + 200 * 60_000,
          barSpan: 80,
          atLiveEdge: true,
          rightPaddingBars: 30,
        }} />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 200, to: 280 });
  });

  it('restore: D live-edge tab keeps captured right-side padding when a new candle arrives', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(100).mockReturnValueOnce(99).mockReturnValueOnce(99);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const restoreViewport = {
      rightEdgeMs: TODAY_OPEN_MS + 100 * 60_000,
      barSpan: 80,
      atLiveEdge: true,
      rightPaddingBars: 30,
    };
    const initialCandles = Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000);
    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle(initialCandles)}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={restoreViewport} />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 50, to: 130 });

    rerender(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle([...initialCandles, TODAY_OPEN_MS + 101 * 60_000])}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={restoreViewport} />,
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 51, to: 131 });
  });

  it('restore: a user-adjusted live-edge tab preserves the saved time anchor', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const rightEdgeMs = TODAY_OPEN_MS + 100 * 60_000;
    const barSpan = 50;
    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 120 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs, barSpan, atLiveEdge: true, userAdjusted: true }} />,
      { wrapper },
    );

    const axis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    const idx = realMsToVirtualSeconds(axis, rightEdgeMs);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: idx - barSpan, to: idx });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: a user-adjusted live-edge tab preserves captured right-side padding', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(119);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 120 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{
          rightEdgeMs: TODAY_OPEN_MS + 100 * 60_000,
          barSpan: 80,
          atLiveEdge: true,
          userAdjusted: true,
          rightPaddingBars: 30,
        }} />,
      { wrapper },
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 70, to: 150 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: D timeframe reprojects an explicit saved time anchor to a logical range', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(249);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle(Array.from({ length: 250 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{
          rightEdgeMs: TODAY_OPEN_MS + 200 * 60_000,
          barSpan: 8,
          atLiveEdge: false,
          userAdjusted: true,
        }} />,
      { wrapper },
    );
    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 241, to: 249 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: D live-edge historical tab caps an over-wide saved span to the legible daily window', () => {
    useLivePageStore.setState({ historicalFromDate: '20240718' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.width.mockReturnValue(628);
    ts.timeToIndex.mockReturnValue(463);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle(Array.from({ length: 464 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{
          rightEdgeMs: TODAY_OPEN_MS + 463 * 60_000,
          barSpan: 1255,
          atLiveEdge: true,
        }} />,
      { wrapper },
    );

    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 464 + RIGHT_OFFSET - 179, to: 464 + RIGHT_OFFSET });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: D scrolled-back historical tab preserves the user-owned viewport', () => {
    useLivePageStore.setState({ historicalFromDate: '20240718' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(200);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle(Array.from({ length: 464 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{
          rightEdgeMs: TODAY_OPEN_MS + 120 * 60_000,
          barSpan: 160,
          atLiveEdge: false,
        }} />,
      { wrapper },
    );

    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 40, to: 200 });
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('D historical extension after user zoom does not re-apply the default daily window', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.width.mockReturnValue(628);
    ts.timeToIndex.mockReturnValue(249);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle(Array.from({ length: 250 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);

    // User zoomed/panned far enough left to trigger D lazy backfill. The
    // appended historical response changes candle count, but the user now owns
    // the viewport; the D default window must not snap back over it.
    useLivePageStore.setState({ historicalFromDate: '20240718' });
    ts.timeToIndex.mockReturnValue(463);
    rerender(
      <LiveChartRoot code="005930" timeframe="D"
        bundle={todayBundle(Array.from({ length: 464 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.fitContent).not.toHaveBeenCalled();
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: no saved viewport → the default 300-bar minute window (regression)', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(null);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false} /> /* restoreViewport omitted */,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 130 });
  });

  it('initial minute viewport anchors to the latest candle union index, not candles.length', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(699);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="3m"
        bundle={todayBundle(Array.from({ length: 400 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 3 * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );

    expect(ts.timeToIndex).toHaveBeenCalled();
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 400, to: 788 });
  });

  it('restore: an anchor older than the earliest loaded bar falls through to default (no degenerate {0,0})', () => {
    // Pre-landing review P2: lwc timeToIndex(findNearest) CLAMPS a too-early
    // anchor to bar 0 (does NOT return null), which would pin a degenerate
    // {from:0,to:0} window. The earliest-bar guard must instead fall through to
    // the default view. Candles start at TODAY_OPEN+60s; anchor at TODAY_OPEN
    // (before the first bar).
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex.mockReturnValue(null);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs: TODAY_OPEN_MS, barSpan: 120, atLiveEdge: false }} />,
      { wrapper },
    );
    // Default minute window, NOT {from:0,to:0}.
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 130 });
  });

  // ── 진행 루프(스텝 2..N): 제스처 예산 모델 — 트리거(3b)가 예산을 동결하고
  // falling edge마다 소진하며 완주한다. 3a는 fill 중 뷰포트를 재측정하지 않으므로
  // 테스트는 3b 이벤트로 fill을 먼저 수립한 뒤 isExtending을 토글한다.
  it('runs the frozen gesture budget across isExtending falling edges, then stops', () => {
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -3000, to: 100 })); // 빈영역
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const props = (ext: boolean) => (
      <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={ext} />
    );
    const { rerender } = render(props(false), { wrapper });
    // 트리거: 빈공간 3000바 (1m 스텝당 1,950봉) → 예산 ceil(3000/1950)=2.
    act(() => {
      handlers.forEach((h) => h({ from: -3000, to: 100 }));
      vi.advanceTimersByTime(200);
    });
    // 배치 dispatch(ADR-0120): 예산 2를 한 번에 묶어 10평일 전진 —
    // '20260521'(목) − 10거래일 → '20260507'(목). 왕복 2회 → 1회.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260507');

    act(() => { rerender(props(true)); });
    act(() => { rerender(props(false)); }); // falling edge → 예산 소진, stop
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260507');
  });

  it('batches at most MAX_BATCH_STEPS_PER_DISPATCH, leaving the remainder as a single step', () => {
    // 큰 예산(5스텝)의 dispatch 시퀀스는 2,2,1이어야 한다 — 배치는 남은 예산을
    // 넘지 않고, 총 전진량은 배치 도입 전(1스텝×5)과 정확히 같다(예산 의미론 불변).
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -9000, to: 100 }));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const props = (ext: boolean) => (
      <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={ext} />
    );
    const { rerender } = render(props(false), { wrapper });
    act(() => {
      handlers.forEach((h) => h({ from: -9000, to: 100 })); // 예산 ceil(9000/1950)=5
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260507'); // 2스텝

    act(() => { rerender(props(true)); });
    act(() => { rerender(props(false)); });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260423'); // +2스텝

    act(() => { rerender(props(true)); });
    act(() => { rerender(props(false)); });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260416'); // +1(잔여)

    act(() => { rerender(props(true)); });
    act(() => { rerender(props(false)); }); // 예산 소진 → stop
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260416');
  });

  it('does NOT dispatch a fill step before candles load, even with historicalFromDate set', () => {
    // Defense-in-depth companion to 3b's guard: if historicalFromDate is
    // non-null (e.g. persisted from a prior pan, then a reload) while the chart
    // is still cold (zero candles), the settle-loop must NOT keep stepping —
    // same runaway as the trigger. candleCountRef===0 stops it (/diagnose
    // 2026-06-09). With candles present this same setup DOES step (test above).
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const emptyBundle = { ...TWO_SEGMENT_BUNDLE, candles: [] };
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -50, to: 100 })); // 빈영역 남음
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={emptyBundle}
        clampEngaged={false} isPastCandlesLoading={true} isExtending={true} />,
      { wrapper },
    );
    act(() => {
      rerender(
        <LiveChartRoot code="005930" timeframe="1m" bundle={emptyBundle}
          clampEngaged={false} isPastCandlesLoading={true} isExtending={false} />,
      );
    });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521'); // 불변
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
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521'); // 불변
    // 효과가 게이트까지 실행돼 viewport를 읽고 'full'이라 멈췄음을 국소화.
    expect(ts.getVisibleLogicalRange).toHaveBeenCalled();
  });

  it('runs a D-timeframe budget across falling edges (calendar frames share the loop)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260521', candleTimeframe: 'D' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -60, to: 100 }));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const props = (ext: boolean) => (
      <LiveChartRoot code="005930" timeframe="D" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={ext} />
    );
    const { rerender } = render(props(false), { wrapper });
    // 트리거: 빈공간 60바 (D 스텝당 50봉) → 예산 2, 스텝 1.
    act(() => {
      handlers.forEach((h) => h({ from: -60, to: 100 }));
      vi.advanceTimersByTime(200);
    });
    // 스텝 1: '20260521'(목) − STEP_TRADING_DAYS['D']=50 weekdays = 70캘린더일 → '20260312'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260312');

    act(() => { rerender(props(true)); });
    act(() => { rerender(props(false)); }); // falling edge → 스텝 2
    // 스텝 2: '20260312' − 70 → '20260101'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260101');
  });

  it('keeps dispatching D timeframe fill steps past the minute scrollback clamp', () => {
    useLivePageStore.setState({ historicalFromDate: '20250605', candleTimeframe: 'D' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -60, to: 100 }));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const props = (ext: boolean) => (
      <LiveChartRoot code="005930" timeframe="D" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={ext} />
    );
    const { rerender } = render(props(false), { wrapper });
    act(() => {
      handlers.forEach((h) => h({ from: -60, to: 100 }));
      vi.advanceTimersByTime(200);
    });
    // '20250605'는 오늘('20260527')−250일보다 과거 — 분봉 클램프가 D를 막지 않는다.
    // 스텝 1: '20250605' − 70 → '20250327'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20250327');

    act(() => { rerender(props(true)); });
    act(() => { rerender(props(false)); }); // 스텝 2: '20250327' − 70 → '20250116'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20250116');
  });

  it('does NOT restore on pure SSE growth while historicalFromDate is null', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    const beforeSse = ts.setVisibleLogicalRange.mock.calls.length; // initial-view only
    // SSE appends a bar at the right edge; earliest is unchanged, no extension.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 120_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    // Restore must NOT fire (historicalFromDate null) — no new setVisibleLogicalRange.
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforeSse);
  });

  it('does NOT restore when the extension adds no earlier bar (holiday-only chunk)', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    // Pan left → captures the reference bar + sets historicalFromDate.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();
    const beforeHoliday = ts.setVisibleLogicalRange.mock.calls.length;
    // The fetched chunk was holiday-only: earliest drawn candle unchanged.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    // newEarliest >= prevEarliest → restore short-circuits, no shift.
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforeHoliday);
  });

  it('initial-view applies exactly once; the first extension adds exactly one reposition', () => {
    // Trace the first extension from a fresh load. The store update
    // (historicalFromDate null→non-null) and the bundle refetch land in
    // SEPARATE commits, so on the bundle-grows commit historicalFromDate is
    // already non-null — the initial-view effect early-returns (no second
    // scrollToPosition / setVisibleLogicalRange) while the repositioner owns
    // that commit's viewport. Exactly two owners, never on the same commit:
    // initial-view (first paint) and the repositioner (prepends).
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 1) Fresh load, minute: initial-view effect applies ONCE.
    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1); // initial window
    expect(ts.scrollToPosition).not.toHaveBeenCalled();         // range includes right-offset whitespace

    // 2) Pan left → historicalFromDate flips non-null (commit A: bundle unchanged).
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });

    // 3) Prepend lands (commit B: bundle grows, historicalFromDate already non-null).
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    // The initial-view effect did NOT re-fire — setVisibleLogicalRange stays at
    // exactly 2 (initial window + the repositioner's one reposition). The
    // repositioner's set now carries ONE durability sync (scrollToPosition,
    // 2026-08-25 내구화 계약) — a re-fired initial view would have added a third
    // setVisibleLogicalRange, which the count above rules out.
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(2);
    expect(ts.scrollToPosition).toHaveBeenCalledTimes(1);
  });

  // Staleness-freedom regression (/diagnose 2026-06-05, the saga's crown jewel).
  //
  // The whole 3-round bug class was ONE mistake: capturing the reposition
  // anchor at the FETCH TRIGGER and applying it at the PREPEND — the chart
  // moves in between (user keeps dragging / pans back), so the re-assert
  // teleports. v3 captures in the SAME COMMIT as the bundle swap (parent
  // useLayoutEffect, before the child's passive setData), making staleness
  // structurally impossible.
  //
  // This test moves the mock's view BETWEEN the trigger and the swap, then
  // asserts the reposition target is derived from the AT-SWAP view (B), not
  // the at-trigger view (A). Trigger-time-capture semantics fail this test.
  it('reposition target derives from the at-swap view, not the at-trigger view (no staleness)', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );

    // 1) Trigger at view A (the mock's defaults) → debounced fetch armed.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();

    // 2) User pans elsewhere BEFORE the fetch lands → the chart now shows
    //    view B. (Static mocks: just swap what the getters return.)
    const B_VR_TO = VR_TO_SEC + 1800;
    ts.getVisibleRange.mockReturnValue({ from: VR_FROM_SEC + 1800, to: B_VR_TO });
    ts.getVisibleLogicalRange.mockReturnValue({ from: LR_FROM + 30, to: LR_TO + 30 });

    // 3) Grown bundle lands. The layout-effect snapshot (same commit) reads B.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    const shiftB = expectedPrependShift(B_VR_TO);

    // Target must be view B + shiftB. A trigger-time capture would have used
    // view A (LR_FROM..LR_TO, refIdx VR_TO_SEC) and produced different numbers.
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM + 30 + shiftB,
      to: LR_TO + 30 + shiftB,
    });
  });
});

// ---------------------------------------------------------------------------
// 소스 스왑 뷰포트 재착석 (2026-08-24 실측)
//
// hogaplay 토글은 캔들 배열을 **통째로 다른 소스의 것으로** 갈아 끼우는데, 종전에는
// 그 커밋에서 뷰포트를 다시 앉히는 주체가 아무도 없었다:
//   · `viewKey` 에 소스가 없어 차트가 remount 되지 않고(초기 뷰 effect 는 1-샷 소진),
//   · 리포지셔너는 `historicalFromDate === null`(라이브 엣지의 기본값)에서 리턴하며,
//   · 설령 통과해도 재투영값이 lwc 착지점과 같아 EPSILON 스킵된다.
// 실측(462350, 10분봉): 벤더 195봉 → 디스크 122봉에서 화면이 73봉(≈320px) 미끄러졌다.
//
// 계약: 소스가 갈린 커밋에서 **라이브 엣지였으면 초기 분봉 배치를 다시 적용**하고
// (span 이 데이터 크기로 클램프되는 것이 요점), **과거를 보고 있었으면 보던 시각을
// 앵커로 재투영**한다. 판정은 「키가 갈렸다 AND 캔들 정체성이 갈렸다」의 AND 다 —
// 키만 보면 데이터가 아직 안 온 커밋에서 헛 앉는다(콜드 실측 11.6s 간극).
//
// Seam: 이 mock 의 setData 는 no-op 이고 range getter 가 정적이라, 여기서 잠그는 것은
// **호출 계약**(언제·어느 범위로)이다. 픽셀은 브라우저 증거다(조사 노트 2026-08-24).
// ---------------------------------------------------------------------------
describe('LiveChartRoot source-swap viewport reseat', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null, candleTimeframe: '1m' });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LR_FROM = 100;
  const LR_TO = 400;
  const PLOT_WIDTH = 800;

  function makeTs(vrFromSec: number, vrToSec: number) {
    return {
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleRange: vi.fn(() => ({ from: vrFromSec, to: vrToSec })),
      getVisibleLogicalRange: vi.fn(() => ({ from: LR_FROM, to: LR_TO })),
      // 논리 인덱스 대역 = (정수) virtual second — 프로덕션과 같은 축 산식으로
      // 기대값을 유도할 수 있게 하는 대역이다(프리펜드 테스트와 같은 관례).
      timeToIndex: vi.fn((t: unknown): number | null => Math.round(t as number)),
      width: vi.fn(() => PLOT_WIDTH),
      height: vi.fn(() => 28),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    };
  }

  function buildMock(ts: Record<string, unknown>) {
    return {
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
  }

  const todayBundle = (candleTsList: number[]): RangeBundle => ({
    ...TODAY_ONLY_BUNDLE,
    candles: candleTsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });
  const twoSegBundle = (candleTsList: number[]): RangeBundle => ({
    ...TWO_SEGMENT_BUNDLE,
    candles: candleTsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });

  /** 오늘-단일 축에서의 논리 인덱스(= 정수 virtual second, 위 mock 대역). */
  function todayIdx(realMs: number): number {
    const axis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    return Math.round(realMsToVirtualSeconds(axis, realMs));
  }

  // 벤더 5봉 → 디스크 3봉. 라이브 엣지(오른쪽 끝 = 마지막 봉)에서 눌렀다.
  const VENDOR_TS = [1, 2, 3, 4, 5].map((m) => TODAY_OPEN_MS + m * 60_000);
  const DISK_TS = [1, 2, 3].map((m) => TODAY_OPEN_MS + m * 60_000);

  it('live edge: 소스가 갈리면 초기 분봉 배치를 다시 적용한다(span 이 데이터로 클램프)', () => {
    // 오른쪽 끝을 벤더 마지막 봉에 둔다 → 스냅샷의 atLiveEdge = true.
    const ts = makeTs(todayIdx(TODAY_OPEN_MS + 60_000), todayIdx(VENDOR_TS[4]));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="vendor"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    const beforeSwap = ts.setVisibleLogicalRange.mock.calls.length;

    // 토글: 키가 먼저 뒤집힌다. 캔들은 아직 벤더 것 → 아무 일도 없어야 한다.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforeSwap);

    // 디스크 응답 도착: 같은 첫 봉, 더 적은 개수 → 재착석.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={todayBundle(DISK_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    const latest = todayIdx(DISK_TS[2]);
    const target = ts.setVisibleLogicalRange.mock.calls.at(-1)?.[0] as { from: number; to: number };
    // span 이 3봉으로 접힌다 — 이 클램프가 없으면 화면 왼쪽이 통째로 빈다.
    expect(target.from).toBe(latest + 1 - DISK_TS.length);
    expect(target.to).toBeGreaterThan(latest);
  });

  it('재착석은 내구적이어야 한다 — range set 뒤 scrollToPosition 으로 내부 오프셋 동기화', () => {
    // 2026-08-25 사용자 실측(047040 5m 장중): 재착석이 정상 위치에 앉혔는데
    // **다음 데이터 커밋에서 lwc 가 토글 전 내부 scrollPosition(span 3123)을 도로
    // 재적용**해 재착석을 덮었고, 그 덮인 화면을 후속 재투영이 충실히 고정해
    // [-2040,1083] 허공으로 갔다. setVisibleLogicalRange 는 lwc 내부 오프셋을
    // 갱신하지 않는다(오전 실측: set 직후 scrollPosition() 이 여전히 3534) —
    // scrollToPosition 만이 setData 재앵커가 참조하는 상태를 바꾼다.
    const ts = makeTs(todayIdx(TODAY_OPEN_MS + 60_000), todayIdx(VENDOR_TS[4]));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="vendor"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={todayBundle(DISK_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    const target = ts.setVisibleLogicalRange.mock.calls.at(-1)?.[0] as { from: number; to: number };
    const latest = todayIdx(DISK_TS[2]);
    // lwc 의 scrollPosition 단위 = 오른쪽 끝 논리 인덱스 - 마지막 봉 인덱스.
    expect(ts.scrollToPosition).toHaveBeenLastCalledWith(target.to - latest, false);
  });

  it('panned: 소스가 갈리면 보던 시각을 앵커로 재투영한다(라이브 엣지 배치가 아니다)', () => {
    // 오른쪽 끝을 마지막 봉보다 한참 과거로 → atLiveEdge = false.
    const anchorMs = TODAY_OPEN_MS + 60_000;
    const ts = makeTs(todayIdx(TODAY_OPEN_MS), todayIdx(anchorMs));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="vendor"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );

    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={todayBundle(DISK_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    const target = ts.setVisibleLogicalRange.mock.calls.at(-1)?.[0] as { from: number; to: number };
    // 앵커가 오른쪽 끝, span 은 데이터(3봉)로 클램프. 라이브 엣지 분기였다면 오른쪽
    // 여백이 붙어 to > latest 가 됐을 것이다 — 두 분기를 가르는 단언이다.
    expect(target.to).toBe(todayIdx(anchorMs));
    expect(target.to - target.from).toBe(DISK_TS.length);
  });

  it('봉을 바꾼 뒤 눌러도 재착석한다 — 리셋이 소스 축 기억을 지우면 안 된다', () => {
    // 2026-08-24 사용자 보고의 정확한 경로다. 새로고침 직후 토글은 고쳐졌는데
    // **봉을 바꾼 뒤 토글**하면 종전 증상 그대로였다(실측 `lr [-73,161]`).
    //
    // 기전: 봉 전환은 `[code, timeframe]` 리셋 effect 를 태우는데, 1b 래치의 deps 는
    // `[candleSourceKey]` 뿐이라 그 커밋에 재실행되지 않는다. 리셋이 소스 축 기억을
    // null 로 만들면 그 null 이 그대로 남고, 다음 토글에서 1b 가 "첫 관측" 으로 오인해
    // 래치를 세우지 못한다.
    const ts = makeTs(todayIdx(TODAY_OPEN_MS + 60_000), todayIdx(VENDOR_TS[4]));
    // 봉 전환이 `viewKey` 를 바꿔 차트를 remount 하므로 **두 번** 만들어진다.
    // `mockImplementation`(영구)을 쓰면 뒤따르는 테스트의 mock 까지 덮어써서
    // 크로스헤어 스위트가 통째로 깨진다 — Once 를 필요한 수만큼 건다.
    vi.mocked(createChartEx).mockImplementationOnce(() => buildMock(ts) as any);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="vendor"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );

    // 봉 전환 — 리셋 effect 가 돈다. 소스는 그대로라 1b 는 재실행되지 않는다.
    rerender(
      <LiveChartRoot code="005930" timeframe="5m" candleSourceKey="vendor"
        bundle={todayBundle(VENDOR_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    // 새 봉에서 캔들이 한 번 더 커밋된다(prevIdentity 를 세운다).
    rerender(
      <LiveChartRoot code="005930" timeframe="5m" candleSourceKey="vendor"
        bundle={todayBundle(VENDOR_TS.slice(0, 4))}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    const beforeSwap = ts.setVisibleLogicalRange.mock.calls.length;

    // 이제 토글.
    rerender(
      <LiveChartRoot code="005930" timeframe="5m" candleSourceKey="disk"
        bundle={todayBundle(DISK_TS)}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(ts.setVisibleLogicalRange.mock.calls.length).toBeGreaterThan(beforeSwap);
    const latest = todayIdx(DISK_TS[2]);
    const target = ts.setVisibleLogicalRange.mock.calls.at(-1)?.[0] as { from: number; to: number };
    expect(target.from).toBe(latest + 1 - DISK_TS.length);
  });

  it('키가 그대로면 재착석하지 않는다 — 프리펜드·SSE 성장은 종전 주체가 답한다', () => {
    // 재착석 판정은 「키 변화 AND 캔들 정체성 변화」의 AND 다. 이 단언이 AND 의 왼쪽을
    // 잰다: 캔들이 크게 갈려도 소스가 그대로면 여기서 손대지 않는다.
    //
    // 이 경계는 실측이 요구한 것이다(2026-08-24). 재착석의 `setVisibleLogicalRange` 는
    // lwc 논리범위 구독을 깨워 3b 좌측-팬 판정을 태우고, 디스크 모드엔 250일 벽이 없어
    // 되먹임이 멈추지 않는다 — 게이트를 넓혔을 때 토글 한 번에 84봉 → 1,688봉으로
    // 워크백이 폭주했다. 그래서 재착석은 **소스가 실제로 갈린 커밋 한 번**뿐이다.
    const ts = makeTs(todayIdx(TODAY_OPEN_MS), todayIdx(TODAY_OPEN_MS + 60_000));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    const beforePrepend = ts.setVisibleLogicalRange.mock.calls.length;

    // 어제가 앞에 붙는다(청크 워크백). 키가 같으므로 재착석은 침묵해야 한다.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforePrepend);
  });
});

// ---------------------------------------------------------------------------
// 중간 삽입 보정 (2026-08-24 사용자 보고)
//
// 디스크 구멍을 키움 보충이 메우면 캔들이 배열 **한가운데** 들어온다. 삽입 지점
// 오른쪽 인덱스가 그만큼 밀리는데, 왼쪽 경계도 마지막 봉도 안 움직이므로 프리펜드
// 게이트(`newEarliest < prevEarliest`)가 전부 통과시켜 보정이 없었다 — 화면은 그대로
// 남아 다른 시점을 가리킨다. 010140 의 06-15~08-24 구간은 디스크 구멍이 16일이라
// (06-15~07-02 연속 13일 + 07-17 + 08-17) 보충마다 반복되며 누적된다.
//
// 이 mock 의 `timeToIndex` 는 **삽입을 실제로 흉내낸다** — 삽입 지점보다 뒤의 time 을
// 그 개수만큼 민다. 매핑 전환은 `setData` 시점에 일어나므로(테스트가 pending 을 세우고
// 자식 pane 의 setData 가 적용) layout 스냅샷은 옛 매핑을, 리포지셔너는 새 매핑을 본다 —
// 프로덕션의 실제 순서와 같다. 상수 매핑이면 shift 가 0 이라 이 테스트는 아무것도
// 잠그지 못한다.
// ---------------------------------------------------------------------------
describe('LiveChartRoot mid-array gap-fill insertion', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null, candleTimeframe: '1m' });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LR_FROM = 100;
  const LR_TO = 400;
  const VR_FROM_SEC = TODAY_OPEN_MS / 1000 + 60;
  const VR_TO_SEC = TODAY_OPEN_MS / 1000 + 600;
  const INSERT_SHIFT = 39;

  function makeHarness() {
    // 삽입 매핑: pivot 보다 뒤의 time 은 shift 만큼 밀린다.
    let shift = 0;
    let pivot = Number.POSITIVE_INFINITY;
    let pending: { shift: number; pivot: number } | null = null;
    const applyPending = () => {
      if (pending) { shift = pending.shift; pivot = pending.pivot; pending = null; }
    };
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
      getVisibleRange: vi.fn(() => ({ from: VR_FROM_SEC, to: VR_TO_SEC })),
      getVisibleLogicalRange: vi.fn(() => ({ from: LR_FROM, to: LR_TO })),
      timeToIndex: vi.fn((t: unknown): number => {
        const v = Math.round(t as number);
        return v > pivot ? v + shift : v;
      }),
      width: vi.fn(() => 800),
      height: vi.fn(() => 28),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    };
    const chart = {
      addSeries: vi.fn(() => ({
        // 자식 pane 의 setData 가 매핑 전환 지점이다 — 프로덕션에서 lwc 인덱스가
        // 실제로 바뀌는 순간과 같다.
        setData: vi.fn(() => applyPending()),
        update: vi.fn(), removeSeries: vi.fn(), applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
    return { ts, chart, queueInsert: (p: { shift: number; pivot: number }) => { pending = p; } };
  }

  const bundleOf = (tsList: number[]): RangeBundle => ({
    ...TODAY_ONLY_BUNDLE,
    candles: tsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });

  // 첫 봉·마지막 봉은 고정, 가운데만 늘어난다 = 보충의 지문.
  const FIRST = TODAY_OPEN_MS + 60_000;
  const MIDDLE = TODAY_OPEN_MS + 300_000;
  const LAST = TODAY_OPEN_MS + 900_000;

  it('중간 삽입이면 재투영한다 — 팬을 한 적 없어도(좌단을 안 건드리므로 안전)', () => {
    const h = makeHarness();
    vi.mocked(createChartEx).mockImplementationOnce(() => h.chart as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    // 한 커밋 더 — prevShape 를 세운다(첫 커밋은 비교 대상이 없다).
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
    const before = h.ts.setVisibleLogicalRange.mock.calls.length;

    // 보충 도착: 가운데 한 봉. 그 지점 뒤의 인덱스가 INSERT_SHIFT 만큼 밀린다.
    h.queueInsert({ shift: INSERT_SHIFT, pivot: MIDDLE / 1000 });
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(h.ts.setVisibleLogicalRange.mock.calls.length).toBeGreaterThan(before);
    expect(h.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM + INSERT_SHIFT,
      to: LR_TO + INSERT_SHIFT,
    });
    // 내구성: 재투영도 lwc 내부 오프셋을 함께 동기화해야 다음 setData 재앵커가
    // 이 고정을 되돌리지 못한다(2026-08-25 실측 — 재착석 항목의 근거와 동일).
    const axis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    const lastIdx = Math.round(realMsToVirtualSeconds(axis, LAST)) + INSERT_SHIFT;
    expect(h.ts.scrollToPosition).toHaveBeenLastCalledWith((LR_TO + INSERT_SHIFT) - lastIdx, false);
  });

  it('SSE 성장(마지막 봉이 늘어나는 것)에는 손대지 않는다', () => {
    const h = makeHarness();
    vi.mocked(createChartEx).mockImplementationOnce(() => h.chart as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    const before = h.ts.setVisibleLogicalRange.mock.calls.length;

    // 오른쪽 끝에 새 봉 — lwc 가 스스로 우측을 핀하므로 앱이 개입하면 안 된다.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(h.ts.setVisibleLogicalRange.mock.calls.length).toBe(before);
  });

  it('유니온 재매핑(지표 포인트 churn)이면 재투영한다 — 캔들 모양이 안 변해도', () => {
    // 2026-08-25 사용자 실측(034020 5m 장중 토글): 창 축소·홀드·재착석이 전부 정상
    // 발동했는데도 최종 화면이 데이터 밖에 좌초했다. 남은 구멍은 **지표 포인트만
    // 들어왔다 빠지는 커밋** — 공유 timeScale 의 union 인덱스는 전부 밀리는데 캔들
    // 모양(firstMs·lastMs·count)은 불변이라 기존 판별식 네 행이 모두 눈멀었다.
    const h = makeHarness();
    vi.mocked(createChartEx).mockImplementationOnce(() => h.chart as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    const before = h.ts.setVisibleLogicalRange.mock.calls.length;

    // 지표 포인트 삽입: 모든 time 의 union 인덱스가 +INSERT_SHIFT — 캔들 배열은 동일.
    h.queueInsert({ shift: INSERT_SHIFT, pivot: 0 });
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(h.ts.setVisibleLogicalRange.mock.calls.length).toBeGreaterThan(before);
    expect(h.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM + INSERT_SHIFT,
      to: LR_TO + INSERT_SHIFT,
    });
  });

  it('유니온이 안 움직인 순수 ref churn 은 손대지 않는다 — shift 0 은 스킵', () => {
    // 위 행이 열리면 캔들 불변 커밋(SSE 시세 틱 등)마다 재투영 경로가 돈다 —
    // 리매핑이 없으면 shift=0 이라 EPSILON 스킵으로 끝나야 중복 repaint 가 없다.
    const h = makeHarness();
    vi.mocked(createChartEx).mockImplementationOnce(() => h.chart as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    const before = h.ts.setVisibleLogicalRange.mock.calls.length;

    // 리매핑 없음 — 같은 캔들의 새 번들 ref 만.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(h.ts.setVisibleLogicalRange.mock.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 좌측 트림(창 축소) 재투영 (2026-08-25 사용자 보고)
//
// 창 축소(`planViewportContraction` → `trimRangeBundleBefore`)는 디스크 모드
// (hogaplay/우회) 분봉에서 캔들 배열 **왼쪽을 실제로 잘라낸다** — 벤더 모드는 캔들이
// 별도 병합 캐시라 지표만 잘리지만, 디스크 캔들은 range 창에서 직접 온다. 트림은
// `segments[0]` 을 옮겨 축 원점까지 재매핑하는, 프리펜드와 같은 좌표 전면 무효화인데
// 종전엔 이 변이만 보정자가 없어 lwc 재앵커가 제멋대로 착지했다(010140 1m 실측:
// 11-08 팬 중 12-05 로 +23거래일 순간이동 → from<0 이벤트가 left_pan 재확장을 태워
// contract ↔ extend 진동).
//
// 하네스는 mid-insert describe 와 같은 원리다: `timeToIndex` 가 트림을 실제로
// 흉내내고(모든 time 의 union 인덱스가 제거된 개수만큼 내려간다), 매핑 전환은 자식
// pane 의 setData 시점이다 — layout 스냅샷은 옛 매핑을, 리포지셔너는 새 매핑을 본다.
// ---------------------------------------------------------------------------
describe('LiveChartRoot left-trim (contraction) viewport preservation', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null, candleTimeframe: '1m' });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LR_FROM = 100;
  const LR_TO = 400;
  const VR_FROM_SEC = TODAY_OPEN_MS / 1000 + 60;
  const VR_TO_SEC = TODAY_OPEN_MS / 1000 + 600;
  const TRIM_SHIFT = 39;

  function makeHarness() {
    // 트림 매핑: pivot 보다 뒤의 time 은 shift 만큼 이동한다(트림은 음수 shift —
    // 왼쪽이 잘리면 남은 모든 봉의 union 인덱스가 내려간다).
    let shift = 0;
    let pivot = Number.POSITIVE_INFINITY;
    let pending: { shift: number; pivot: number } | null = null;
    const applyPending = () => {
      if (pending) { shift = pending.shift; pivot = pending.pivot; pending = null; }
    };
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
      getVisibleRange: vi.fn(() => ({ from: VR_FROM_SEC, to: VR_TO_SEC })),
      getVisibleLogicalRange: vi.fn(() => ({ from: LR_FROM, to: LR_TO })),
      timeToIndex: vi.fn((t: unknown): number => {
        const v = Math.round(t as number);
        return v > pivot ? v + shift : v;
      }),
      width: vi.fn(() => 800),
      height: vi.fn(() => 28),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    };
    const chart = {
      addSeries: vi.fn(() => ({
        setData: vi.fn(() => applyPending()),
        update: vi.fn(), removeSeries: vi.fn(), applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
    return { ts, chart, queueRemap: (p: { shift: number; pivot: number }) => { pending = p; } };
  }

  const bundleOf = (tsList: number[]): RangeBundle => ({
    ...TODAY_ONLY_BUNDLE,
    candles: tsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });

  // 트림의 지문: 첫 봉이 미래로 이동, 마지막 봉 고정, 개수 감소.
  const FIRST = TODAY_OPEN_MS + 60_000;
  const MIDDLE = TODAY_OPEN_MS + 300_000;
  const LAST = TODAY_OPEN_MS + 900_000;

  it('좌측 트림이면 재투영한다 — 같은 봉이 화면에 남는다', () => {
    const h = makeHarness();
    vi.mocked(createChartEx).mockImplementationOnce(() => h.chart as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    // 한 커밋 더 — prevShape 를 세운다(첫 커밋은 비교 대상이 없다).
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    // contraction 은 좌측 팬이 선행된 상태에서만 발동한다 — hfd 를 실제 시나리오처럼
    // 세워, 프리펜드 게이트의 두 번째 조건(newEarliest >= prevEarliest)을 트림 판별식이
    // 우회해야 함을 함께 잠근다.
    act(() => {
      useLivePageStore.setState({ historicalFromDate: '20260501' });
    });
    const before = h.ts.setVisibleLogicalRange.mock.calls.length;

    // 트림 도착: 첫 봉이 잘린다. 남은 봉들의 union 인덱스가 TRIM_SHIFT 만큼 내려간다.
    h.queueRemap({ shift: -TRIM_SHIFT, pivot: 0 });
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(h.ts.setVisibleLogicalRange.mock.calls.length).toBeGreaterThan(before);
    expect(h.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM - TRIM_SHIFT,
      to: LR_TO - TRIM_SHIFT,
    });
  });

  it('좌단·우단이 함께 바뀌면(소스 교체 모양) 손대지 않는다 — 판별식은 lastMs 불변을 요구한다', () => {
    const h = makeHarness();
    vi.mocked(createChartEx).mockImplementationOnce(() => h.chart as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([FIRST, MIDDLE, LAST])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    act(() => {
      useLivePageStore.setState({ historicalFromDate: '20260501' });
    });
    const before = h.ts.setVisibleLogicalRange.mock.calls.length;

    // 첫 봉 전진 + 개수 감소지만 **마지막 봉도 움직였다** — 트림이 아니라 교체다.
    // 교체의 소유자는 소스 스왑 재착석(2a)이지 이 경로가 아니다.
    //
    // 리매핑을 트림 케이스와 똑같이 큐한다 — 안 하면 shift=0 이라 EPSILON 스킵으로
    // 판별식과 무관하게 통과해, 이 단언이 lastMs 조건을 전혀 잠그지 못한다
    // (red-check 실측: 조건을 빼도 초록이었다).
    h.queueRemap({ shift: -TRIM_SHIFT, pivot: 0 });
    rerender(
      <LiveChartRoot code="005930" timeframe="1m" candleSourceKey="disk"
        bundle={bundleOf([MIDDLE, LAST + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    expect(h.ts.setVisibleLogicalRange.mock.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Crosshair → cursor store (ADR-0044)
// ---------------------------------------------------------------------------

import { useLiveCursorStore } from './useLiveCursorStore';
import {
  hasSyntheticCrosshair,
  markSyntheticCrosshair,
  releaseSyntheticCrosshair,
} from '../chart/syntheticCrosshair';

describe('LiveChartRoot crosshair → cursor store (ADR-0044)', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    vi.mocked(createChartEx).mockClear();
  });

  it('subscribes to crosshair move on minute timeframe', () => {
    // CandleTooltip 의 crosshair 구독은 candleTooltipEnabled 로 게이트된다(#694
    // 이후 기본 off). 세 번째 정당 구독자를 활성화해 그 이상(누수/중복)이 없음을
    // 검증한다 — 툴팁을 안 켜면 구독은 2개뿐이라 이 카운트 단언의 의미가 사라진다.
    useChartPrefsStore.setState({ candleTooltipEnabled: true });
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
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    // Subscribers: (1) LiveChartRoot's cursor-publish effect, (2) PaneLegendOverlay
    // value reader, (3) CandleTooltip — subscribes exactly once, keyed on
    // [chart, enabled] (paneSeries + drawn/index map read via refs/render so SSE
    // ticks and pane registration do NOT resubscribe). A higher count would mean a
    // leaked/duplicate subscription beyond these three legitimate calls.
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(3);
  });

  it('subscribes on calendar timeframe too (publishes cursor for Pane Legend; spot stays minute-only in LiveSidebar)', () => {
    // CandleTooltip 구독은 candleTooltipEnabled(#694 이후 기본 off)로 게이트되므로
    // 켜야 세 번째 구독자가 활성화된다(위 분봉 케이스와 동일).
    useChartPrefsStore.setState({ candleTooltipEnabled: true });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    // Subscribers: (1) LiveChartRoot's cursor-publish effect, (2) PaneLegendOverlay
    // value reader, (3) CandleTooltip — subscribes exactly once, keyed on
    // [chart, enabled] (paneSeries + drawn/index map read via refs/render so SSE
    // ticks and pane registration do NOT resubscribe). A higher count would mean a
    // leaked/duplicate subscription beyond these three legitimate calls.
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(3);
  });

  it('crosshair move → setCursor; crosshair leave → clear cursor for latest mode', async () => {
    vi.useFakeTimers();
    const onCursorActiveChange = vi.fn();
    try {
      render(
        <LiveChartRoot
          code="005930"
          timeframe="1m"
          bundle={DEFAULT_BUNDLE}
          clampEngaged={false}
          isPastCandlesLoading={false}
          onCursorActiveChange={onCursorActiveChange}
        />,
        { wrapper },
      );
      const chart = vi.mocked(createChartEx).mock.results[0].value;
      // Both LiveChartRoot's cursor-publish handler and PaneLegendOverlay's value
      // reader subscribe; the real chart dispatches each crosshair event to ALL
      // subscribers, so fan the synthetic event out to every registered handler
      // (order-independent — only LiveChartRoot's writes the cursor store).
      const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
        chart.subscribeCrosshairMove.mock.calls.forEach(
          ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
        );
      const flushFrame = () => act(() => { vi.advanceTimersByTime(16); });
      // Virtual second 0 → axis.toReal(0) = session_open_ms (virtualMs at/below
      // the origin — segments[0].virtualStart — clamps to the first session
      // open; with the real-anchored origin, 0 sits below it).
      const SESSION_OPEN = DEFAULT_BUNDLE.segments[0].session_open_ms;
      act(() => fire({ time: 0, point: { x: 1 } }));
      flushFrame();
      expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
      // Leading edge of the sidebar-cursor throttle: the first hover after a
      // quiet window publishes immediately (the old trailing debounce made
      // even a single stationary hover wait 120ms).
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(SESSION_OPEN);
      expect(onCursorActiveChange).toHaveBeenLastCalledWith(true);

      act(() => fire({ time: undefined, point: null }));
      expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
      act(() => { vi.advanceTimersByTime(120); });
      expect(useLiveCursorStore.getState().cursorMs).toBeNull();
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
      expect(onCursorActiveChange).toHaveBeenLastCalledWith(false);

      act(() => fire({ time: 0, point: { x: 2 } }));
      flushFrame();
      expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
      act(() => fire({ time: undefined, point: null }));
      act(() => { vi.advanceTimersByTime(240); });
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 동기화 채널(`syncCursorMs`)은 **소비자가 있는 봉만** 쓴다(분봉 · `D`).
   *
   * **이 가드가 막는 방향**: 아무도 받지 않는 봉이 단일 슬롯을 덮어써 유효한 발행을
   * 밀어내는 것. `/live` 실측(2026-08-11)에서 포인터가 분봉 창에 있는데 일봉 창
   * 발행이 슬롯을 가져가 동기화 표시가 사라졌다 — **그때는 일봉에 소비자가 없었다.**
   * 2026-08-21 에 일봉이 소비자가 되면서 그 근거가 일봉에 대해 사라졌고, 술어가
   * `canPublishSyncCursor`(= `isSyncConsumerTimeframe`)로 바뀌었다. W/M 은 여전히
   * 소비자가 없어 발행하지 않는다 — **이 테스트가 지키는 것이 그 남은 절반이다.**
   *
   * **못 보는 것**: 소비 측 필터는 이 테스트가 검증하지 않는다(`cursorSync.test.ts`
   * 담당). 여기서 재는 것은 발행 측이 슬롯에 손대는지 여부뿐이다.
   */
  it('발행 집합은 분봉 + D — W/M 은 동기화 슬롯에 쓰지 않는다', () => {
    vi.useFakeTimers();
    try {
      const fireOn = (timeframe: 'D' | '1m' | 'W') => {
        vi.mocked(createChartEx).mockClear();
        const { unmount } = render(
          <LiveChartRoot
            code="005930"
            timeframe={timeframe}
            bundle={DEFAULT_BUNDLE}
            clampEngaged={false}
            isPastCandlesLoading={false}
          />,
          { wrapper },
        );
        const chart = vi.mocked(createChartEx).mock.results[0].value;
        act(() => chart.subscribeCrosshairMove.mock.calls.forEach(
          ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h({ time: 0, point: { x: 1 } }),
        ));
        act(() => { vi.advanceTimersByTime(16); });
        const s = useLiveCursorStore.getState();
        const snap = { cursorMs: s.cursorMs, syncCursorMs: s.syncCursorMs, syncTf: s.syncCursorOrigin?.timeframe ?? null };
        unmount();
        useLiveCursorStore.getState().resetCursor();
        return snap;
      };

      // 분봉: 커서와 동기화 슬롯 둘 다 선다.
      const minute = fireOn('1m');
      expect(minute.cursorMs).not.toBeNull();
      expect(minute.syncCursorMs).toBe(minute.cursorMs);
      expect(minute.syncTf).toBe('1m');

      // 일봉: 이제 **발행한다**(2026-08-21 — 일봉↔일봉 방향이 생겼다).
      const daily = fireOn('D');
      expect(daily.cursorMs).not.toBeNull();
      expect(daily.syncCursorMs).toBe(daily.cursorMs);
      expect(daily.syncTf).toBe('D');

      // 주봉: **커서는 서는데**(핸들러가 돈 증거) 동기화 슬롯은 그대로 null 이다.
      // 두 단언이 같이 있어야 "게이트가 걸렸다" 와 "이벤트가 안 들어왔다" 가 갈린다.
      const weekly = fireOn('W');
      expect(weekly.cursorMs).not.toBeNull();
      expect(weekly.syncCursorMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles sidebar cursor (leading + trailing) while keeping chart cursor immediate', async () => {
    vi.useFakeTimers();
    try {
      render(
        <LiveChartRoot
          code="005930"
          timeframe="1m"
          bundle={TODAY_ONLY_BUNDLE}
          clampEngaged={false}
          isPastCandlesLoading={false}
        />,
        { wrapper },
      );
      const chart = vi.mocked(createChartEx).mock.results[0].value;
      const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
        chart.subscribeCrosshairMove.mock.calls.forEach(
          ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
        );
      const flushFrame = () => act(() => { vi.advanceTimersByTime(16); });

      // t=16: first hover → leading publish, no 120ms wait.
      act(() => fire({ time: 0, point: { x: 1 } }));
      flushFrame();
      expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS);
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(TODAY_OPEN_MS);

      // t=32: sweep to the next candle inside the throttle window — the chart
      // cursor follows immediately, the sidebar holds the previous value.
      act(() => fire({ time: (TODAY_OPEN_MS + 60_000) / 1000, point: { x: 11 } }));
      flushFrame();
      expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS + 60_000);
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(TODAY_OPEN_MS);

      // Trailing edge fires at lastPublish+120 (= t=136, so 104ms after the
      // move), NOT 120ms after the last movement — continuous motion can no
      // longer starve the sidebar the way the old trailing debounce did.
      act(() => { vi.advanceTimersByTime(103); });
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(TODAY_OPEN_MS);
      act(() => { vi.advanceTimersByTime(1); });
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(TODAY_OPEN_MS + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('transient crosshair clear without coordinates does not blank spot indicators before the next hover', async () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    act(() => fire({ time: 0, point: { x: 1 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_ONLY_BUNDLE.segments[0].session_open_ms);

    act(() => fire({ point: null }));
    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_ONLY_BUNDLE.segments[0].session_open_ms);

    // Next hover lands within the last candle's half-bucket snap window
    // (open+80s vs the candle at open+60s, bucket 60s) → snaps to that candle.
    // Kept inside the window on purpose: beyond lastCandle + bucketMs/2 is now
    // whitespace and would clear the cursor (see the whitespace test below).
    act(() => fire({ time: (TODAY_OPEN_MS + 80_000) / 1000, point: { x: 24 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS + 60_000);
  });

  it('crosshair into the right-offset whitespace (DEFENSIVE numeric-time path) → clears the cursor so the sidebar returns to latest (WS) mode', async () => {
    // DEFENSIVE branch: IF a numeric time past the last candle ever reaches the
    // handler (e.g. seriesData), realMs > lastCandle + bucketMs/2 clears the
    // cursor. In practice (measured 2026-07-09) lwc reports NO time in the
    // right-offset whitespace — param.time undefined AND coordinateToTime null —
    // so the live path is the X-based check covered by the sibling test below.
    // (The earlier "2026-06-11 lwc extrapolates a numeric time" claim was wrong.)
    // TODAY_ONLY_BUNDLE carries one candle so lastCandleMsRef is populated.
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const SESSION_OPEN = TODAY_ONLY_BUNDLE.segments[0].session_open_ms;
    const lastCandleMs = TODAY_ONLY_BUNDLE.candles[TODAY_ONLY_BUNDLE.candles.length - 1].ts_ms;
    const bucketMs = TODAY_ONLY_BUNDLE.bucket_ms;
    expect(lastCandleMs).toBeGreaterThan(SESSION_OPEN); // fixture premise guard
    // On/before the last candle (virtual 0 → session open ≤ last candle) → spot.
    act(() => fire({ time: 0, point: { x: 1 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
    // Half-bucket snap window: a time just past the last candle but within
    // bucketMs/2 still snaps to that candle (nearestCandleMs) → spot preserved,
    // NOT treated as whitespace. param.time is virtual-axis seconds on a
    // REAL-ANCHORED origin (virtualStart = session_open_ms), so
    // toReal(t·1000) = t·1000 inside the session.
    const withinSnapSec = (lastCandleMs + bucketMs / 2 - 1_000) / 1000;
    act(() => fire({ time: withinSnapSec, point: { x: 500 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(lastCandleMs);
    // True whitespace: 10 min past the open — well beyond lastCandle + bucketMs/2
    // → cursor cleared so the sidebar (10호가 / 매물대 / 거래원 / 프로그램 순매수)
    // returns to the live WS edge.
    const whitespaceTimeSec = (TODAY_OPEN_MS + 600_000) / 1000;
    act(() => fire({ time: whitespaceTimeSec, point: { x: 9999 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });

  it('crosshair into the right-offset whitespace (REAL path: no time, X right of last candle) → clears the cursor', async () => {
    // Live mechanism (measured 2026-07-09): past the last candle lwc gives NO
    // time — param.time undefined AND coordinateToTime(x) null — so `t` is null
    // and the numeric branch never runs. The handler must instead detect
    // whitespace by X: pointer right of the last candle's coordinate
    // (timeToCoordinate) → clear the cursor so the sidebar shows the latest WS
    // book. Without this the sidebar pinned to the last candle (stale) — the bug.
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const ts = chart.timeScale();
    vi.mocked(chart.timeScale).mockReturnValue(ts);
    // Whitespace: lwc has no time here.
    vi.mocked(ts.coordinateToTime).mockReturnValue(null);
    // Last candle sits at x=200; whitespace hover is to its right.
    vi.mocked(ts.timeToCoordinate).mockReturnValue(200 as unknown as ReturnType<typeof ts.timeToCoordinate>);
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const lastCandleMs = TODAY_ONLY_BUNDLE.candles[TODAY_ONLY_BUNDLE.candles.length - 1].ts_ms;

    // Internal blank band (X on/left of the last candle at x=200) → still pins.
    act(() => fire({ point: { x: 150 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(lastCandleMs);

    // Right-offset whitespace (X right of the last candle) → cursor cleared.
    act(() => fire({ point: { x: 640 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });

  it('crosshair over a pane separator keeps spot indicators on the candle at that x-coordinate', async () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const ts = chart.timeScale();
    vi.mocked(chart.timeScale).mockReturnValue(ts);
    // Separator x maps to a time inside the last candle's half-bucket snap
    // window (open+80s vs candle at open+60s) → snaps to that candle. Beyond
    // lastCandle + bucketMs/2 would be whitespace and clear the cursor instead.
    vi.mocked(ts.coordinateToTime).mockReturnValue((TODAY_OPEN_MS + 80_000) / 1000);
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    act(() => fire({ point: { x: 240 } }));
    await flush();

    expect(ts.coordinateToTime).toHaveBeenCalledWith(240);
    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS + 60_000);
  });

  it('crosshair clear event from a pane separator keeps spot indicators at the separator x-coordinate', async () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const ts = chart.timeScale();
    vi.mocked(chart.timeScale).mockReturnValue(ts);
    // Within the last candle's half-bucket snap window (see the sibling
    // separator test) → snaps to that candle rather than clearing as whitespace.
    vi.mocked(ts.coordinateToTime).mockReturnValue((TODAY_OPEN_MS + 80_000) / 1000);
    const fire = (p: {
      time?: unknown;
      point?: { x: number } | null;
      sourceEvent?: { localX: number; localY: number };
    }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: {
          time?: unknown;
          point?: { x: number } | null;
          sourceEvent?: { localX: number; localY: number };
        }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    act(() => fire({ point: null, sourceEvent: { localX: 240, localY: 126 } }));
    await flush();

    expect(ts.coordinateToTime).toHaveBeenCalledWith(240);
    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS + 60_000);
  });

  it('crosshair over an indicator series uses the seriesData time instead of pinning to the latest candle', async () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={{
          ...TODAY_ONLY_BUNDLE,
          candles: Array.from({ length: 4 }, (_, i) => ({
            ts_ms: TODAY_OPEN_MS + i * 60_000,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            vol_a: 1,
            vol_b: 0,
          })),
        }}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const ts = chart.timeScale();
    vi.mocked(chart.timeScale).mockReturnValue(ts);
    vi.mocked(ts.coordinateToTime).mockReturnValue(null);
    const fire = (p: {
      time?: unknown;
      point?: { x: number } | null;
      seriesData?: Map<unknown, unknown>;
    }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: {
          time?: unknown;
          point?: { x: number } | null;
          seriesData?: Map<unknown, unknown>;
        }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    act(() => fire({
      point: { x: 240 },
      seriesData: new Map([[{}, { time: (TODAY_OPEN_MS + 120_000) / 1000, value: 100 }]]),
    }));
    await flush();

    expect(ts.coordinateToTime).not.toHaveBeenCalled();
    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS + 120_000);
  });

  it('snaps repeated crosshair movement inside the same candle to one cursor update', async () => {
    const onCandleBasisHover = vi.fn();
    const onCursorActiveChange = vi.fn();
    const bundle = {
      ...TODAY_ONLY_BUNDLE,
      candles: [
        { ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
        { ts_ms: TODAY_OPEN_MS + 120_000, open: 101, high: 102, low: 100, close: 101, vol_a: 1, vol_b: 0 },
      ],
    };
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onCandleBasisHover={onCandleBasisHover}
        onCursorActiveChange={onCursorActiveChange}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    onCandleBasisHover.mockClear();
    onCursorActiveChange.mockClear();
    // Count distinct cursorMs transitions only — the store also gets a
    // sidebarCursorMs write from the throttle's leading edge (same-candle
    // hover), which is a separate field and not what this test guards.
    const cursorChanges: Array<number | null> = [];
    const unsubscribe = useLiveCursorStore.subscribe((state, prev) => {
      if (state.cursorMs !== prev.cursorMs) cursorChanges.push(state.cursorMs);
    });
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    act(() => fire({ time: (TODAY_OPEN_MS + 61_000) / 1000, point: { x: 10 } }));
    await flush();
    act(() => fire({ time: (TODAY_OPEN_MS + 62_000) / 1000, point: { x: 11 } }));
    await flush();
    unsubscribe();

    expect(useLiveCursorStore.getState().cursorMs).toBe(TODAY_OPEN_MS + 60_000);
    expect(cursorChanges).toEqual([TODAY_OPEN_MS + 60_000]);
    expect(onCandleBasisHover).toHaveBeenCalledTimes(1);
    expect(onCursorActiveChange).toHaveBeenCalledTimes(1);
  });

  it('crosshair inside chart whitespace with no resolvable time pins spot indicators to the latest candle', async () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const ts = chart.timeScale();
    vi.mocked(chart.timeScale).mockReturnValue(ts);
    vi.mocked(ts.coordinateToTime).mockReturnValue(null);
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));

    act(() => fire({ point: { x: 240 } }));
    await flush();

    expect(ts.coordinateToTime).toHaveBeenCalledWith(240);
    expect(useLiveCursorStore.getState().cursorMs).toBe(
      TODAY_ONLY_BUNDLE.candles[TODAY_ONLY_BUNDLE.candles.length - 1].ts_ms,
    );
  });

  it('clears cursor when timeframe switches from minute to calendar', () => {
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });
});

/** Build a fresh chart mock that captures any subscribed visible-range
 * handler so the test can invoke it synchronously. */
function buildChartMockCapturing(handlers: Array<(r: unknown) => void>) {
  const ts = {
    subscribeVisibleTimeRangeChange: vi.fn(),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
    subscribeVisibleLogicalRangeChange: (h: (r: unknown) => void) => {
      handlers.push(h);
    },
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
    applyOptions: vi.fn(),
    fitContent: vi.fn(),
    scrollToRealTime: vi.fn(),
    scrollToPosition: vi.fn(),
    setVisibleLogicalRange: vi.fn(), getVisibleLogicalRange: vi.fn(() => null),
    getVisibleRange: vi.fn(() => null),
    setVisibleRange: vi.fn(),
    timeToCoordinate: vi.fn(() => null),
    timeToIndex: vi.fn(() => null),
    width: vi.fn(() => 800),
    height: vi.fn(() => 28),
  };
  return {
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
      update: vi.fn(),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
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
}

// ---------------------------------------------------------------------------
// x-axis tickMarkFormatter — adaptive tiers (2026-05-30 redesign)
//
// The chart now injects a KST horizontal-scale behavior (createChartEx) whose
// weights follow the real KST calendar, so lightweight-charts assigns the
// correct TickMarkType at real boundaries. tickMarkFormatter therefore TRUSTS
// tickType: Month→"N월", DayOfMonth→day, Time→HH:MM. Calendar (D/W/M) suppress
// the intraday Time tiers (daily bars are all anchored to 09:00).
//
// Seam: capture tickMarkFormatter from the createChartEx options (3rd arg).
describe('LiveChartRoot x-axis tickMarkFormatter', () => {
  beforeEach(() => {
    vi.mocked(createChartEx).mockClear();
  });

  function captureTickFormatter(timeframe: 'D' | '1m') {
    render(
      <LiveChartRoot
        code="005930"
        timeframe={timeframe}
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    // createChartEx(container, behavior, options) — options is the 3rd arg.
    const opts = vi.mocked(createChartEx).mock.calls[0][2] as {
      timeScale: { tickMarkFormatter: (t: number, k: TickMarkType) => string };
    };
    return opts.timeScale.tickMarkFormatter;
  }

  // The /live axis is real-anchored: virtual time starts at segments[0]'s
  // REAL session open, not 0 (see createVirtualAxis's originMs — the
  // stale-tick-label fix). So segment[0]'s open in virtual seconds IS its
  // real open in seconds.
  const FIRST_OPEN_SEC = YESTERDAY_OPEN_MS / 1000;
  // One segment's stride on the virtual axis: session length + synthetic gap.
  const SEG_STRIDE_SEC = (TODAY_CLOSE_MS - TODAY_OPEN_MS + INTER_SEGMENT_GAP_MS) / 1000;
  // origin + segment[1].virtualStart offset + 5.5h → real today 14:30 KST
  // (mid-session).
  const MID_SESSION_SEC = FIRST_OPEN_SEC + SEG_STRIDE_SEC + 5.5 * 3600;

  it('1m: Time tick renders HH:MM', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(MID_SESSION_SEC, TickMarkType.Time)).toBe('14:30');
  });

  it('1m: DayOfMonth tick renders the day number', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.DayOfMonth)).toBe('26');
  });

  it('1m: Month tick renders "N월"', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.Month)).toBe('5월');
  });

  it('D (calendar): DayOfMonth tick keeps its day number', () => {
    const fmt = captureTickFormatter('D');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.DayOfMonth)).toBe('26');
  });

  it('D (calendar): Time tick is suppressed (empty)', () => {
    const fmt = captureTickFormatter('D');
    expect(fmt(MID_SESSION_SEC, TickMarkType.Time)).toBe('');
  });

  // -------------------------------------------------------------------------
  // Crosshair label — `localization.timeFormatter`, a DIFFERENT callback from
  // tickMarkFormatter above. The tick formatter draws the fixed marks on the
  // axis; this one draws the badge that follows the mouse. Both live on the
  // same createChartEx options object, so the capture seam is shared.
  //
  // The minute branch used to omit the year ("05/27 14:30"), which is
  // unreadable once you scroll into past years. Calendar (D/W/M) already
  // carried it.
  function captureCrosshairFormatter(timeframe: 'D' | '1m') {
    render(
      <LiveChartRoot
        code="005930"
        timeframe={timeframe}
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const opts = vi.mocked(createChartEx).mock.calls[0][2] as {
      localization: { timeFormatter: (t: number) => string };
    };
    return opts.localization.timeFormatter;
  }

  it('1m: crosshair label leads with the KST year', () => {
    const fmt = captureCrosshairFormatter('1m');
    expect(fmt(MID_SESSION_SEC)).toBe('2026 05/27 14:30');
  });

  it('D (calendar): crosshair label stays date-only with the year', () => {
    const fmt = captureCrosshairFormatter('D');
    expect(fmt(FIRST_OPEN_SEC)).toBe('2026/05/26');
  });
});

// ---------------------------------------------------------------------------
// Regression (2026-05-30): switching minute → calendar (D/W/M) blanked the
// x-axis until a browser refresh.
//
// Root cause: axisRef was mirrored to the latest axis in a passive useEffect,
// which runs AFTER child panes' setData effects (child effects fire before
// parent effects). The injected KST behavior's fillWeightsForPoints runs inside
// that child setData, so on the commit that first pushes the new timeframe's
// candles it read the PREVIOUS axis. The new candles' large virtual times,
// mapped through the old (smaller-range) axis, clamp to a single real time →
// identical KST dates → intraday weights (<50) → the calendar formatter
// suppresses every Time tick → blank axis. Weights are cached, so it stayed
// blank until a fresh mount (refresh). Fix: write axisRef synchronously during
// render so it is current when setData fires.
//
// Harness: the createChartEx mock wires series.setData to invoke the REAL
// injected behavior (arg 1) at setData-time, capturing the weights the behavior
// computes against whatever axis it actually sees during the switch commit.
describe('LiveChartRoot timeframe-switch axis freshness (regression)', () => {
  const ONE_DAY_MINUTE_BUNDLE: RangeBundle = {
    ...TODAY_ONLY_BUNDLE,
    candles: [{ ts_ms: TODAY_OPEN_MS, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 }],
  };

  function dailyBundle(): RangeBundle {
    const DAY = 86_400_000;
    const segments = Array.from({ length: 5 }, (_, i) => ({
      date: `2026052${7 + i}`,
      session_open_ms: TODAY_OPEN_MS + i * DAY,
      session_close_ms: TODAY_CLOSE_MS + i * DAY,
      source: 'kiwoom_live' as const,
    }));
    const candles = segments.map((s) => ({
      ts_ms: s.session_open_ms,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      vol_a: 1,
      vol_b: 0,
    }));
    return { ...TODAY_ONLY_BUNDLE, from_date: '20260527', to_date: '20260531', segments, candles };
  }

  let weightCaptures: number[][] = [];
  let restoreImpl: (() => void) | undefined;

  beforeEach(() => {
    weightCaptures = [];
    const prev = vi.mocked(createChartEx).getMockImplementation();
    restoreImpl = () => {
      if (prev) vi.mocked(createChartEx).mockImplementation(prev);
    };
    vi.mocked(createChartEx).mockImplementation(((_el: unknown, behavior: unknown) => {
      const beh = behavior as {
        fillWeightsForPoints: (pts: Array<{ originalTime: number; timeWeight: number }>, s: number) => void;
      };
      const makeSeries = () => ({
        setData: (data: Array<{ time: number }>) => {
          const points = (data ?? []).map((d) => ({ originalTime: d.time, timeWeight: -1 }));
          if (points.length) {
            beh.fillWeightsForPoints(points, 0);
            weightCaptures.push(points.map((p) => p.timeWeight));
          }
        },
        update: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn(),
        detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      });
      return {
        addSeries: vi.fn(() => makeSeries()),
        removeSeries: vi.fn(),
        timeScale: vi.fn(() => ({
          subscribeVisibleTimeRangeChange: vi.fn(),
          unsubscribeVisibleTimeRangeChange: vi.fn(),
          subscribeVisibleLogicalRangeChange: vi.fn(),
          unsubscribeVisibleLogicalRangeChange: vi.fn(),
          applyOptions: vi.fn(),
          fitContent: vi.fn(),
          scrollToRealTime: vi.fn(),
          scrollToPosition: vi.fn(),
          setVisibleLogicalRange: vi.fn(), getVisibleLogicalRange: vi.fn(() => null),
          getVisibleRange: vi.fn(() => null),
          setVisibleRange: vi.fn(),
          timeToCoordinate: vi.fn(() => null),
        })),
        panes: vi.fn(() => []),
        remove: vi.fn(),
        resize: vi.fn(),
        applyOptions: vi.fn(),
        subscribeCrosshairMove: vi.fn(),
        unsubscribeCrosshairMove: vi.fn(),
      };
    }) as never);
  });

  afterEach(() => {
    restoreImpl?.();
  });

  it('computes calendar-tier weights for daily candles after switching from minute', () => {
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={ONE_DAY_MINUTE_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    weightCaptures = []; // discard the minute-mount captures; only the switch matters
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={dailyBundle()}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Daily candles are one-per-day, so consecutive weights must be Day-tier
    // (50) or higher. With the stale-axis bug every daily candle clamps to one
    // real time → all weights intraday (<50) → the calendar axis renders blank.
    const maxWeight = Math.max(0, ...weightCaptures.flat());
    expect(maxWeight).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Per-view chart remount — cross-view staleness guard
//
// lightweight-charts caches tick weights/marks/labels by time VALUE per chart
// instance, and two different (code, timeframe) views can produce
// value-identical virtual-time ladders with different real-date mappings even
// under real-anchored origins (same-first-trading-day W↔M windows; per-stock
// missing dates under gap compression). The only safe state boundary is a
// fresh chart instance per view — these tests lock that contract.
// ---------------------------------------------------------------------------

describe('LiveChartRoot per-view chart remount (cross-view staleness guard)', () => {
  beforeEach(() => {
    vi.mocked(createChartEx).mockClear();
  });

  function chartProps(code: string, timeframe: '1m' | 'D', bundle: RangeBundle) {
    return { code, timeframe, bundle, clampEngaged: false, isPastCandlesLoading: false } as const;
  }

  it('recreates the lwc chart on a timeframe switch and disposes the old one', () => {
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', TODAY_ONLY_BUNDLE)} />,
      { wrapper },
    );
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(1);
    rerender(<LiveChartRoot {...chartProps('005930', 'D', TODAY_ONLY_BUNDLE)} />);
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(createChartEx).mock.results[0].value as {
      remove: ReturnType<typeof vi.fn>;
    };
    expect(first.remove).toHaveBeenCalledTimes(1);
  });

  it('recreates the chart on a watchlist code switch', () => {
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', TODAY_ONLY_BUNDLE)} />,
      { wrapper },
    );
    rerender(<LiveChartRoot {...chartProps('000660', '1m', TODAY_ONLY_BUNDLE)} />);
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(2);
  });

  it('keeps the chart instance across bundle-only updates (SSE push)', () => {
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', TODAY_ONLY_BUNDLE)} />,
      { wrapper },
    );
    rerender(<LiveChartRoot {...chartProps('005930', '1m', { ...TODAY_ONLY_BUNDLE })} />);
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(1);
  });

  it('applies the initial viewport to the NEW chart after a timeframe switch', () => {
    // Regression (adversarial review F1): on a viewKey switch, the effects of
    // the switch commit still close over the REMOVED chart. lwc viewport
    // calls on a removed chart don't throw, so the one-shot initial-view
    // effect used to fire against the dead instance — consuming
    // lastAppliedCountRef and leaving the new chart at lwc's default ~60-bar
    // view. The keyed chart entry derives `chart` as null for the mismatched
    // commit; this test asserts the viewport lands on the new instance.
    // (Default mock's timeScale() returns a fresh object per call, so build
    // two charts with STABLE timeScale objects to accumulate assertions.)
    useLivePageStore.setState({ historicalFromDate: null });
    function stableChart() {
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
        getVisibleLogicalRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        timeToIndex: vi.fn(() => null),
        width: vi.fn(() => 800),
        height: vi.fn(() => 28),
      };
      const chart = {
        addSeries: vi.fn(() => ({
          setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
          priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
          createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
          removePriceLine: vi.fn(), attachPrimitive: vi.fn(),
          detachPrimitive: vi.fn(), setMarkers: vi.fn(),
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
      return { ts, chart };
    }
    const a = stableChart();
    const b = stableChart();
    vi.mocked(createChartEx)
      .mockImplementationOnce(() => a.chart as never)
      .mockImplementationOnce(() => b.chart as never);

    const withCandles: RangeBundle = {
      ...TODAY_ONLY_BUNDLE,
      candles: [
        { ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
      ],
    };
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', withCandles)} />,
      { wrapper },
    );
    // Minute initial view applied to chart A.
    expect(a.ts.setVisibleLogicalRange).toHaveBeenCalled();

    rerender(<LiveChartRoot {...chartProps('005930', 'D', withCandles)} />);
    // The D initial viewport must land on chart B — with the unkeyed chart
    // state it fired on the removed chart A and B received ZERO viewport calls.
    expect(b.ts.fitContent).not.toHaveBeenCalled();
    expect(b.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 1 + RIGHT_OFFSET });
  });
});

// ---------------------------------------------------------------------------
// Wheel interactions wiring (spec 2026-06-07-live-wheel-interactions)
// ---------------------------------------------------------------------------

describe('LiveChartRoot wheel interactions wiring', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
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

  it('uses the dedicated chart-pane-divider token for pane separators', () => {
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
    const options = vi.mocked(createChartEx).mock.calls.at(-1)![2] as {
      layout?: { textColor?: string; panes?: { separatorColor?: string; separatorHoverColor?: string } };
    };
    // Dedicated --chart-pane-divider (dark fallback). 2026-07-15 완화: 이전
    // #63636F(Δ~80)는 화면 최강 선이라 border-strong 근처 #3a3a42(Δ~35)로 낮췄다.
    expect(options.layout?.panes?.separatorColor).toBe('#3a3a42');
    // 호버는 DESIGN.md 의 승인된 --tint-selection(primary hover, accent 추적)이다
    // (#703). 테스트 DOM 엔 테마 CSS 가 없어 TOKEN_SPEC 폴백값으로 해석된다.
    expect(options.layout?.panes?.separatorHoverColor).toBe('rgba(240, 180, 41, 0.10)');
    expect(options.layout?.panes?.separatorHoverColor).not.toBe(options.layout?.textColor);
  });

  it('initializes chart grid visibility from saved settings', () => {
    useChartPrefsStore.getState().setToggle('horizontalGridLinesEnabled', false);
    useChartPrefsStore.getState().setToggle('verticalGridLinesEnabled', false);

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

    const options = vi.mocked(createChartEx).mock.calls.at(-1)![2] as {
      grid?: {
        vertLines?: { visible?: boolean };
        horzLines?: { visible?: boolean };
      };
    };
    expect(options.grid?.horzLines?.visible).toBe(false);
    expect(options.grid?.vertLines?.visible).toBe(false);
  });

  it('applies grid visibility changes without recreating the chart', async () => {
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

    const chart = vi.mocked(createChartEx).mock.results.at(-1)!.value as {
      applyOptions: ReturnType<typeof vi.fn>;
    };
    chart.applyOptions.mockClear();

    await act(async () => {
      useChartPrefsStore.getState().setToggle('horizontalGridLinesEnabled', false);
    });

    expect(createChartEx).toHaveBeenCalledTimes(1);
    expect(chart.applyOptions).toHaveBeenLastCalledWith({
      grid: {
        vertLines: expect.objectContaining({ visible: true }),
        horzLines: expect.objectContaining({ visible: false }),
      },
    });
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
      // 줌아웃 플로어(maxSpan = width/minBarSpacing = 2000) — 이 테스트의
      // 요청 span(≈110.5)에는 발동하지 않는 값.
      width: vi.fn(() => 1000),
      // DEFAULT_BUNDLE은 candles 빈 배열이라 lastMs undefined → timeToIndex 미호출,
      // plain 앵커는 to-고정 폴백(to=100 유지). 방어적으로 둔다.
      timeToIndex: vi.fn(() => null),
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
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
    // 휠 리스너는 container의 부모(live-chart-root)에 부착되므로(형제 DrawingOverlay
    // 위 휠도 받기 위함 — useWheelInteractions 주석 참조), container에서 dispatch한
    // 이벤트가 부모 리스너에 도달하려면 bubbles:true가 필요하다(실제 브라우저 wheel과
    // 동일; jsdom 합성 이벤트의 bubbles 기본값은 false).
    const container = screen.getByTestId('live-chart-root').firstElementChild!;
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true }));

    // 마지막 호출이 휠 결과여야 한다 (초기 뷰 effect의 호출이 선행할 수 있음).
    const last = ts.setVisibleLogicalRange.mock.calls.at(-1)![0] as { from: number; to: number };
    expect(last.to).toBe(100);
    expect(last.from).toBeCloseTo(100 - 100 * Math.exp(0.1), 6); // ≈ -10.517
  });
});

// ---------------------------------------------------------------------------
// Pane 크기 가중치 (Pane Stretch, #703) — separator 드래그 영속화 + 스냅백 방지
// ---------------------------------------------------------------------------

describe('LiveChartRoot pane stretch (Pane 크기 가중치, #703)', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
    // 공장 기본값(#694)은 호가 pane 4종을 끈다 — 6-pane 시나리오를 재현하려면
    // 명시적으로 켜서 candle+volume+호가 4종이 모두 마운트되게 한다.
    useLivePageStore.setState({
      historicalFromDate: null,
      paneStretch: {},
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      programTradeEnabled: true,
    });
    vi.mocked(createChartEx).mockClear();
  });

  const makePane = (stretch: number) => ({
    setStretchFactor: vi.fn(),
    getStretchFactor: vi.fn(() => stretch),
    // PaneLegendOverlay 가 pane top 오프셋 계산에 사용한다(드래그 캡처는 아님).
    getHeight: vi.fn(() => 100),
  });

  // 1m 기본 토글 = candle, volume, quote-totals, ratio, fill-strength,
  // program-trade 6개 pane.
  const makeChartWithPanes = (panes: ReturnType<typeof makePane>[]) => ({
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
      update: vi.fn(),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      setMarkers: vi.fn(),
    })),
    removeSeries: vi.fn(),
    timeScale: vi.fn(() => ({
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleLogicalRange: vi.fn(() => null),
      getVisibleRange: vi.fn(() => null),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
      coordinateToTime: vi.fn(() => null),
      coordinateToLogical: vi.fn(() => null),
      width: vi.fn(() => 800),
      height: vi.fn(() => 28),
      timeToIndex: vi.fn(() => null),
    })),
    panes: vi.fn(() => panes),
    remove: vi.fn(),
    resize: vi.fn(),
    applyOptions: vi.fn(),
    options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    chartElement: vi.fn(() => ({ clientWidth: 800, clientHeight: 400 })),
  });

  const flushRaf = async () => {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  };

  it('applies saved Pane Stretch over spec defaults, and keeps it across bundle churn', async () => {
    const panes = Array.from({ length: 6 }, () => makePane(1));
    const chart = makeChartWithPanes(panes);
    vi.mocked(createChartEx).mockReturnValue(chart as never);
    useLivePageStore.setState({ paneStretch: { candle: 2.5 } });

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushRaf();

    // 저장값 우선(candle=2.5), 미저장 pane 은 스펙 기본값(volume=0.3).
    expect(panes[0].setStretchFactor).toHaveBeenCalledWith(2.5);
    expect(panes[1].setStretchFactor).toHaveBeenCalledWith(0.3);

    // 스냅백 회귀 가드: 캔들 번들 identity 가 바뀌어도(실시간 틱·refetch 모사)
    // 재적용값은 여전히 저장값이다 — 스펙 기본값(1.4)으로 되돌리지 않는다.
    panes[0].setStretchFactor.mockClear();
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={{ ...DEFAULT_BUNDLE }}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    await flushRaf();
    const calls = panes[0].setStretchFactor.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([v]) => v === 2.5)).toBe(true);
  });

  it('captures pane stretch to the store when a separator drag ends', async () => {
    const panes = [3.3, 0.7, 0.5, 0.4, 0.4, 0.3].map(makePane);
    const chart = makeChartWithPanes(panes);
    vi.mocked(createChartEx).mockReturnValue(chart as never);

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
    await flushRaf();

    // lwc separator 핸들 모사 — 차트 내부에서 inline cursor:row-resize 를 가진
    // 유일한 요소라는 계약으로 식별된다(LiveChartRoot 드래그 캡처 참조).
    const el = vi.mocked(createChartEx).mock.calls.at(-1)![0] as HTMLElement;
    const handle = document.createElement('div');
    handle.style.cursor = 'row-resize';
    el.appendChild(handle);

    await act(async () => {
      handle.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      window.dispatchEvent(new Event('pointerup'));
    });

    expect(useLivePageStore.getState().paneStretch).toEqual({
      candle: 3.3,
      volume: 0.7,
      'quote-totals': 0.5,
      ratio: 0.4,
      'fill-strength': 0.4,
      'program-trade': 0.3,
    });
    // 영속까지: live.indicators.v2 에 실렸는지.
    const persisted = JSON.parse(localStorage.getItem('live.indicators.v2') ?? '{}');
    expect(persisted.paneStretch?.candle).toBe(3.3);
  });

  it('ignores pointerdown that does not start on a separator handle', async () => {
    const panes = Array.from({ length: 6 }, () => makePane(9.9));
    const chart = makeChartWithPanes(panes);
    vi.mocked(createChartEx).mockReturnValue(chart as never);

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
    await flushRaf();

    const el = vi.mocked(createChartEx).mock.calls.at(-1)![0] as HTMLElement;
    await act(async () => {
      el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      window.dispatchEvent(new Event('pointerup'));
    });

    expect(useLivePageStore.getState().paneStretch).toEqual({});
  });

  it('does not leak the drag pointerup listener when the chart unmounts mid-drag', async () => {
    const panes = [3.3, 0.7, 0.5, 0.4, 0.4, 0.3].map(makePane);
    const chart = makeChartWithPanes(panes);
    vi.mocked(createChartEx).mockReturnValue(chart as never);

    const { unmount } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushRaf();

    const el = vi.mocked(createChartEx).mock.calls.at(-1)![0] as HTMLElement;
    const handle = document.createElement('div');
    handle.style.cursor = 'row-resize';
    el.appendChild(handle);

    // 드래그 시작 후 종료 없이 언마운트 — cleanup 이 pointerup 리스너를 떼야 한다.
    await act(async () => {
      handle.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    useLivePageStore.setState({ paneStretch: {} });
    unmount();

    // 언마운트 후 뒤늦게 도착한 pointerup 은 stale 클로저를 발화시키지 않는다.
    await act(async () => {
      window.dispatchEvent(new Event('pointerup'));
    });
    expect(useLivePageStore.getState().paneStretch).toEqual({});
  });
});

/**
 * sync 소비 창이 스팟 커서를 **덮어쓰지** 않는다.
 *
 * 소유자 가드(clear 쪽)로는 이 경로를 못 막는다 — 지우는 게 아니라 **쓰는** 경로다.
 * `CursorSyncCrosshair` 가 `setCrosshairPosition` 을 걸어 두면 그 뒤 데이터 갱신마다
 * lwc 가 crosshairMove 를 재발화하고, 그 이벤트로 발행하면 옆 창의 유효한 발행을
 * 내 origin 으로 덮는다. 2026-08-12 실측(분봉+일봉 두 창): 25초에 분봉 97회 /
 * 일봉 96회로 핑퐁, `null` 은 0회 — 덮어쓴 origin 의 봉이 `D` 라 소비 측이
 * inactive 로 떨어져 10호가·거래원이 함께 latest 를 그렸다.
 *
 * **막는 방향**: sync 로 그려진 크로스헤어의 재발화가 남의 발행을 덮는 것.
 * **못 보는 것**: 실제 포인터 입력은 통과시킨다(사용자가 그 창으로 옮기면 발행자가
 * 바뀌는 게 맞다) — 아래 두 번째 단언이 그 방향을 고정한다.
 */
describe('LiveChartRoot — sync 소비 창의 발행 억제', () => {
  const OTHER = { windowId: 'other-window', group: 1, code: '005930', timeframe: '1m' as const };

  function renderWithCrosshair() {
    let crosshairHandler:
      | ((p: { time?: unknown; point?: { x: number } | null; sourceEvent?: unknown }) => void)
      | null = null;
    const realMs = Date.UTC(2026, 5, 19, 0, 0, 0);
    const bundle: RangeBundle = {
      ...DEFAULT_BUNDLE,
      from_date: '20260619',
      to_date: '20260619',
      segments: [{ date: '20260619', session_open_ms: realMs, session_close_ms: realMs + 23400000, source: 'kiwoom_live' }],
      candles: [{ ts_ms: realMs, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
    } as unknown as RangeBundle;
    const base = vi.mocked(createChartEx).getMockImplementation();
    const chart = base ? (base as unknown as () => Record<string, unknown>)() : {};
    (chart as Record<string, unknown>).subscribeCrosshairMove = vi.fn((h) => { crosshairHandler = h; });
    (chart as Record<string, unknown>).unsubscribeCrosshairMove = vi.fn();
    vi.mocked(createChartEx).mockReturnValueOnce(chart as never);
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={bundle} clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    const axis = createVirtualAxis(
      [{ date: '20260619', sessionOpenMs: realMs, sessionCloseMs: realMs + 23400000 }],
      realMs,
    );
    // ⚠ **합성 표시를 여기서 씻는다.** 이 하네스는 `getMockImplementation()` 이 준
    // 팩토리로 차트를 만드는데, 앞 스펙이 `mockReturnValueOnce` 를 걸어 두면 그
    // 팩토리가 **같은 인스턴스를 다시 준다**(실측: 두 스펙의 chart 가 동일 객체).
    // 표시는 인스턴스별이라 앞 스펙이 남긴 것이 그대로 새고, 그러면 "합성이 아닐 때"
    // 를 재는 스펙이 파일 단독 실행에서만 빨개진다(단일 `-t` 실행에서는 초록이라
    // 더 나쁘다).
    releaseSyntheticCrosshair(chart as never);
    return {
      fire: () => crosshairHandler,
      vsec: realMsToVirtualSeconds(axis, realMs),
      // 합성 표시는 **차트 인스턴스별**이라 테스트가 같은 객체를 쥐어야 한다.
      chart: chart as never,
    };
  }

  const flushRaf = async () => {
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)); });
  };

  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
  });

  it('sourceEvent 없는 재발화는 옆 창의 발행을 덮어쓰지 않는다', async () => {
    const { fire, vsec } = renderWithCrosshair();
    act(() => {
      useLiveCursorStore.getState().setSidebarCursor(1_000_000, OTHER);
      useLiveCursorStore.getState().setSyncCursor(1_000_000, OTHER);
    });

    act(() => { fire()?.({ time: vsec, point: { x: 10 } }); });
    await flushRaf();

    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.windowId).toBe('other-window');
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1_000_000);
  });

  /**
   * 2026-08-21 에 **일봉도 발행자**가 되면서 생긴 새 배치: 슬롯 주인이 일봉 창이고
   * 이 분봉 창은 그 발행을 받아 크로스헤어를 그린 쪽이다.
   *
   * 그 상태에서 lwc 가 데이터 갱신마다 `crosshairMove` 를 **재발화**하는데(실측 초당
   * ~8회, 전부 `sourceEvent` 없음), 그걸로 발행하면 일봉 주인의 유효한 발행을 이
   * 창 origin 으로 덮는다 — 2026-08-12 핑퐁(25초에 두 창이 97·96회)이 그 증상이었다.
   * 가드는 봉을 보지 않으므로 원리상 그대로 걸리지만, **그 무관함을 단언으로 고정**해
   * 둔다. 실브라우저 도그푸딩은 이 축을 재지 못한다 — 프록시 환경에서는 WS 가 끊겨
   * 재발화를 일으키는 데이터 갱신 자체가 오지 않는다(2026-08-21 실측: 6초 40샘플
   * 소유자 전환 0회, 단 트리거 부재).
   */
  it('일봉 창이 슬롯 주인일 때도 재발화가 덮어쓰지 않는다', async () => {
    const DAILY_OWNER = {
      windowId: 'daily-window', group: 1, code: '000660', timeframe: 'D' as const,
    };
    const { fire, vsec } = renderWithCrosshair();
    act(() => {
      useLiveCursorStore.getState().setSidebarCursor(1_000_000, DAILY_OWNER);
      useLiveCursorStore.getState().setSyncCursor(1_000_000, DAILY_OWNER);
    });

    act(() => { fire()?.({ time: vsec, point: { x: 10 } }); });
    await flushRaf();

    expect(useLiveCursorStore.getState().syncCursorOrigin?.windowId).toBe('daily-window');
    expect(useLiveCursorStore.getState().syncCursorMs).toBe(1_000_000);
    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.windowId).toBe('daily-window');
  });

  /**
   * 2026-08-24 실측 버그. 위 세 스펙이 지키는 소유자 가드는 슬롯에 **주인이 있을 때**만
   * 판정한다 — 슬롯이 `null` 인 순간은 통째로 열려 있다.
   *
   * 그 순간이 실제로 온다: 발행 창이 캔들 오른쪽 빈 공간으로 들어가면 자기 발행을
   * 지운다. 그 직후 이 창(합성 크로스헤어를 들고 있던 소비 창)의 **미뤄진 재발화**가
   * 착지하면 아래 발행이 성립하고, 포인터가 있는 저쪽 창이 그걸 받아 크로스헤어가
   * 임의 캔들로 튄다. 주인이 바뀐 탓에 저쪽은 자기 정리 경로로 지우지도 못해
   * 틱마다(초당 2~8회) 되돌아온다 — `/browse` 15 사이클 중 2회 재현.
   *
   * **막는 방향**: 합성 크로스헤어에서 나온 재발화가 **빈** 슬롯을 차지하는 것.
   * **못 보는 것**: 합성이 아닌 재발화(= 포인터가 멈춰 있는 창의 재획득)는 그대로
   * 통과해야 한다 — 두 번째 스펙이 그 방향을 고정한다. 셋째는 실제 포인터가
   * 합성 표시보다 세다는 것.
   * **등록 의존**: 표시는 `CursorSyncCrosshair` 가 남긴다(그쪽 스펙이 그 절반).
   */
  describe('빈 슬롯을 합성 재발화가 차지하지 못한다', () => {
    it('합성 크로스헤어의 재발화는 빈 슬롯에도 발행하지 않는다', async () => {
      const { fire, vsec, chart } = renderWithCrosshair();
      markSyntheticCrosshair(chart);           // 옆 창 발행을 받아 그린 상태
      expect(useLiveCursorStore.getState().syncCursorMs).toBeNull(); // 슬롯은 비어 있다

      act(() => { fire()?.({ time: vsec, point: { x: 10 } }); });
      await flushRaf();

      expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
      expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
    });

    it('합성이 아니면 빈 슬롯을 되찾는다 — 정지 호버의 재획득 경로', async () => {
      const { fire, vsec, chart } = renderWithCrosshair();
      expect(hasSyntheticCrosshair(chart)).toBe(false);

      act(() => { fire()?.({ time: vsec, point: { x: 10 } }); });
      await flushRaf();

      expect(useLiveCursorStore.getState().syncCursorMs).not.toBeNull();
    });

    it('합성 표시가 있어도 실제 포인터는 통과한다', async () => {
      const { fire, vsec, chart } = renderWithCrosshair();
      markSyntheticCrosshair(chart);

      act(() => { fire()?.({ time: vsec, point: { x: 10 }, sourceEvent: { localX: 10 } }); });
      await flushRaf();

      expect(useLiveCursorStore.getState().syncCursorMs).not.toBeNull();
    });

    it('⚠ 판정은 **이벤트 시점**이다 — rAF 안에서 읽으면 해제와의 경쟁에 진다', async () => {
      // 실측 순서: 옆 창이 슬롯 비움 → 이 창 cleanup(합성 해제) → 미뤄진 rAF 발행.
      // 표시를 rAF 안에서 읽으면 그때는 이미 해제된 뒤라 가드가 통째로 무력해진다.
      const { fire, vsec, chart } = renderWithCrosshair();
      markSyntheticCrosshair(chart);

      act(() => { fire()?.({ time: vsec, point: { x: 10 } }); });
      act(() => { releaseSyntheticCrosshair(chart); });   // rAF 가 돌기 **전에** 해제
      await flushRaf();

      expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
    });
  });

  it('실제 포인터 이벤트는 통과한다 — 그 창으로 마우스를 옮기면 발행자가 바뀐다', async () => {
    const { fire, vsec } = renderWithCrosshair();
    act(() => {
      useLiveCursorStore.getState().setSidebarCursor(1_000_000, OTHER);
      useLiveCursorStore.getState().setSyncCursor(1_000_000, OTHER);
    });

    act(() => { fire()?.({ time: vsec, point: { x: 10 }, sourceEvent: { localX: 10 } }); });
    await flushRaf();

    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.windowId).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).not.toBe(1_000_000);
  });
});
