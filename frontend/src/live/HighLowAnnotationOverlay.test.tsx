import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Time } from 'lightweight-charts';
import HighLowAnnotationOverlay, {
  placeExtremeLabel,
  type AvoidRect,
  type AvoidWallLabel,
} from './HighLowAnnotationOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Candle, RangeBundle } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';

const OPEN = Date.UTC(2026, 5, 12, 0, 0, 0); // 09:00 KST
const CLOSE = OPEN + 6.5 * 3_600_000;
const axis = createVirtualAxis(
  [{ date: '20260612', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }],
  OPEN,
);

function candle(tsMs: number, high: number, low: number, close: number): Candle {
  return { ts_ms: tsMs, open: close, close, high, low, vol_a: 0, vol_b: 0 };
}

// 고가 38,800 @09:02 / 저가 36,750 @09:03 / 현재가(마지막 종가) 37,100.
const bundle = {
  candles: [
    candle(OPEN + 60_000, 37_000, 36_900, 36_950),
    candle(OPEN + 120_000, 38_800, 38_000, 38_200),
    candle(OPEN + 180_000, 37_500, 36_750, 37_100),
  ],
} as RangeBundle;

function makeChart(timeToCoordinate: () => number | null) {
  return {
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
      getVisibleRange: () => ({ from: OPEN / 1000, to: CLOSE / 1000 }),
      getVisibleLogicalRange: () => null,
      timeToCoordinate,
    }),
  } as never;
}

function paneSeries(priceToCoordinate: (price: number) => number | null, paneHeight = 0): PaneSeriesMap {
  // getPane().getHeight() = 캔들 pane 높이(라벨 세로 고정 기준). 캔들은 pane 0(최상단)이라
  // top=0, bottom=이 값. jsdom 기본(paneHeight=0)이면 placeExtremeLabel fallback 경로.
  return new Map([
    [
      'candle' as PaneId,
      { priceToCoordinate, getPane: () => ({ getHeight: () => paneHeight }) } as never,
    ],
  ]) as never;
}

function renderOverlay(opts?: {
  timeToCoordinate?: () => number | null;
  priceToCoordinate?: (price: number) => number | null;
  paneHeight?: number;
  bundle?: RangeBundle;
  avoidWallLabels?: readonly AvoidWallLabel[];
}) {
  return render(
    <HighLowAnnotationOverlay
      chart={makeChart(opts?.timeToCoordinate ?? (() => 100))}
      bundle={opts?.bundle ?? bundle}
      axis={axis}
      paneSeries={paneSeries(opts?.priceToCoordinate ?? (() => 50), opts?.paneHeight)}
      timeframe="1m"
      avoidWallLabels={opts?.avoidWallLabels}
    />,
  );
}

