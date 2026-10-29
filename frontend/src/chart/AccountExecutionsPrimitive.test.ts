import { expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { SeriesAttachedParameter, Time } from 'lightweight-charts';
import { AccountExecutionsPrimitive } from './AccountExecutionsPrimitive';
import type { ExecutionMarker } from './projectors/accountExecutions';

function fixture() {
  const ctx = { save: vi.fn(), restore: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(),
    rect: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  const state = { pitch: 40, project: (price: number) => price * 2 };
  const primitive = new AccountExecutionsPrimitive();
  primitive.attached({ chart: { timeScale: () => ({ timeToCoordinate: () => 100, options: () => ({ barSpacing: 6 }),
    getVisibleLogicalRange: () => ({ from: 0, to: 10 }), logicalToCoordinate: (logical: number) => logical * state.pitch }) },
  series: { priceToCoordinate: (price: number) => state.project(price) }, requestUpdate: vi.fn() } as unknown as SeriesAttachedParameter<Time>);
  const target = { useMediaCoordinateSpace: (draw: (value: unknown) => void) => draw({ context: ctx, mediaSize: { width: 300, height: 300 } }) } as CanvasRenderingTarget2D;
  return { primitive, ctx, state, draw: () => primitive.paneViews()[0].renderer()!.draw(target) };
}
const buy: ExecutionMarker = { time: 1 as Time, price: 100, side: 'BUY', executions: [], barExecutions: [] };
const sell = { ...buy, side: 'SELL' as const };

it('paints left B/right S and exact ticks using live pitch; refreshes details and clears disabled hits', () => {
  const { primitive, ctx, draw } = fixture();
  primitive.setMarkers([buy, sell]); draw();
  expect(ctx.fillText.mock.calls).toEqual([
    ['B', expect.closeTo(90.9), 200, expect.closeTo(9.8)], ['S', expect.closeTo(109.1), 200, expect.closeTo(9.8)],
  ]);
  expect(ctx.moveTo.mock.calls).toEqual([[100, 200], [100, 200]]);
  expect(ctx.lineTo.mock.calls[0][0]).toBeLessThan(100);
  expect(ctx.lineTo.mock.calls[1][0]).toBeGreaterThan(100);
  expect(primitive.detailAt(90.9, 200)).toBe(buy);
  expect(primitive.detailAt(109.1, 200)).toBe(sell);
  expect(primitive.detailAt(100, 200)).not.toBeNull();
  const updatedBuy = { ...buy, executions: [...buy.executions] };
  primitive.setMarkers([updatedBuy, sell]);
  expect(primitive.detailAt(90.9, 200)).toBe(updatedBuy);
  primitive.setMarkers([{ ...updatedBuy, price: 110 }, sell]);
  expect(primitive.detailAt(90.9, 200)).toBeNull();
  primitive.setMarkers([]); ctx.fillText.mockClear(); ctx.moveTo.mockClear(); draw();
  expect(ctx.fillText).not.toHaveBeenCalled(); expect(ctx.moveTo).not.toHaveBeenCalled();
  expect(primitive.detailAt(90.9, 200)).toBeNull();
});

it('retains clickable ticks for grouped fills and recomputes label groups after price and time zoom', () => {
  const { primitive, ctx, state, draw } = fixture();
  const next = { ...buy, price: 105 };
  primitive.setMarkers([buy, next]); draw();
  expect(ctx.fillText).toHaveBeenCalledTimes(1);
  expect(ctx.fillText.mock.calls[0][2]).toBe(205);
  expect(ctx.moveTo.mock.calls).toEqual([[100, 200], [100, 210]]);
  expect(primitive.detailAt(100, 210)).toBe(next);
  state.project = price => 100 + (price - 100) * 4;
  state.pitch = 6; ctx.fillText.mockClear(); ctx.moveTo.mockClear(); draw();
  expect(ctx.fillText).toHaveBeenCalledTimes(2);
  expect(ctx.moveTo.mock.calls).toEqual([[100, 100], [100, 120]]);
  expect(ctx.fillText.mock.calls.every(([, x, , maxWidth]) => Math.abs(x - 100) + maxWidth / 2 <= 2.1)).toBe(true);
  expect(primitive.detailAt(104, 100)).toBeNull();
  primitive.detached(); expect(primitive.detailAt(100, 100)).toBeNull();
});

it.each([
  (price: number) => 300 - price * 2,
  (price: number) => Math.log(price) * 30,
])('uses live inverted/logarithmic coordinates for every price tick', project => {
  const { primitive, ctx, state, draw } = fixture();
  state.project = project;
  primitive.setMarkers([buy, { ...sell, price: 120 }]); draw();
  expect(ctx.moveTo.mock.calls).toEqual([[100, project(100)], [100, project(120)]]);
  expect(ctx.rect).toHaveBeenCalledWith(0, 0, 300, 300);
  expect(ctx.clip).toHaveBeenCalled();
});
