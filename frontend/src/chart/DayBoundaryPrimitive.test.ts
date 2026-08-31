// frontend/src/chart/DayBoundaryPrimitive.test.ts
//
// primitive 를 직접 몬다(차트도 React 도 없이): `attached()` 에 스텁 chart/series 를,
// `draw()` 에 useMediaCoordinateSpace 가 콜백만 호출하는 가짜 target 을 준다
// (StudySavedRangeBandPrimitive.test.ts 하네스). 이 테스트들의 요점은 **모든 픽셀이
// draw() 안에서 살아 있는 축으로부터 산출된다**는 것 — 그게 한 프레임 팬 지연을
// 없앤 근거다.

import { describe, expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import {
  DAY_BOUNDARY_DASH,
  DAY_BOUNDARY_LINE_WIDTH,
  DayBoundaryPrimitive,
  computeBoundaryLines,
} from './DayBoundaryPrimitive';
import type { DayBoundaryTick } from './sessionSpans';

const TICKS: readonly DayBoundaryTick[] = [
  { date: '20260616', virtualMs: 1_800_000 },
  { date: '20260617', virtualMs: 3_600_000 },
];

function coordsFrom(table: Map<number, number | null>) {
  return (virtualSec: number) => table.get(virtualSec) ?? null;
}

const AT = (ms: number) => ms / 1000;

describe('computeBoundaryLines', () => {
  // stroke 는 중심선 기준이라 DOM 시절의 `[x, x+lineWidth)` 구간을 얻으려면 중심이
  // 반 두께만큼 오른쪽에 있어야 한다. 네 두께 모두 픽셀 격자에 앉아야 선이 흐려지지
  // 않으므로 두께별로 값을 세운다 — 하나라도 어긋나면 그 두께만 조용히 흐려진다.
  it.each([
    [1, 120.5],
    [2, 121],
    [3, 121.5],
    [4, 122],
  ])('두께 %i 의 stroke 중심을 픽셀 격자에 앉힌다 → %f', (lineWidth, expected) => {
    const placed = computeBoundaryLines(
      [TICKS[0]],
      coordsFrom(new Map([[AT(1_800_000), 120]])),
      lineWidth,
      500,
    );

    expect(placed).toEqual([{ date: '20260616', x: expected }]);
  });

  it('소수 좌표를 반올림해 격자에 앉힌다', () => {
    const placed = computeBoundaryLines(
      [TICKS[0]],
      coordsFrom(new Map([[AT(1_800_000), 120.4]])),
      1,
      500,
    );

    expect(placed).toEqual([{ date: '20260616', x: 120.5 }]);
  });

  // null 을 0 으로 접으면 구분선이 pane 좌단에 눌어붙는다 — 축에 없는 시각(그 날 첫
  // 캔들이 개장 정각이 아닌 경우 등)은 그리지 않는 것이 맞다.
  it('좌표를 못 얻은 경계는 버린다 — 0 으로 접지 않는다', () => {
    const placed = computeBoundaryLines(
      TICKS,
      coordsFrom(new Map([[AT(1_800_000), null], [AT(3_600_000), 300]])),
      1,
      500,
    );

    expect(placed).toEqual([{ date: '20260617', x: 300.5 }]);
  });

  it('pane 밖으로 나간 경계는 버린다', () => {
    const placed = computeBoundaryLines(
      TICKS,
      coordsFrom(new Map([[AT(1_800_000), -20], [AT(3_600_000), 640]])),
      1,
      500,
    );

    expect(placed).toEqual([]);
  });
});

function makeCanvasSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: '',
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D & {
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    setLineDash: ReturnType<typeof vi.fn>;
  };
}

function makeTarget(context: CanvasRenderingContext2D, width = 500, height = 300) {
  return {
    useMediaCoordinateSpace: <T,>(
      f: (scope: {
        context: CanvasRenderingContext2D;
        mediaSize: { width: number; height: number };
      }) => T,
    ): T => f({ context, mediaSize: { width, height } }),
  } as unknown as CanvasRenderingTarget2D;
}

/** 축 스텁은 **가변**이다 — 팬을 흉내 내려면 두 draw 사이에 값만 바꾼다(재부착 없이). */
function makeAxisStubs(init?: { timeToCoordinate?: (t: number) => number | null }) {
  const state = {
    timeToCoordinate:
      init?.timeToCoordinate ?? ((t: number) => (t === AT(1_800_000) ? 120 : 300)),
  };
  const chart = {
    timeScale: () => ({
      timeToCoordinate: (t: Time) => state.timeToCoordinate(Number(t)),
    }),
  } as unknown as IChartApi;
  const series = {} as unknown as ISeriesApi<SeriesType>;
  return { state, chart, series };
}

function attach(
  stubs: ReturnType<typeof makeAxisStubs>,
  source: () => readonly DayBoundaryTick[] | null,
) {
  const prim = new DayBoundaryPrimitive(source);
  const requestUpdate = vi.fn();
  prim.attached({ chart: stubs.chart, series: stubs.series, requestUpdate } as never);
  return { prim, requestUpdate };
}

function draw(
  prim: DayBoundaryPrimitive,
  c: CanvasRenderingContext2D,
  size?: { w: number; h: number },
) {
  prim.paneViews()[0].renderer()?.draw(makeTarget(c, size?.w, size?.h));
}

