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
  type LevelLineStyle,
} from './HighLowLabelsPrimitive';

/** 수평선 스타일 한 줄. 색 '' = 방향 토큰 추종(기본), 두께 1. */
function line(on: boolean, over: Partial<LevelLineStyle> = {}): LevelLineStyle {
  return { on, color: '', width: 1, ...over };
}
import type { AvoidRect, AvoidWallLabel } from './highLowLabelLayout';
import type { PeakWallRankArrow } from './PeakWallRankArrowsPrimitive';
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
  // strokeStyle·lineWidth 는 plain 프로퍼티라 **마지막 값만** 남는다. 선마다 다른 색·
  // 두께를 재려면 `stroke()` 호출 **시점의** 상태를 찍어 둬야 한다.
  const strokes: { style: string; width: number; dash: number[]; alpha: number }[] = [];
  let dash: number[] = [];
  const spy = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(() => {
      strokes.push({
        style: String(spy.strokeStyle),
        width: Number(spy.lineWidth),
        dash: [...dash],
        alpha: Number(spy.globalAlpha),
      });
    }),
    fill: vi.fn(),
    arc: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    setLineDash: vi.fn((d: number[]) => { dash = [...d]; }),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
    textBaseline: '' as CanvasTextBaseline,
    textAlign: '' as CanvasTextAlign,
    globalAlpha: 1,
    strokes,
  } as unknown as CanvasRenderingContext2D & {
    fillText: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    strokes: { style: string; width: number; dash: number[]; alpha: number }[];
  };
  return spy;
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
    avoidWallLabels: [],
    avoidRankArrows: [],
    avoidRankArrowLimit: 0,
    legendRects: [],
    levelLines: { high: line(false), low: line(false) },
    priorDayLines: { high: line(false), low: line(false) },
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

/** fillText 호출을 [텍스트, x, y] 로 — 칩 텍스트만 그린다(리더선은 path). */
function texts(c: ReturnType<typeof makeCanvasSpy>): { text: string; x: number; y: number }[] {
  return c.fillText.mock.calls.map(([text, x, y]) => ({ text: String(text), x: Number(x), y: Number(y) }));
}

