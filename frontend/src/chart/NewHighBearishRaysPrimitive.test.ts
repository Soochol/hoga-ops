import { expect, it, vi } from 'vitest';
import { NewHighBearishRaysPrimitive } from './NewHighBearishRaysPrimitive';

it('draws from the originating candle to the pane right edge, clips offscreen origins and clears hidden rays', () => {
  const primitive = new NewHighBearishRaysPrimitive(), update = vi.fn();
  primitive.attached({ chart: { timeScale: () => ({ options: () => ({ barSpacing: 6 }), timeToCoordinate: (x: number) => x === 999 ? null : x }) },
    series: { priceToCoordinate: (p: number) => p }, requestUpdate: update } as never);
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), lineWidth: 1 };
  const target = { useBitmapCoordinateSpace: (fn: (value: unknown) => void) => fn({ context: ctx, bitmapSize: { width: 600, height: 300 }, horizontalPixelRatio: 2, verticalPixelRatio: 2 }) } as never;
  primitive.setData([{ time: 40, endTime: 100, price: 100 }, { time: -20, endTime: 400, price: 110 }, { time: 999, endTime: 400, price: 100 }, { time: 400, endTime: 500, price: 100 }], '#123456', 1);
  primitive.paneViews()[0].renderer()!.draw(target);
  expect(ctx.moveTo.mock.calls).toEqual([[80, 200], [0, 220]]);
  expect(ctx.lineTo.mock.calls).toEqual([[206, 200], [600, 220]]);
  expect(ctx.stroke).toHaveBeenCalledTimes(2);
  primitive.setData([], '#123456', 1);
  primitive.paneViews()[0].renderer()!.draw(target);
  expect(ctx.stroke).toHaveBeenCalledTimes(2);
  primitive.detached();
  primitive.paneViews()[0].renderer()!.draw(target);
  expect(update).toHaveBeenCalledTimes(2);
});
