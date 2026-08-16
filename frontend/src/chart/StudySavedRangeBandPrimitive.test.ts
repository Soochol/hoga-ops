// frontend/src/chart/StudySavedRangeBandPrimitive.test.ts
//
// primitive 를 직접 몬다(차트도 React 도 없이): `attached()` 에 스텁 chart/series 를,
// `draw()` 에 useMediaCoordinateSpace 가 콜백만 호출하는 가짜 target 을 준다
// (HighLowLabelsPrimitive.test.ts 하네스). 이 테스트들의 요점은 **모든 픽셀이
// draw() 안에서 살아 있는 축으로부터 산출된다**는 것 — 그게 한 프레임 팬 지연을
// 없앤 근거다.

import { describe, expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import {
  StudySavedRangeBandPrimitive,
  computeBandGeometry,
  type StudySavedRangeBandSnapshot,
} from './StudySavedRangeBandPrimitive';
import type { VirtualAxis } from '../util/virtualAxis';
import type { StudySavedRangeMarks } from '../studyViews/studyDailyContext';

const FROM_MS = 1_780_000_000_000;
const TO_MS = 1_781_000_000_000;

/** `axis.toVirtual` 은 항등 — 좌표 표는 virtual초를 키로 본다(옛 DOM 테스트와 동일). */
const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;

const marks: StudySavedRangeMarks = { fromMs: FROM_MS, toMs: TO_MS, barCount: 12 };

function coordsFrom(table: Map<number, number | null>) {
  return (virtualSec: number) => table.get(virtualSec) ?? null;
}

describe('computeBandGeometry', () => {
  it('경계를 캔들 좌표에서 바 폭 절반씩 바깥으로 넓힌다', () => {
    const geom = computeBandGeometry(
      marks,
      axis,
      coordsFrom(new Map([[FROM_MS / 1000, 100], [TO_MS / 1000, 300]])),
      8,
    );

    // half = 4 → 96px ~ 304px
    expect(geom).toEqual({ left: 96, right: 304, width: 208 });
  });

  it('바 간격이 아주 좁아도 최소 1px 은 넓힌다', () => {
    const geom = computeBandGeometry(
      marks,
      axis,
      coordsFrom(new Map([[FROM_MS / 1000, 100], [TO_MS / 1000, 120]])),
      0.5,
    );

    expect(geom).toEqual({ left: 99, right: 121, width: 22 });
  });

  it('좌표를 못 얻으면(축 미준비·화면 밖) null 을 준다', () => {
    // null 을 0 으로 접으면 밴드가 차트 좌단에 눌어붙는다 — 그 회귀를 막는다.
    const geom = computeBandGeometry(
      marks,
      axis,
      coordsFrom(new Map([[FROM_MS / 1000, null], [TO_MS / 1000, 300]])),
      8,
    );

    expect(geom).toBeNull();
  });
});

function makeCanvasSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D & { fillRect: ReturnType<typeof vi.fn> };
}

function makeTarget(context: CanvasRenderingContext2D, width = 500, height = 300) {
  return {
    useMediaCoordinateSpace: <T,>(
      f: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => T,
    ): T => f({ context, mediaSize: { width, height } }),
  } as unknown as CanvasRenderingTarget2D;
}

/** 축 스텁은 **가변**이다 — 팬을 흉내 내려면 두 draw 사이에 값만 바꾼다(재부착 없이). */
function makeAxisStubs(init?: { timeToCoordinate?: (t: number) => number | null; barSpacing?: number }) {
  const state = {
    timeToCoordinate:
      init?.timeToCoordinate ?? ((t: number) => (t === FROM_MS / 1000 ? 100 : 300)),
    barSpacing: init?.barSpacing ?? 8,
  };
  const chart = {
    timeScale: () => ({
      options: () => ({ barSpacing: state.barSpacing }),
      timeToCoordinate: (t: Time) => state.timeToCoordinate(Number(t)),
    }),
  } as unknown as IChartApi;
  const series = {} as unknown as ISeriesApi<SeriesType>;
  return { state, chart, series };
}

