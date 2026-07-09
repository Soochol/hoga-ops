import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import HighLowAnnotationOverlay, { placeExtremeLabel } from './HighLowAnnotationOverlay';
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
      timeToCoordinate,
    }),
  } as never;
}

function paneSeries(priceToCoordinate: () => number | null, paneHeight = 0): PaneSeriesMap {
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
  priceToCoordinate?: () => number | null;
  paneHeight?: number;
  bundle?: RangeBundle;
}) {
  return render(
    <HighLowAnnotationOverlay
      chart={makeChart(opts?.timeToCoordinate ?? (() => 100))}
      bundle={opts?.bundle ?? bundle}
      axis={axis}
      paneSeries={paneSeries(opts?.priceToCoordinate ?? (() => 50), opts?.paneHeight)}
      timeframe="1m"
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
  // below 앵커=라벨 bottom. wall 박스 = {top: lineY-15, bottom: lineY-2}.
  const highLabelBox = (y: number) => ({ top: y, bottom: y + 16 });
  const lowLabelBox = (y: number) => ({ top: y - 16, bottom: y });
  const wallBox = (lineY: number) => ({ top: lineY - 3 - 11 - 1, bottom: lineY - 3 + 1 });
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

  it('pushes a top-pinned high label down past a wall-label box near the top edge', () => {
    // wall line 20 → box {5,18} overlaps the top-edge high box {6,22}. 라벨은 아래로 양보.
    const high = placeExtremeLabel('above', 440, 60, '60,000원 (-13.59%, 06.10 09:30)', 760, 180, [20]);

    expect(high.place).toBe('above');
    expect(high.y).toBeGreaterThan(6);
    expect(disjoint(highLabelBox(high.y), wallBox(20))).toBe(true);
  });

  it('pushes a bottom-pinned low label up past a wall-label box near the bottom edge', () => {
    // wall line 170 → box {155,168} overlaps the bottom-edge low box {158,174}. 라벨은 위로 양보.
    const low = placeExtremeLabel('below', 440, 120, '58,700원 (+2.10%, 06.10 09:30)', 760, 180, [170]);

    expect(low.place).toBe('below');
    expect(low.y).toBeLessThan(174);
    expect(disjoint(lowLabelBox(low.y), wallBox(170))).toBe(true);
  });

  it('leaves the label at the edge when no wall box is near it', () => {
    // wall line 96 → box {81,94} sits mid-pane, far from the top-edge high box {6,22}.
    const high = placeExtremeLabel('above', 440, 60, '60,000원 (-13.59%, 06.10 09:30)', 760, 180, [96]);
    expect(high.y).toBe(6);
  });

  it('falls back to the original point before pane size is known', () => {
    expect(placeExtremeLabel('above', 20, 12, '59,300원 (-3.90%, 06.09 10:00)', 0, 0)).toEqual({
      place: 'above',
      x: 20,
      y: 12,
    });
  });
});
