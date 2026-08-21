// frontend/src/chart/HighLowLabelsPrimitive.test.ts
//
// The primitive is driven directly (no chart, no React): `attached()` gets stub
// chart/series and `draw()` a fake CanvasRenderingTarget2D whose
// useMediaCoordinateSpace just invokes the callback (DrawingsPrimitive.test.ts
// harness). The point of these tests is that every pixel is derived *inside*
// draw() from the live axis — that is what removed the one-frame pan lag.

import { describe, expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import {
  HighLowLabelsPrimitive,
  type HighLowLabelsSnapshot,
} from './HighLowLabelsPrimitive';
import type { AvoidRect, AvoidWallLabel } from './highLowLabelLayout';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Candle } from '../api/types';

const OPEN = Date.UTC(2026, 5, 12, 0, 0, 0); // 09:00 KST
const CLOSE = OPEN + 6.5 * 3_600_000;
const axis = createVirtualAxis([{ date: '20260612', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }], OPEN);

function candle(tsMs: number, high: number, low: number, close: number): Candle {
  return { ts_ms: tsMs, open: close, close, high, low, vol_a: 0, vol_b: 0 };
}

// 고가 38,800 @09:02 / 저가 36,750 @09:03 / 기준가(가시 범위 우측 끝 종가) 37,100.
const CANDLES = [
  candle(OPEN + 60_000, 37_000, 36_900, 36_950),
  candle(OPEN + 120_000, 38_800, 38_000, 38_200),
  candle(OPEN + 180_000, 37_500, 36_750, 37_100),
];

function makeCanvasSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    setLineDash: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
    textBaseline: '' as CanvasTextBaseline,
    textAlign: '' as CanvasTextAlign,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D & {
    fillText: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
  };
}

function makeTarget(context: CanvasRenderingContext2D, width = 760, height = 300) {
  return {
    useMediaCoordinateSpace: <T,>(
      f: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => T,
    ): T => f({ context, mediaSize: { width, height } }),
  } as unknown as CanvasRenderingTarget2D;
}

type Stubs = {
  visibleRange?: { from: number; to: number } | null;
  timeToCoordinate?: (t: number) => number | null;
  priceToCoordinate?: (price: number) => number | null;
};

/** 축 스텁은 **가변**이다 — 팬을 흉내 내려면 두 draw 사이에 값만 바꾼다(재부착 없이). */
function makeAxisStubs(init: Stubs = {}) {
  const state = {
    visibleRange: init.visibleRange ?? { from: OPEN / 1000, to: CLOSE / 1000 },
    timeToCoordinate: init.timeToCoordinate ?? (() => 100),
    priceToCoordinate: init.priceToCoordinate ?? (() => 150),
  };
  const chart = {
    timeScale: () => ({
      getVisibleRange: () => state.visibleRange,
      getVisibleLogicalRange: () => null,
      timeToCoordinate: (t: Time) => state.timeToCoordinate(Number(t)),
    }),
  } as unknown as IChartApi;
  const series = {
    priceToCoordinate: (price: number) => state.priceToCoordinate(price),
  } as unknown as ISeriesApi<SeriesType>;
  return { state, chart, series };
}

function snapshot(over: Partial<HighLowLabelsSnapshot> = {}): HighLowLabelsSnapshot {
  return {
    candles: CANDLES,
    axis,
    timeframe: '1m',
    avoidWallLabels: [],
    legendRects: [],
    levelLines: { high: false, low: false },
    ...over,
  };
}

function attach(stubs: ReturnType<typeof makeAxisStubs>, source: () => HighLowLabelsSnapshot | null) {
  const prim = new HighLowLabelsPrimitive(source);
  const requestUpdate = vi.fn();
  prim.attached({ chart: stubs.chart, series: stubs.series, requestUpdate } as never);
  return { prim, requestUpdate };
}

function draw(prim: HighLowLabelsPrimitive, c: CanvasRenderingContext2D, size?: { w: number; h: number }) {
  prim.paneViews()[0].renderer()?.draw(makeTarget(c, size?.w, size?.h));
}

/** fillText 호출을 [텍스트, x, y] 로 — 칩 텍스트만 그린다(dot·리더선은 path). */
function texts(c: ReturnType<typeof makeCanvasSpy>): { text: string; x: number; y: number }[] {
  return c.fillText.mock.calls.map(([text, x, y]) => ({ text: String(text), x: Number(x), y: Number(y) }));
}