describe('HighLowLabelsPrimitive', () => {
  it('draws the high and low extreme labels with price and 극값 대비율 (no timestamp)', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c);

    const drawn = texts(c);
    expect(drawn).toHaveLength(2);
    expect(drawn[0].text).toContain('38,800원');
    // 시각은 칩에 없다 — 폭이 곧 캔들을 덮는 면적이라 2026-08-23 에 뺐다.
    expect(drawn[0].text).not.toMatch(/\d{2}:\d{2}/);
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

  it('draws a dashed leader line from the extreme point to the label when far enough apart', () => {
    const stubs = makeAxisStubs({ priceToCoordinate: () => 150 });
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    expect(c.setLineDash).toHaveBeenCalled();
    // 극값 가격(y=150) ↔ 상단 라벨 아래 모서리(6+16=22) 사이를 잇는 세로 구간.
    expect(c.moveTo).toHaveBeenCalledWith(expect.any(Number), 22);
  });

  it('draws an L-shaped leader when the label slid sideways off the extreme bar', () => {
    // 레전드가 pane 좌측 절반을 덮고 극값이 위쪽(y=60)이면 고가 라벨은 세로로 자리가
    // 없어 가로로 비킨다 → 리더선이 ㄱ자가 된다. 판별식은 **수평 구간의 존재**:
    // 칩 아래 모서리 높이(6+16=22)에서 y 가 그대로인 lineTo 가 있어야 한다.
    const stubs = makeAxisStubs({ priceToCoordinate: () => 60, timeToCoordinate: () => 100 });
    const legend = { top: 0, bottom: 56, left: 0, right: 400 };
    const { prim } = attach(stubs, () => snapshot({ legendRects: [legend] }));
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    const horizontal = c.lineTo.mock.calls.filter(([, y]) => Number(y) === 22);
    expect(horizontal.length).toBeGreaterThan(0);
    // 수평 구간의 끝은 극값 봉의 x — 거기서 수직으로 극값 가격까지 내려간다.
    expect(c.lineTo).toHaveBeenCalledWith(horizontal[0][0], 60);
    // 칩 자체는 레전드 우측 바깥으로 나가 있다.
    expect(texts(c)[0].x).toBeGreaterThan(400);
  });

  it('keeps the leader purely vertical when the label sits on the extreme bar', () => {
    // 무변화 가드 — 회피 대상이 없으면 슬라이드가 없고 리더선도 세로 한 줄이다.
    const stubs = makeAxisStubs({ priceToCoordinate: () => 150, timeToCoordinate: () => 100 });
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    expect(c.lineTo.mock.calls.filter(([, y]) => Number(y) === 22)).toHaveLength(0);
  });

  it('marks the extreme with a leader line only — no dot on the bar tip', () => {
    // 2026-08-23 결정의 가드. 이 primitive 에서 `arc` 를 쓰던 곳은 극값 dot 하나뿐이었다
    // (칩 모서리는 `arcTo`, 리더선·레벨선은 직선). 따라서 arc 가 한 번도 안 불리는 것이
    // "봉 꼭짓점에 점을 얹지 않는다" 와 동치다 — dot 을 되살리면 여기서 빨개진다.
    const stubs = makeAxisStubs({ priceToCoordinate: () => 150 });
    const { prim } = attach(stubs, () => snapshot());
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    expect(c.arc).not.toHaveBeenCalled();
    // 표시가 통째로 사라진 게 아니라 리더선으로 옮겨간 것임을 같이 못박는다.
    expect(c.lineTo).toHaveBeenCalledWith(expect.any(Number), 150);
  });

  it('derives wall-chip avoid rects at draw time and yields the high label past them', () => {
    // 회귀 가드: 회피 rect 는 상위에서 픽셀로 구워 넘기지 않고 {price,time0,time1,peakTime}
    // 에서 매 프레임 변환돼야 한다(축 리스케일 정합). wall 가격을 상단 근처(y=30)로 매핑하면
    // x-겹침인 상단 고정 고가 라벨이 그 칩 rect 를 피해 아래로 밀린다.
    //
    // ⚠ y 는 **칩이 화면 안에 남는** 값이어야 한다. 매도 칩은 선 위로
    // `LABEL_GAP_PX + PEAK_MARKER_CLEARANCE_PX`(=14) + 패딩만큼 올라가므로, 종전 픽스처(y=15)는
    // 발생 시점 마커가 점에서 화살표로 커진 2026-08-26 이후 칩을 pane 밖으로 밀어내
    // **피할 대상이 사라졌다**(고가 라벨이 가장자리에 그대로 머물러 가드가 조용히 죽었다).
    const WALL_PRICE = 38_805;
    const wall: AvoidWallLabel = {
      price: WALL_PRICE,
      time0: (OPEN / 1000) as Time,
      time1: (CLOSE / 1000) as Time,
      peakTime: ((OPEN + CLOSE) / 2000) as Time,
      side: 'ask',
      label: '38,805, 1.2M',
    };
    const stubs = makeAxisStubs({ priceToCoordinate: (p) => (p === WALL_PRICE ? 30 : 150) });
    const { prim } = attach(stubs, () => snapshot({ avoidWallLabels: [wall] }));
    const c = makeCanvasSpy();

    draw(prim, c, { w: 760, h: 300 });

    // 가장자리(6+8=14)에 머물지 않고 칩 아래로 밀림.
    expect(texts(c)[0].y).toBeGreaterThan(14);
  });

  /**
   * **순위 화살표 회피 — 그려지는 것만 피한다.**
   *
   * 화살표는 상위 N 개만 그려지므로, 회피도 그 N 개만 해야 한다. 전건을 피하면 있지도
   * 않은 화살표 때문에 극값 라벨이 pane 안쪽으로 표류한다(칩 rect 에서 이미 겪은 결함).
   * 그래서 랭킹을 여기 draw 에서, 화살표 primitive 와 **같은 랭커·같은 프레임 범위**로
   * 다시 구한다.
   *
   * **막는 방향**: (1) 회피가 통째로 빠지는 것, (2) 순위 밖 화살표까지 피하는 것.
   * **못 보는 것**: 화살표가 실제로 그 rect 자리에 그려지는지 — 상수 공유가 그걸 맡는다.
   */
  describe('순위 화살표 회피', () => {
    const TOP_ANCHOR = 38_805;
    const RUNNER_ANCHOR = 38_804;
    const arrow = (anchorPrice: number, qty: number): PeakWallRankArrow => ({
      time: ((OPEN + CLOSE) / 2000) as Time,
      time0: (OPEN / 1000) as Time,
      time1: (CLOSE / 1000) as Time,
      qty,
      anchorPrice,
      side: 'ask',
      color: '#f00',
    });
    // TOP_ANCHOR 만 상단 가장자리(y=15)로 매핑 — 그 자리 화살표를 피해야 라벨이 밀린다.
    const stubsFor = () => makeAxisStubs({
      priceToCoordinate: (p) => (p === TOP_ANCHOR ? 15 : 150),
    });

    // 두 화살표는 **y 만 다르다** — 하나는 상단 가장자리(15, 라벨과 겹침), 하나는
    // 한가운데(150, 안 겹침). 어느 쪽이 상위인지는 **잔량만으로** 갈리므로, 잔량을
    // 뒤집는 것 하나로 「랭킹을 실제로 쓰는가」가 양방향으로 드러난다.
    const drawWith = (edgeQty: number, middleQty: number) => {
      const stubs = stubsFor();
      const { prim } = attach(stubs, () => snapshot({
        avoidRankArrows: [arrow(TOP_ANCHOR, edgeQty), arrow(RUNNER_ANCHOR, middleQty)],
        avoidRankArrowLimit: 1,
      }));
      const c = makeCanvasSpy();
      draw(prim, c, { w: 760, h: 300 });
      return texts(c)[0].y;
    };

    it('1위 화살표가 라벨 자리에 있으면 고가 라벨이 밀린다', () => {
      expect(drawWith(900, 100)).toBeGreaterThan(14);
    });

    it('같은 화살표라도 순위 밖이면 피하지 않는다(유령 회피 방지)', () => {
      // 잔량만 뒤집었다 → 1위는 한가운데 화살표. 가장자리 것은 그려지지 않으므로
      // 라벨은 가장자리(6+8=14)에 그대로 있어야 한다.
      expect(drawWith(100, 900)).toBe(14);
    });
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

    function drawWith(
      levelLinesPref: { high: LevelLineStyle; low: LevelLineStyle },
    ) {
      const stubs = makeAxisStubs({ priceToCoordinate });
      const { prim } = attach(stubs, () => snapshot({ levelLines: levelLinesPref }));
      const c = makeCanvasSpy();
      draw(prim, c, PANE);
      return c;
    }

    it('둘 다 꺼져 있으면 한 줄도 긋지 않는다 (라벨은 그대로)', () => {
      const c = drawWith({ high: line(false), low: line(false) });

      expect(levelLines(c).from).toEqual([]);
      expect(texts(c)).toHaveLength(2);
    });

    it('고가만 켜면 고가 가격에 전폭 한 줄 — 저가에는 긋지 않는다', () => {
      const c = drawWith({ high: line(true), low: line(false) });

      // 0.5 오프셋(픽셀 격자 정렬)까지 고정한다 — 흐릿한 1px 선 회귀 가드.
      expect(levelLines(c)).toEqual({ from: [40.5], to: [40.5] });
    });

    it('저가만 켜면 저가 가격에 전폭 한 줄 — 고가에는 긋지 않는다', () => {
      const c = drawWith({ high: line(false), low: line(true) });

      expect(levelLines(c)).toEqual({ from: [220.5], to: [220.5] });
    });

    it('둘 다 켜면 두 줄', () => {
      const c = drawWith({ high: line(true), low: line(true) });

      expect(levelLines(c)).toEqual({ from: [40.5, 220.5], to: [40.5, 220.5] });
    });

    it('극값 봉의 x 가 없어도(우측 빈 띠) 가격선은 그린다 — 레벨은 가격만으로 성립', () => {
      const stubs = makeAxisStubs({ priceToCoordinate, timeToCoordinate: () => null });
      const { prim } = attach(stubs, () => snapshot({ levelLines: { high: line(true), low: line(true) } }));
      const c = makeCanvasSpy();

      draw(prim, c, PANE);

      // 칩·리더선은 x 가 없어 skip 되지만 수평선은 남는다.
      expect(levelLines(c).from).toEqual([40.5, 220.5]);
      expect(c.fillText).not.toHaveBeenCalled();
    });
  });

  // 이전일 고저선 — **이틀치** 픽스처가 필수다. 하루짜리로는 이전 구간이 없어
  // `computePriorDaysExtremes` 가 항상 null 이고, 그러면 "안 그린다" 가 늘 통과해
  // 이 기능이 통째로 검증 밖에 남는다.
  describe('이전일 고저선', () => {
    const D1 = Date.UTC(2026, 5, 11, 0, 0, 0);
    const D2 = Date.UTC(2026, 5, 12, 0, 0, 0);
    const SESSION = 6.5 * 3_600_000;
    const twoDayAxis = createVirtualAxis(
      [
        { date: '20260611', sessionOpenMs: D1, sessionCloseMs: D1 + SESSION },
        { date: '20260612', sessionOpenMs: D2, sessionCloseMs: D2 + SESSION },
      ],
      D1,
    );
    // D1(이전일): 고 120 / 저 80 · D2(마지막 날): 고 150 / 저 70
    const twoDayCandles = [
      candle(D1 + 60_000, 120, 110, 115),
      candle(D1 + 120_000, 118, 80, 85),
      candle(D2 + 60_000, 150, 140, 145),
      candle(D2 + 120_000, 148, 70, 75),
    ];
    // 이전일 고 120 → y=60 / 이전일 저 80 → y=260. 마지막 날 극값(150·70)은 다른 y.
    const priceToCoordinate = (price: number) => {
      if (price === 120) return 60;
      if (price === 80) return 260;
      return 150;
    };
    const PANE = { w: 760, h: 300 };

    function drawTwoDay(priorPref: { high: LevelLineStyle; low: LevelLineStyle }) {
      const stubs = makeAxisStubs({
        priceToCoordinate,
        visibleRange: {
          from: twoDayAxis.toVirtual(D1) / 1000,
          to: twoDayAxis.toVirtual(D2 + SESSION) / 1000,
        },
      });
      const { prim } = attach(stubs, () => snapshot({
        candles: twoDayCandles,
        axis: twoDayAxis,
        priorDayLines: priorPref,
      }));
      const c = makeCanvasSpy();
      draw(prim, c, PANE);
      return c;
    }

    /** 긴 dash([8,4])로 그어진 획만 — 극값 가격선([4,4])·리더선([3,3])과 갈라 센다. */
    const priorStrokes = (c: ReturnType<typeof makeCanvasSpy>) =>
      c.strokes.filter((st) => st.dash[0] === 8);

    it('둘 다 꺼져 있으면 이전일선을 긋지 않는다', () => {
      const c = drawTwoDay({ high: line(false), low: line(false) });

      expect(priorStrokes(c)).toEqual([]);
    });

    it('이전일 고가선만 켜면 **마지막 날을 뺀** 고가(120)에 한 줄', () => {
      const c = drawTwoDay({ high: line(true), low: line(false) });

      // 마지막 날 고가 150(y=150)이 아니라 이전일 고가 120(y=60).
      expect(c.moveTo.mock.calls.filter(([x]) => Number(x) === 0).map(([, y]) => Number(y)))
        .toEqual([60.5]);
      expect(priorStrokes(c)).toHaveLength(1);
    });

    it('이전일 저가선만 켜면 이전일 저가(80)에 한 줄', () => {
      const c = drawTwoDay({ high: line(false), low: line(true) });

      expect(c.moveTo.mock.calls.filter(([x]) => Number(x) === 0).map(([, y]) => Number(y)))
        .toEqual([260.5]);
    });

    it('극값 가격선과 dash 로 갈린다 — 넷을 다 켜도 서로 섞이지 않는다', () => {
      const stubs = makeAxisStubs({
        priceToCoordinate,
        visibleRange: {
          from: twoDayAxis.toVirtual(D1) / 1000,
          to: twoDayAxis.toVirtual(D2 + SESSION) / 1000,
        },
      });
      const { prim } = attach(stubs, () => snapshot({
        candles: twoDayCandles,
        axis: twoDayAxis,
        levelLines: { high: line(true), low: line(true) },
        priorDayLines: { high: line(true), low: line(true) },
      }));
      const c = makeCanvasSpy();

      draw(prim, c, PANE);

      expect(priorStrokes(c)).toHaveLength(2);
      expect(c.strokes.filter((st) => st.dash[0] === 4)).toHaveLength(2);
    });
  });

  // 색·두께 — `CHART_LINE_STYLES` 가 저장한 값이 실제 획에 도달하는지. 색 '' 는
  // "고르지 않음" 이라 방향 토큰으로 풀려야 하고, 고른 색은 그대로 나가야 한다.
  describe('선 색·두께', () => {
    const priceToCoordinate = (price: number) => (price === 38_800 ? 40 : 220);
    const PANE = { w: 760, h: 300 };

    function drawStyled(levelLinesPref: { high: LevelLineStyle; low: LevelLineStyle }) {
      const stubs = makeAxisStubs({ priceToCoordinate });
      const { prim } = attach(stubs, () => snapshot({ levelLines: levelLinesPref }));
      const c = makeCanvasSpy();
      draw(prim, c, PANE);
      return c;
    }

    const levelStrokes = (c: ReturnType<typeof makeCanvasSpy>) =>
      c.strokes.filter((st) => st.dash[0] === 4);

    it("색 ''(고르지 않음)이면 방향 토큰으로 푼다 — 고가/저가가 서로 다른 색", () => {
      const c = drawStyled({ high: line(true), low: line(true) });

      const [high, low] = levelStrokes(c);
      expect(high.style).not.toBe('');
      expect(low.style).not.toBe('');
      expect(high.style).not.toBe(low.style);
    });

    it('고른 색은 그대로 획에 나간다 (방향 토큰을 덮어쓴다)', () => {
      const c = drawStyled({
        high: line(true, { color: '#00FF00' }),
        low: line(true),
      });

      const [high, low] = levelStrokes(c);
      expect(high.style).toBe('#00FF00');
      expect(low.style).not.toBe('#00FF00'); // 저가는 여전히 방향 토큰
    });

    it('두께가 획에 반영되고, 짝수 두께는 정수 y 에 앉는다', () => {
      // 홀수는 0.5 오프셋(획 중심이 픽셀 경계), 짝수는 정수 — 반대로 하면 흐려진다.
      const c = drawStyled({
        high: line(true, { width: 3 }),
        low: line(true, { width: 2 }),
      });

      const [high, low] = levelStrokes(c);
      expect(high.width).toBe(3);
      expect(low.width).toBe(2);
      const ys = c.moveTo.mock.calls.filter(([x]) => Number(x) === 0).map(([, y]) => Number(y));
      expect(ys).toEqual([40.5, 220]);
    });
  });
});
