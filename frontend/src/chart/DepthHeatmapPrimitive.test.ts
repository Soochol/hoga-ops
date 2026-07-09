import { describe, it, expect, vi } from 'vitest';
import { DepthHeatmapPrimitive, type DepthHeatmapCell } from './DepthHeatmapPrimitive';

describe('DepthHeatmapPrimitive', () => {
  it('setCells가 셀을 저장하고 zOrder를 반영한다', () => {
    const prim = new DepthHeatmapPrimitive({ zOrder: 'bottom' });
    prim.setCells([
      { time: 100 as never, price: 1000, halfTick: 50, fillColor: 'rgba(240,68,82,0.5)' },
    ]);
    expect(prim.cellsData().length).toBe(1);
    expect(prim.zOrder()).toBe('bottom');
  });
  it('기본 zOrder는 bottom', () => {
    const prim = new DepthHeatmapPrimitive();
    expect(prim.zOrder()).toBe('bottom');
  });

  it('draw가 컬럼별 x·가격별 y 좌표 변환을 프레임 내 1회로 캐시한다', () => {
    const timeToCoordinate = vi.fn((t: number) => t);
    const priceToCoordinate = vi.fn((p: number) => p);
    const chart = {
      timeScale: () => ({ timeToCoordinate, options: () => ({ barSpacing: 6 }) }),
    };
    const series = { priceToCoordinate };

    const prim = new DepthHeatmapPrimitive();
    // attached 로 chart/series 주입 (requestUpdate 는 no-op).
    prim.attached({ chart, series, requestUpdate: () => {} } as never);

    // 두 컬럼(time 100/200) × 각 2개 호가 레벨(price 1000/1010) — 같은 time·price 가
    // 여러 셀에 재등장한다. halfTick 은 price+halfTick 도 캐시 키가 되므로 별도 셋.
    const cells: DepthHeatmapCell[] = [
      { time: 100 as never, price: 1000, halfTick: 5, fillColor: 'rgba(1,1,1,0.5)' },
      { time: 100 as never, price: 1010, halfTick: 5, fillColor: 'rgba(1,1,1,0.5)' },
      { time: 200 as never, price: 1000, halfTick: 5, fillColor: 'rgba(1,1,1,0.5)' },
      { time: 200 as never, price: 1010, halfTick: 5, fillColor: 'rgba(1,1,1,0.5)' },
    ];
    prim.setCells(cells);

    const ctx = { fillStyle: '', fillRect: vi.fn() };
    const target = {
      useBitmapCoordinateSpace: (cb: (scope: unknown) => void) =>
        cb({ context: ctx, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
    };
    const view = prim.paneViews()[0];
    if (!view) throw new Error('expected a pane view');
    const renderer = view.renderer();
    if (!renderer?.draw) throw new Error('expected a renderer with draw');
    renderer.draw(target as never);

    // 4 셀이지만 distinct time 은 2개 → timeToCoordinate 2회.
    expect(timeToCoordinate).toHaveBeenCalledTimes(2);
    // distinct price 는 1000·1010·1005·1015 = 4개(각 셀의 price 와 price+halfTick).
    expect(priceToCoordinate).toHaveBeenCalledTimes(4);
    // 그래도 4 셀 전부 그려진다.
    expect(ctx.fillRect).toHaveBeenCalledTimes(4);
  });
});