describe('HighLowLabelsPrimitive', () => {
  it('draws the high and low extreme labels with price, 극값 대비율 and time', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c);

    const drawn = texts(c);
    expect(drawn).toHaveLength(2);
    expect(drawn[0].text).toContain('38,800원');
    expect(drawn[0].text).toContain('09:02');
    expect(drawn[1].text).toContain('36,750원');
    // 극값 대비율 부호: 기준가 37,100 → 고가 음수, 저가 양수.
    expect(drawn[0].text).toMatch(/-\d+\.\d{2}%/);
    expect(drawn[1].text).toMatch(/\+\d+\.\d{2}%/);
  });

  it('pins the high label to the top edge and the low label to the bottom edge of the pane', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 200 });

    // 칩 중앙 y = 가장자리 앵커(6 / 200-6) 기준 박스(16px) 중앙.
    const [high, low] = texts(c);
    expect(high.y).toBe(6 + 8);
    expect(low.y).toBe(194 - 8);
  });

  it('recomputes every pixel from the axis at draw time — no re-push needed (팬 지연 회귀 가드)', () => {
    // 이 primitive 이관의 존재 이유. 스냅샷은 그대로 두고 축만 팬시킨 뒤 다시 그리면
    // 라벨 x 와 극값 자체가 새 프레임 값으로 나와야 한다. DOM 오버레이 시절엔 여기서
    // 한 프레임 낡은 좌표가 나왔다(구독 → rAF → React 렌더 경로).
    const stubs = makeAxisStubs({ timeToCoordinate: () => 100 });
    const { prim } = attach(stubs, () => snapshot());
    const first = makeCanvasSpy();
    draw(prim, first);
    expect(texts(first)[0].x).toBe(100);
    expect(texts(first)[0].text).toContain('38,800원');

    // 팬: x 투영이 밀리고 가시 범위가 09:03 봉만 남긴다 → 고가가 37,500 으로 교체.
    stubs.state.timeToCoordinate = () => 420;
    stubs.state.visibleRange = { from: (OPEN + 150_000) / 1000, to: CLOSE / 1000 };
    const second = makeCanvasSpy();
    draw(prim, second);

    expect(texts(second)[0].x).toBe(420);
    expect(texts(second)[0].text).toContain('37,500원');
  });

  it('draws a dashed leader line from the dot to the label when they are far enough apart', () => {
    const stubs = makeAxisStubs({ priceToCoordinate: () => 150 });
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    expect(c.setLineDash).toHaveBeenCalled();
    // dot(y=150) ↔ 상단 라벨 아래 모서리(6+16=22) 사이를 잇는 세로 구간.
    expect(c.moveTo).toHaveBeenCalledWith(expect.any(Number), 22);
  });

  it('derives wall-chip avoid rects at draw time and yields the high label past them', () => {
    // 회귀 가드: 회피 rect 는 상위에서 픽셀로 구워 넘기지 않고 {price,time1} 에서 매
    // 프레임 변환돼야 한다(축 리스케일 정합). wall 가격을 상단 가장자리 근처(y=15)로
    // 매핑하면 x-겹침인 상단 고정 고가 라벨이 그 칩 rect 를 피해 아래로 밀린다.
    const WALL_PRICE = 38_805;
    const wall: AvoidWallLabel = { price: WALL_PRICE, time1: (CLOSE / 1000) as Time, label: '38,805, 1.2M' };
    const stubs = makeAxisStubs({ priceToCoordinate: (p) => (p === WALL_PRICE ? 15 : 150) });
    const { prim } = attach(stubs, () => snapshot({ avoidWallLabels: [wall] }));
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    // 가장자리(6+8=14)에 머물지 않고 칩 아래로 밀림.
    expect(texts(c)[0].y).toBeGreaterThan(14);
  });

  it('avoids the pane legend rows measured by the host', () => {
    // 극값 봉이 좌측(레전드 아래)일 때 상단 고정 고가 라벨이 Pane Legend 행과 겹치던
    // 결함의 회귀 가드. 레전드 rect 는 DOM 실측이라 host 가 스냅샷으로 밀어 넣는다.
    const legend: AvoidRect = { top: 4, bottom: 30, left: 0, right: 640 };
    const stubs = makeAxisStubs({ priceToCoordinate: () => 150 });
    const { prim } = attach(stubs, () => snapshot({ legendRects: [legend] }));
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    // 레전드 행 아래(30+2=32)에 박스 top → 중앙 40. 하단 저가 라벨은 가장자리 유지.
    const [high, low] = texts(c);
    expect(high.y).toBe(40);
    expect(low.y).toBe(294 - 8);
  });

  it('draws nothing when the source has no snapshot (토글 off)', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => null);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.fillText).not.toHaveBeenCalled();
  });

  it('skips a label whose coordinate is null (우측 빈 띠 / 범위 밖)', () => {
    const stubs = makeAxisStubs({ timeToCoordinate: () => null });
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.fillText).not.toHaveBeenCalled();
  });

  it('draws nothing when there are no visible extremes (빈 캔들)', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => snapshot({ candles: [] }));
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.fillText).not.toHaveBeenCalled();
  });

  it('survives a torn-down chart (coordinate conversion throws)', () => {
    const stubs = makeAxisStubs({
      priceToCoordinate: () => {
        throw new Error('Object is disposed');
      },
    });
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    expect(() => draw(prim, c)).not.toThrow();
    expect(c.fillText).not.toHaveBeenCalled();
  });

  // 극값 **가격선** — pane 전폭 수평 점선. 고가·저가가 독립 토글이라 네 조합을 전부
  // 잰다: 한 방향만 보면 "항상 그린다"는 하드코딩도, "아무것도 안 그린다"는 무동작도
  // 초록이 된다. 판정축은 `moveTo(0, y)` → `lineTo(paneWidth, y)` 쌍 — 리더선(x=봉 좌표)
  // 과 칩 박스(x=칩 좌변)는 x=0 에서 시작하지 않으므로 이 필터에 걸리지 않는다.
  describe('극값 가격선', () => {
    // 고가 38,800 → y=40 / 저가 36,750 → y=220. 두 선을 y 로 구별하려고 가격별 스텁.
    const priceToCoordinate = (price: number) => (price === 38_800 ? 40 : 220);
    const PANE = { w: 760, h: 300 };

    function levelLines(c: ReturnType<typeof makeCanvasSpy>) {
      const from = c.moveTo.mock.calls.filter(([x]) => Number(x) === 0).map(([, y]) => Number(y));
      const to = c.lineTo.mock.calls.filter(([x]) => Number(x) === PANE.w).map(([, y]) => Number(y));
      return { from, to };
    }

    function drawWith(levelLinesPref: { high: boolean; low: boolean }) {
      const stubs = makeAxisStubs({ priceToCoordinate });
      const { prim } = attach(stubs, () => snapshot({ levelLines: levelLinesPref }));
      const c = makeCanvasSpy();
      draw(prim, c, PANE);
      return c;
    }

    it('둘 다 꺼져 있으면 한 줄도 긋지 않는다 (라벨은 그대로)', () => {
      const c = drawWith({ high: false, low: false });

      expect(levelLines(c).from).toEqual([]);
      expect(texts(c)).toHaveLength(2);
    });

    it('고가만 켜면 고가 가격에 전폭 한 줄 — 저가에는 긋지 않는다', () => {
      const c = drawWith({ high: true, low: false });

      // 0.5 오프셋(픽셀 격자 정렬)까지 고정한다 — 흐릿한 1px 선 회귀 가드.
      expect(levelLines(c)).toEqual({ from: [40.5], to: [40.5] });
    });

    it('저가만 켜면 저가 가격에 전폭 한 줄 — 고가에는 긋지 않는다', () => {
      const c = drawWith({ high: false, low: true });

      expect(levelLines(c)).toEqual({ from: [220.5], to: [220.5] });
    });

    it('둘 다 켜면 두 줄', () => {
      const c = drawWith({ high: true, low: true });

      expect(levelLines(c)).toEqual({ from: [40.5, 220.5], to: [40.5, 220.5] });
    });

    it('극값 봉의 x 가 없어도(우측 빈 띠) 가격선은 그린다 — 레벨은 가격만으로 성립', () => {
      const stubs = makeAxisStubs({ priceToCoordinate, timeToCoordinate: () => null });
      const { prim } = attach(stubs, () => snapshot({ levelLines: { high: true, low: true } }));
      const c = makeCanvasSpy();

      draw(prim, c, PANE);

      // 칩·dot 은 x 가 없어 skip 되지만 수평선은 남는다.
      expect(levelLines(c).from).toEqual([40.5, 220.5]);
      expect(c.fillText).not.toHaveBeenCalled();
    });
  });
});