describe('HighLowAnnotationOverlay', () => {
  beforeEach(() => useChartPrefsStore.setState({ highLowLabelsEnabled: true }));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the high (빨강) and low (파랑) extreme labels when enabled', () => {
    renderOverlay();
    expect(screen.getByTestId('highlow-label-high')).toHaveTextContent('38,800원');
    expect(screen.getByTestId('highlow-label-high')).toHaveTextContent('09:02');
    expect(screen.getByTestId('highlow-label-low')).toHaveTextContent('36,750원');
    // 극값 대비율 부호: 현재가 37,100 → 고가 음수, 저가 양수.
    expect(screen.getByTestId('highlow-label-high').textContent).toMatch(/-\d+\.\d{2}%/);
    expect(screen.getByTestId('highlow-label-low').textContent).toMatch(/\+\d+\.\d{2}%/);
  });

  it('draws leader lines connecting each dot to its edge-pinned label', () => {
    renderOverlay();
    expect(screen.getByTestId('highlow-leader-high')).toBeInTheDocument();
    expect(screen.getByTestId('highlow-leader-low')).toBeInTheDocument();
  });

  it('pins labels to the CANDLE pane height, not the full overlay/chart height', () => {
    // 컨테이너(=전체 차트)는 999px 높이지만 캔들 pane 은 200px. 저가 라벨은 캔들 pane
    // 하단(200-6=194)에 고정돼야 하고, 전체 차트 하단(999-6=993)에 붙으면 회귀다.
    // 첫 렌더엔 containerRef==null 이라 placeExtremeLabel fallback → ResizeObserver
    // initial observe 로 재렌더돼 self-heal 하는 실제 경로를 mock 으로 재현(jsdom 무 RO).
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 760, height: 999, top: 0, left: 0, right: 760, bottom: 999, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const rafSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => (cb(0), 0));
    class MockRO {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe() {
        this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockRO);
    try {
      renderOverlay({ paneHeight: 200 });
      expect(screen.getByTestId('highlow-label-high').style.top).toBe('6px');
      expect(screen.getByTestId('highlow-label-low').style.top).toBe('194px');
    } finally {
      rectSpy.mockRestore();
      rafSpy.mockRestore();
    }
  });

  it('derives avoid rects from wall inputs via coordinate conversion at render (fresh, not pre-baked pixels)', () => {
    // 회귀 가드: 회피 rect 는 상위에서 픽셀로 구워 넘기지 않고, 오버레이 렌더가 매 프레임
    // {price, time1}을 priceToCoordinate/timeToCoordinate 로 변환해야 한다(축 리스케일
    // 정합). wall 가격을 상단 가장자리 근처(y=15)로 매핑하면 x-겹침인 top 고정 고가
    // 라벨이 그 칩 rect 를 피해 아래로 밀린다. 픽셀을 구워 넘기면 prop 을 무시해 6px 유지.
    const WALL_PRICE = 38_805;
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 760, height: 300, top: 0, left: 0, right: 760, bottom: 300, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const rafSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => (cb(0), 0));
    class MockRO {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe() {
        this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockRO);
    try {
      renderOverlay({
        paneHeight: 300,
        priceToCoordinate: (price) => (price === WALL_PRICE ? 15 : 150),
        // timeToCoordinate 목=100 → 칩 rect x≈[102,190] — 고가 라벨 x 구간과 교차.
        avoidWallLabels: [{ price: WALL_PRICE, time1: (CLOSE / 1000) as Time, label: '38,805, 1.2M' }],
      });
      // 상단 고정(6px)이던 고가 라벨이 wall 칩 rect(y≈15 선 위)를 피해 아래로 밀림.
      expect(screen.getByTestId('highlow-label-high').style.top).toBe('15px');
    } finally {
      rectSpy.mockRestore();
      rafSpy.mockRestore();
    }
  });

  it('avoids the candle-pane legend rows measured from the sibling DOM overlay', () => {
    // 극값 봉이 좌측(레전드 아래)일 때 상단 고정 고가 라벨이 Pane Legend 행과 겹치던
    // 결함의 회귀 가드. 레전드는 형제 오버레이 DOM 실측 — 행 rect 와 x·y 모두 교차하면
    // 고가 라벨이 그 행 아래로 밀린다.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function measure(this: HTMLElement) {
        if (this.hasAttribute('data-legend-row')) {
          return {
            width: 640, height: 26, top: 4, left: 0, right: 640, bottom: 30, x: 0, y: 4,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          width: 760, height: 300, top: 0, left: 0, right: 760, bottom: 300, x: 0, y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    const rafSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => (cb(0), 0));
    class MockRO {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe() {
        this.cb([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockRO);
    try {
      render(
        <div>
          <div data-testid="pane-legend-overlay">
            <div>
              <div data-legend-row="" />
            </div>
          </div>
          <HighLowAnnotationOverlay
            chart={makeChart(() => 100)}
            bundle={bundle}
            axis={axis}
            paneSeries={paneSeries(() => 150, 300)}
            timeframe="1m"
          />
        </div>,
      );
      // 레전드 행 rect {top:4, bottom:30, left:0, right:640} 아래로 밀림(30+2=32).
      expect(screen.getByTestId('highlow-label-high').style.top).toBe('32px');
      // 하단 고정 저가 라벨은 레전드와 무관 — 가장자리 유지(300-6=294).
      expect(screen.getByTestId('highlow-label-low').style.top).toBe('294px');
    } finally {
      rectSpy.mockRestore();
      rafSpy.mockRestore();
    }
  });

  it('renders nothing when the toggle is off', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: false });
    renderOverlay();
    expect(screen.queryByTestId('highlow-label-high')).toBeNull();
    expect(screen.queryByTestId('highlow-label-low')).toBeNull();
  });

  it('skips a label when its coordinate is null (right empty band / off-range)', () => {
    renderOverlay({ timeToCoordinate: () => null });
    expect(screen.queryByTestId('highlow-label-high')).toBeNull();
    expect(screen.queryByTestId('highlow-label-low')).toBeNull();
  });

  it('still renders the container (no labels) when there are no visible extremes', () => {
    // 빈 캔들 → 극값 없음. 컨테이너는 남아 ResizeObserver 가 관측할 노드를 보장(self-heal).
    renderOverlay({ bundle: { candles: [] as Candle[] } as RangeBundle });
    expect(screen.getByTestId('highlow-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('highlow-label-high')).toBeNull();
  });

  it('observes the overlay container with a ResizeObserver (resize self-heal wiring)', () => {
    let observed: Element | null = null;
    class MockRO {
      observe(el: Element) {
        observed = el;
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockRO);

    renderOverlay();

    expect(observed).not.toBeNull();
    expect(observed).toBe(screen.getByTestId('highlow-overlay'));
  });
});

describe('placeExtremeLabel', () => {
  // pane 760×180, LABEL_EDGE_PAD_PX=6, LABEL_HEIGHT_PX=16. above 앵커=라벨 top,
  // below 앵커=라벨 bottom. 라벨 x=440, 텍스트 30자 → x 구간 대략 [337,543].
  const highLabelBox = (y: number) => ({ top: y, bottom: y + 16 });
  const lowLabelBox = (y: number) => ({ top: y - 16, bottom: y });
  // 도킹 wall 칩 rect 근사: 선 y 위 {top: lineY-15, bottom: lineY-2} × 주어진 x 구간.
  const wallRect = (lineY: number, left = 300, right = 600): AvoidRect => ({
    top: lineY - 3 - 11 - 1,
    bottom: lineY - 3 + 1,
    left,
    right,
  });
  const disjoint = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
    a.bottom <= b.top || a.top >= b.bottom;

  it('pins the high label to the top edge regardless of the dot y', () => {
    // dot 이 pane 아래쪽(120)에 있어도 라벨은 상단 가장자리에 고정.
    expect(placeExtremeLabel('above', 140, 120, '59,300원 (-3.90%, 06.09 10:00)', 760, 180)).toMatchObject({
      place: 'above',
      y: 6,
    });
  });

  it('pins the low label to the bottom edge regardless of the dot y', () => {
    expect(placeExtremeLabel('below', 140, 40, '58,900원 (+1.20%, 06.09 10:00)', 760, 180)).toMatchObject({
      place: 'below',
      y: 174,
    });
  });

  it('keeps labels inside the horizontal pane edges', () => {
    const left = placeExtremeLabel('above', 20, 80, '59,300원 (-3.90%, 06.09 10:00)', 760, 180);
    const right = placeExtremeLabel('below', 750, 80, '58,900원 (+1.20%, 06.09 10:00)', 760, 180);

    expect(left.x).toBeGreaterThan(20);
    expect(right.x).toBeLessThan(750);
  });

  it('pushes a top-pinned high label down past an overlapping rect near the top edge', () => {
    // wall line 20 → rect y {5,18} overlaps the top-edge high box {6,22}. 라벨은 아래로 양보.
    const high = placeExtremeLabel('above', 440, 60, '60,000원 (-13.59%, 06.10 09:30)', 760, 180, [wallRect(20)]);

    expect(high.place).toBe('above');
    expect(high.y).toBeGreaterThan(6);
    expect(disjoint(highLabelBox(high.y), wallRect(20))).toBe(true);
  });

  it('pushes a bottom-pinned low label up past an overlapping rect near the bottom edge', () => {
    // wall line 170 → rect y {155,168} overlaps the bottom-edge low box {158,174}. 라벨은 위로 양보.
    const low = placeExtremeLabel('below', 440, 120, '58,700원 (+2.10%, 06.10 09:30)', 760, 180, [wallRect(170)]);

    expect(low.place).toBe('below');
    expect(low.y).toBeLessThan(174);
    expect(disjoint(lowLabelBox(low.y), wallRect(170))).toBe(true);
  });

  it('ignores a rect that is horizontally disjoint from the label (2D check, not y-only)', () => {
    // 같은 y 대역(상단 가장자리)이지만 x 구간이 라벨(≈[337,543])과 안 겹치는 칩 —
    // 우측에 도킹된 wall 라벨이 좌측 극값 라벨을 밀어내던 유령 push 의 회귀 가드.
    const high = placeExtremeLabel(
      'above', 440, 60, '60,000원 (-13.59%, 06.10 09:30)', 760, 180,
      [wallRect(20, 600, 700)],
    );
    expect(high.y).toBe(6);
  });

  it('leaves the label at the edge when no rect is near it', () => {
    // wall line 96 → rect y {81,94} sits mid-pane, far from the top-edge high box {6,22}.
    const high = placeExtremeLabel('above', 440, 60, '60,000원 (-13.59%, 06.10 09:30)', 760, 180, [wallRect(96)]);
    expect(high.y).toBe(6);
  });

  it('reverts to the edge when avoidance would push the label deeper than the shift cap', () => {
    // 하단 가장자리부터 pane 중간 위까지 이어지는 큰 회피 rect — 이를 다 피하려면
    // 116px(> 180×0.3=54) 밀려 pane 중간에 뜬다. 겹침을 감수하고 가장자리(174) 복귀.
    const low = placeExtremeLabel(
      'below', 440, 120, '58,700원 (+2.10%, 06.10 09:30)', 760, 180,
      [{ top: 60, bottom: 172, left: 300, right: 600 }],
    );
    expect(low.y).toBe(174);
  });

  it('falls back to the original point before pane size is known', () => {
    expect(placeExtremeLabel('above', 20, 12, '59,300원 (-3.90%, 06.09 10:00)', 0, 0)).toEqual({
      place: 'above',
      x: 20,
      y: 12,
    });
  });
});
