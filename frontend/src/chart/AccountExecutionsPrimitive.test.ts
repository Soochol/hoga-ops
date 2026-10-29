import { expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { SeriesAttachedParameter, Time } from 'lightweight-charts';
import { AccountExecutionsPrimitive } from './AccountExecutionsPrimitive';
import type { ExecutionMarker } from './projectors/accountExecutions';

function fixture() {
  const ctx = { font: '', save: vi.fn(), restore: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(),
    rect: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  const state = { x: 100, project: (price: number) => price * 2 };
  const primitive = new AccountExecutionsPrimitive();
  primitive.attached({ chart: { timeScale: () => ({ timeToCoordinate: () => state.x }) },
    series: { priceToCoordinate: (price: number) => state.project(price) }, requestUpdate: vi.fn() } as unknown as SeriesAttachedParameter<Time>);
  const target = { useMediaCoordinateSpace: (draw: (value: unknown) => void) => draw({ context: ctx, mediaSize: { width: 300, height: 300 } }) } as CanvasRenderingTarget2D;
  return { primitive, ctx, state, draw: () => primitive.paneViews()[0].renderer()!.draw(target) };
}
const buy: ExecutionMarker = { time: 1 as Time, price: 100, side: 'BUY', executions: [], barExecutions: [] };
const sell = { ...buy, side: 'SELL' as const };

it('centers B/S at actual prices, preserves overlap and adds neither ticks nor a width limit', () => {
  const { primitive, ctx, draw } = fixture();
  primitive.setMarkers([buy, sell, { ...buy, price: 105 }]); draw();
  expect(ctx.fillText.mock.calls).toEqual([['B', 100, 200], ['S', 100, 200], ['B', 100, 210]]);
  expect(ctx.strokeText.mock.calls).toEqual(ctx.fillText.mock.calls);
  expect(ctx.font).toContain('500 13px');
  expect(ctx.rect.mock.calls).toEqual([[0, 0, 300, 300]]); // Only the pane clips text, never a candle column.
  expect(ctx.moveTo).not.toHaveBeenCalled(); expect(ctx.lineTo).not.toHaveBeenCalled(); expect(ctx.stroke).not.toHaveBeenCalled();
  expect(primitive.detailAt(108, 200)).toBe(buy); // Full glyph remains clickable outside a narrow candle.
  const updatedBuy = { ...buy, executions: [...buy.executions] };
  primitive.setMarkers([updatedBuy, sell, { ...buy, price: 105 }]);
  expect(primitive.detailAt(108, 200)).toBe(updatedBuy);
  primitive.setMarkers([{ ...updatedBuy, price: 110 }, sell]);
  expect(primitive.detailAt(100, 220)).toBeNull();
  primitive.setMarkers([]); ctx.fillText.mockClear(); draw();
  expect(ctx.fillText).not.toHaveBeenCalled(); expect(primitive.detailAt(100, 200)).toBeNull();
});

it('keeps every nearby price separate and keeps the font fixed as chart coordinates change', () => {
  const { primitive, ctx, state, draw } = fixture();
  const points = [buy, { ...buy, price: 101 }, { ...sell, price: 102 }];
  primitive.setMarkers(points); draw();
  expect(ctx.fillText.mock.calls).toEqual([['B', 100, 200], ['B', 100, 202], ['S', 100, 204]]);
  state.x = 42; state.project = price => 100 + (price - 100) * 4;
  ctx.fillText.mockClear(); draw();
  expect(ctx.fillText.mock.calls).toEqual([['B', 42, 100], ['B', 42, 104], ['S', 42, 108]]);
  expect(ctx.font).toContain('500 13px');
  expect(primitive.detailAt(42, 104)).toBe(points[1]);
  primitive.detached(); expect(primitive.detailAt(42, 104)).toBeNull();
});

it.each([
  (price: number) => 300 - price * 2,
  (price: number) => Math.log(price) * 30,
])('uses live inverted/logarithmic price coordinates for each label', project => {
  const { primitive, ctx, state, draw } = fixture();
  state.project = project;
  primitive.setMarkers([buy, { ...sell, price: 120 }]); draw();
  expect(ctx.fillText.mock.calls).toEqual([['B', 100, project(100)], ['S', 100, project(120)]]);
});