/** 그어진 세로선을 [x, yFrom, yTo] 로. */
function segments(c: ReturnType<typeof makeCanvasSpy>): number[][] {
  return c.moveTo.mock.calls.map((move, i) => {
    const line = c.lineTo.mock.calls[i];
    return [Number(move[0]), Number(move[1]), Number(line[1])];
  });
}

/** 테마 캐시(`resolveTokensThemed`)는 `data-theme` 를 키로 쓴다 — 테스트마다 **고유
 *  키**를 써야 다른 테스트가 채운 슬롯을 읽지 않는다. */
function withTheme(theme: string, color: string, run: () => void) {
  const root = document.documentElement;
  const prevTheme = root.getAttribute('data-theme');
  root.setAttribute('data-theme', theme);
  root.style.setProperty('--chart-day-boundary', color);
  try {
    run();
  } finally {
    root.style.removeProperty('--chart-day-boundary');
    if (prevTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prevTheme);
  }
}

describe('DayBoundaryPrimitive', () => {
  it('경계마다 pane 높이 전체를 관통하는 세로선을 긋는다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);
    const c = makeCanvasSpy();

    draw(prim, c, { w: 500, h: 200 });

    expect(segments(c)).toEqual([
      [120.5, 0, 200],
      [300.5, 0, 200],
    ]);
  });

  it('DOM 시절 gradient 와 같은 3px/3px 점선으로 긋는다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.setLineDash).toHaveBeenCalledWith([...DAY_BOUNDARY_DASH]);
  });

  // 색은 prefs 가 아니라 `--chart-day-boundary` 토큰이 갖는다(2026-08-27). 해석이
  // draw **시점**이라 테마 전환이 그대로 따라온다 — 부착 시점에 구우면 테마를 바꾼
  // 뒤 첫 팬까지 옛 색이 남는다.
  it('테마 토큰 색으로 긋는다 — draw 시점 해석이라 테마 전환이 따라온다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);

    withTheme('test-dark-tone', '#6d6d7b', () => {
      const c = makeCanvasSpy();
      draw(prim, c);
      expect(c.strokeStyle).toBe('#6d6d7b');
    });

    // 같은 primitive·같은 스냅샷 — 테마만 바뀌었는데 색이 따라와야 한다.
    withTheme('test-paper-tone', '#8a8271', () => {
      const c = makeCanvasSpy();
      draw(prim, c);
      expect(c.strokeStyle).toBe('#8a8271');
    });
  });

  it('두께는 1px 상수다 — 사용자 설정이 아니다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.lineWidth).toBe(DAY_BOUNDARY_LINE_WIDTH);
    expect(DAY_BOUNDARY_LINE_WIDTH).toBe(1);
  });

  // 선 하나마다 stroke 를 부르면 같은 그림에 상태 전환만 늘어난다.
  it('모든 선을 한 path 에 모아 stroke 를 한 번만 부른다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.moveTo).toHaveBeenCalledTimes(2);
    expect(c.stroke).toHaveBeenCalledTimes(1);
  });

  it('스냅샷이 없으면 그리지 않는다 — 마운트 직후 축 미준비', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => null);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.stroke).not.toHaveBeenCalled();
  });

  it('그릴 경계가 하나도 없으면 stroke 를 부르지 않는다', () => {
    const stubs = makeAxisStubs({ timeToCoordinate: () => null });
    const { prim } = attach(stubs, () => TICKS);
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.stroke).not.toHaveBeenCalled();
  });

  it('매 프레임 축에서 좌표를 다시 뽑는다 — 재push 불필요 (팬 지연 회귀 가드)', () => {
    // 이 primitive 이관의 존재 이유. 스냅샷은 그대로 두고 축만 팬시킨 뒤 다시 그리면
    // 구분선이 새 프레임 좌표로 나와야 한다. DOM 오버레이 시절엔 여기서 구독 → rAF →
    // React 렌더를 거쳐야 했고, 그 지연이 곧 캔들을 뒤따라오는 구분선이었다.
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);

    const before = makeCanvasSpy();
    draw(prim, before, { w: 500, h: 200 });
    expect(segments(before)).toEqual([
      [120.5, 0, 200],
      [300.5, 0, 200],
    ]);

    // 좌측으로 40px 팬 — 스냅샷도 requestUpdate 도 건드리지 않는다.
    stubs.state.timeToCoordinate = (t) => (t === AT(1_800_000) ? 80 : 260);
    const after = makeCanvasSpy();
    draw(prim, after, { w: 500, h: 200 });

    expect(segments(after)).toEqual([
      [80.5, 0, 200],
      [260.5, 0, 200],
    ]);
  });

  it('축 teardown 중 throw 를 삼키고 그리지 않는다', () => {
    const stubs = makeAxisStubs({
      timeToCoordinate: () => {
        throw new Error('chart disposed');
      },
    });
    const { prim } = attach(stubs, () => TICKS);
    const c = makeCanvasSpy();

    expect(() => draw(prim, c)).not.toThrow();
    expect(c.stroke).not.toHaveBeenCalled();
  });

  it('detach 후에는 그리지 않는다', () => {
    const stubs = makeAxisStubs();
    const { prim } = attach(stubs, () => TICKS);
    prim.detached();
    const c = makeCanvasSpy();

    draw(prim, c);

    expect(c.stroke).not.toHaveBeenCalled();
  });
});
