import { expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { SeriesAttachedParameter, Time } from 'lightweight-charts';
import { AccountExecutionsPrimitive } from './AccountExecutionsPrimitive';
import type { ExecutionMarker } from './projectors/accountExecutions';

it('paints only B/S at live series price coordinates and clears drawing/hits when disabled', () => {
  const ctx = { save: vi.fn(), restore: vi.fn(), strokeText: vi.fn(), fillText: vi.fn() };
  const update = vi.fn();
  const primitive = new AccountExecutionsPrimitive();
  primitive.attached({ chart: { timeScale: () => ({ timeToCoordinate: () => 100 }) },
    series: { priceToCoordinate: (price: number) => price * 2 }, requestUpdate: update } as unknown as SeriesAttachedParameter<Time>);
  const buy: ExecutionMarker = { time: 1 as Time, price: 100, side: 'BUY', executions: [], barExecutions: [] };
  const sell = { ...buy, side: 'SELL' as const };
  primitive.setMarkers([buy, sell]);
  const target = { useMediaCoordinateSpace: (draw: (value: unknown) => void) => draw({ context: ctx, mediaSize: { width: 300, height: 300 } }) } as CanvasRenderingTarget2D;
  primitive.paneViews()[0].renderer()!.draw(target);
  expect(ctx.fillText.mock.calls).toEqual([['B', 92, 200], ['S', 108, 200]]);
  expect(primitive.detailAt(92, 200)).toBe(buy);
  expect(primitive.detailAt(108, 200)).toBe(sell);
  primitive.setMarkers([]);
  ctx.fillText.mockClear(); primitive.paneViews()[0].renderer()!.draw(target);
  expect(ctx.fillText).not.toHaveBeenCalled(); expect(primitive.detailAt(92, 200)).toBeNull();
});