function attach(
  stubs: ReturnType<typeof makeAxisStubs>,
  source: () => StudySavedRangeBandSnapshot | null,
) {
  const prim = new StudySavedRangeBandPrimitive(source);
  const requestUpdate = vi.fn();
  prim.attached({ chart: stubs.chart, series: stubs.series, requestUpdate } as never);
  return { prim, requestUpdate };
}

function draw(
  prim: StudySavedRangeBandPrimitive,
  c: CanvasRenderingContext2D,
  size?: { w: number; h: number },
) {
  prim.paneViews()[0].renderer()?.draw(makeTarget(c, size?.w, size?.h));
}

/** fillRect 호출을 [x, y, w, h] 로. 순서는 tint → 좌측 실선 → 우측 실선. */
function rects(c: ReturnType<typeof makeCanvasSpy>): number[][] {
  return c.fillRect.mock.calls.map((call) => call.map(Number));
}

describe('StudySavedRangeBandPrimitive', () => {
  it('tint 와 양끝 실선을 pane 높이 전체로 그린다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => ({ axis, marks }));
    const c = makeCanvasSpy();

    draw(prim, c, { w: 500, h: 200 });

    expect(rects(c)).toEqual([
      [96, 0, 208, 200], // tint
      [96, 0, 1, 200], // 좌측 실선
      [304, 0, 1, 200], // 우측 실선
    ]);
  });

  it('좌표를 못 얻으면 아무것도 그리지 않는다', () => {
    const stubs = makeAxisStubs({ timeToCoordinate: () => null });
    const { prim } = attach(stubs, () => ({ axis, marks }));
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(rects(c)).toEqual([]);
  });

  it('스냅샷이 없으면 그리지 않는다 — 마운트 직후 축 미준비', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => null);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(rects(c)).toEqual([]);
  });

  it('매 프레임 축에서 좌표를 다시 뽑는다 — 재push 불필요 (팬 지연 회귀 가드)', () => {
    // 이 primitive 이관의 존재 이유. 스냅샷은 그대로 두고 축만 팬시킨 뒤 다시 그리면
    // 밴드가 새 프레임 좌표로 나와야 한다. DOM 오버레이 시절엔 여기서 구독 → rAF →
    // React 렌더를 거쳐야 했고, 그 지연이 곧 캔들을 뒤따라오는 밴드였다.
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => ({ axis, marks }));

    const before = makeCanvasSpy();
    draw(prim, before, { w: 500, h: 200 });
    expect(rects(before)[0]).toEqual([96, 0, 208, 200]);

    // 좌측으로 40px 팬 — 스냅샷도 requestUpdate 도 건드리지 않는다.
    stubs.state.timeToCoordinate = (t) => (t === FROM_MS / 1000 ? 60 : 260);
    const after = makeCanvasSpy();
    draw(prim, after, { w: 500, h: 200 });

    expect(rects(after)[0]).toEqual([56, 0, 208, 200]);
  });

  it('축 teardown 중 throw 를 삼키고 그리지 않는다', () => {
    const stubs = makeAxisStubs({
      timeToCoordinate: () => {
        throw new Error('Object is disposed');
      },
    });
    const { prim } = attach(stubs, () => ({ axis, marks }));
    const c = makeCanvasSpy();

    expect(() => draw(prim, c)).not.toThrow();
    expect(rects(c)).toEqual([]);
  });

  it('캔들 위에 그린다 — zOrder top (DOM 시절 z-10 의 시각 동등물, #1238)', () => {
    expect(new StudySavedRangeBandPrimitive(() => null).paneViews()[0].zOrder?.()).toBe('top');
  });

  it('detach 후엔 chart 참조를 놓아 그리지 않는다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => ({ axis, marks }));
    const c = makeCanvasSpy();

    prim.detached();
    draw(prim, c);

    expect(rects(c)).toEqual([]);
    expect(prim.chartApi()).toBeNull();
  });
});
