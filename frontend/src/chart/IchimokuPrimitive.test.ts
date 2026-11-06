import { describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, Logical, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { IchimokuPrimitive, ichimokuCloudPolygons, type IchimokuSnapshot, type IchimokuStyle } from './IchimokuPrimitive';
import { ICHIMOKU_LINES, projectIchimoku } from './projectors/ichimoku';
const style: IchimokuStyle = { lines: { conversion: { visible: false, color: '#111111' }, base: { visible: false, color: '#222222' }, leadingA: { visible: false, color: '#333333' }, leadingB: { visible: false, color: '#444444' }, lagging: { visible: false, color: '#555555' } }, lineWidth: 1, cloud: { visible: true, positiveColor: '#ff0000', negativeColor: '#0000ff', opacity: .2 } };
function setup() {
  const model = projectIchimoku([10, 20, 30, 40].map((value, i) => ({ virtualSecond: [10, 20, 50, 60][i], high: value + 2, low: value - 2, close: value, breakBefore: false })), { conversion: 1, base: 1, leadingB: 2, displacement: 2 });
  const requestUpdate = vi.fn(), primitive = new IchimokuPrimitive();
  const timeScale = { timeToIndex: (t: number) => new Map([[10, 100], [20, 101], [50, 104], [60, 105]]).get(t) ?? null, logicalToCoordinate: (i: number) => (i - 100) * 10, getVisibleLogicalRange: () => ({ from: 100, to: 110 }) };
  const chart = { timeScale: () => timeScale } as unknown as IChartApi;
  const series = { priceScale: () => ({ options: () => ({ mode: 1 }) }), priceToCoordinate: (p: number) => 100 - Math.log(p) * 10, coordinateToPrice: (y: number) => Math.exp((100 - y) / 10) } as unknown as ISeriesApi<SeriesType>;
  primitive.attached({ chart, series, requestUpdate } as unknown as SeriesAttachedParameter<Time>);
  const snapshot: IchimokuSnapshot = { model, style, candleOnlyScale: false, candleAlwaysOnTop: false };
  primitive.setSnapshot(snapshot);
  return { primitive, snapshot, timeScale, requestUpdate };
}
describe('Ichimoku candle primitive', () => {
  it('splits crossing boundaries at their rendered intersection, including log-scale geometry', () => {
    const polygons = ichimokuCloudPolygons({ x: 0, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 30 }, { x: 10, y: 20 });
    expect(polygons).toEqual([{ positive: true, points: [{ x: 0, y: 10 }, { x: 5, y: 25 }, { x: 0, y: 30 }] }, { positive: false, points: [{ x: 5, y: 25 }, { x: 10, y: 40 }, { x: 10, y: 20 }] }]);
    expect(ichimokuCloudPolygons({ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 0, y: 10 }, { x: 1, y: 20 })).toEqual([]);
  });
  it('scales visible forward cloud with hidden outlines and excludes offscreen extremes', () => {
    const { primitive, snapshot } = setup();
    expect(primitive.autoscaleInfo(106 as Logical, 107 as Logical)?.priceRange).toEqual({ minValue: 25, maxValue: 40 });
    expect(primitive.autoscaleInfo(109 as Logical, 110 as Logical)).toBeNull();
    primitive.setSnapshot({ ...snapshot, candleOnlyScale: true });
    expect(primitive.autoscaleInfo(106 as Logical, 107 as Logical)).toBeNull();
    primitive.setSnapshot(null); primitive.setSnapshot(null);
    expect(primitive.autoscaleInfo(100 as Logical, 110 as Logical)).toBeNull();
  });
  it('keeps price direction colors under inverted coordinates and does not scale unready cloud', () => {
    const normal = ichimokuCloudPolygons({ x: 0, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 30 }, { x: 10, y: 20 }, [true, false]);
    const inverted = ichimokuCloudPolygons({ x: 0, y: 90 }, { x: 10, y: 60 }, { x: 0, y: 70 }, { x: 10, y: 80 }, [true, false]);
    expect(inverted.map(p => p.positive)).toEqual(normal.map(p => p.positive));
    expect(inverted[0].points[1]).toEqual({ x: 5, y: 75 });
    const { primitive, snapshot } = setup();
    const model = projectIchimoku(snapshot.model.bars, { conversion: 1, base: 1, leadingB: 5, displacement: 2 });
    primitive.setSnapshot({ ...snapshot, model });
    expect(primitive.autoscaleInfo(100 as Logical, 110 as Logical)).toBeNull();
  });

  it('pulls viewport and price coordinates on every draw, clips, and releases attachment', () => {
    const { primitive, snapshot, timeScale, requestUpdate } = setup();
    const moves: number[][] = [], ctx = { save() {}, restore() {}, beginPath() {}, closePath() {}, clip: vi.fn(), rect: vi.fn(), fill: vi.fn(), stroke() {}, moveTo: (...p: number[]) => moves.push(p), lineTo: (...p: number[]) => moves.push(p), globalAlpha: 1 };
    const target = { useMediaCoordinateSpace: (draw: (scope: unknown) => void) => draw({ context: ctx, mediaSize: { width: 100, height: 100 } }) } as unknown as CanvasRenderingTarget2D;
    primitive.paneViews()[0].renderer()!.draw(target);
    expect(ctx.clip).toHaveBeenCalled(); expect(ctx.fill).toHaveBeenCalled();
    expect(moves.some(p => p[0] === 70)).toBe(true);
    timeScale.logicalToCoordinate = (i: number) => (i - 100) * 20;
    moves.length = 0; primitive.paneViews()[0].renderer()!.draw(target);
    expect(moves.some(p => p[0] === 140)).toBe(true);
    expect(primitive.paneViews()[1].zOrder?.()).toBe('normal');
    primitive.setSnapshot({ ...snapshot, candleAlwaysOnTop: true });
    expect(primitive.paneViews()[1].zOrder?.()).toBe('bottom');
    primitive.detached(); const calls = requestUpdate.mock.calls.length;
    primitive.setSnapshot(snapshot); expect(requestUpdate).toHaveBeenCalledTimes(calls);
    expect(primitive.autoscaleInfo(100 as Logical, 110 as Logical)).toBeNull();
    expect(ICHIMOKU_LINES).toHaveLength(5);
  });
});
