import { describe, expect, it, vi } from 'vitest';
import { computeWheelOutcome, type WheelInput } from './wheelInteractions';

function baseInput(over: Partial<WheelInput> = {}): WheelInput {
  return {
    range: { from: 0, to: 100 }, deltaY: 100,
    shiftKey: false, ctrlOrMetaKey: false, mouseX: 450,
    coordinateToLogical: () => 50, maxTo: Infinity, ...over,
  };
}

// Actual CSS pixel coordinate of a candle centre in lightweight-charts.
function pixelX(range: { from: number; to: number }, index: number, width = 942) {
  return width - 1 - (range.to - index + 0.5) * width / (range.to - range.from + 1);
}

function cursorIndex(range: { from: number; to: number }, x: number, width = 942) {
  return range.to + 0.5 - (width - 1 - x) * (range.to - range.from + 1) / width;
}

describe('computeWheelOutcome', () => {
  for (const deltaY of [-120, 120]) {
    it(`keeps the historical candle centre on zoom ${deltaY}`, () => {
      const spy = vi.fn(() => 50);
      const input = baseInput({deltaY, lastBarIndex: 300, visibleCandleIndex: 100, coordinateToLogical: spy});
      const out = computeWheelOutcome(input)!;
      expect(pixelX(out, 100)).toBeCloseTo(pixelX(input.range, 100), 9);
      expect(out.to - out.from + 1).toBeCloseTo(101 * Math.exp(deltaY * .001), 10);
      expect(spy).not.toHaveBeenCalled();
    });
  }

  for (const to of [100, 100.25, 100.75]) {
    it(`preserves a sparse historical candle at a fractional edge ${to}`, () => {
      const range = { from: to - 10, to };
      const out = computeWheelOutcome(baseInput({ range, lastBarIndex: 300,
        visibleCandleIndex: 98, firstBarIndex: 0, deltaY: -120 }))!;
      expect(pixelX(out, 98)).toBeCloseTo(pixelX(range, 98), 9);
    });
  }

  it('stops at the oldest-data exposure limit without moving the anchor', () => {
    const range = { from: -9, to: 1 };
    expect(computeWheelOutcome(baseInput({ range, lastBarIndex: 300,
      firstBarIndex: 0, visibleCandleIndex: 1, deltaY: -120, minSpan: 1 }))).toEqual(range);
  });

  it('keeps the right edge when the latest candle is unavailable, ignoring the Shift wall', () => {
    expect(computeWheelOutcome(baseInput({maxTo: 50}))!.to).toBe(100);
  });

  for (const span of [1, 3, 10, 30, 100, 420]) {
    it(`keeps the latest candle pixel fixed through repeated zooms at span ${span}`, () => {
      let range = {from: 3999 - span * .7, to: 3999 + span * .3};
      const beforeX = pixelX(range, 3999);
      for (const deltaY of [-120, 120, -120, 120]) {
        range = computeWheelOutcome(baseInput({range, deltaY, lastBarIndex: 3999, minSpan: 1}))!;
        expect(pixelX(range, 3999)).toBeCloseTo(beforeX, 8);
      }
    });
  }

  for (const mouseX of [0, 450.25, 920]) {
    it(`preserves the continuous Ctrl/Cmd cursor at x=${mouseX}, including blank space`, () => {
      let range = {from: 3990, to: 4002};
      const anchor = cursorIndex(range, mouseX);
      const callback = vi.fn(() => 3999);
      for (const deltaY of [-120, -120, 120, 120]) {
        range = computeWheelOutcome(baseInput({range, deltaY, ctrlOrMetaKey: true,
          plotWidth: 942, mouseX, coordinateToLogical: callback, maxTo: 4000, minSpan: 1}))!;
        expect(pixelX(range, anchor)).toBeCloseTo(mouseX, 8);
      }
      expect(callback).not.toHaveBeenCalled();
    });
  }

  it('uses the supplied cursor mapping when no plot width is available', () => {
    const callback = vi.fn(() => 80);
    const input = baseInput({range: {from: 50, to: 99}, ctrlOrMetaKey: true,
      coordinateToLogical: callback, maxTo: 100});
    const out = computeWheelOutcome(input)!;
    expect(out.to).toBeGreaterThan(100);
    expect(pixelX(out, 80)).toBeCloseTo(pixelX(input.range, 80), 10);
    expect(callback).toHaveBeenCalledWith(input.mouseX);
  });

  it('falls back to the right edge when the cursor mapping is null', () => {
    const out = computeWheelOutcome(baseInput({ctrlOrMetaKey: true, coordinateToLogical: () => null}))!;
    expect(out.to).toBe(100);
  });

  for (const ctrlOrMetaKey of [false, true]) {
    for (const bound of ['min', 'max'] as const) {
      it(`preserves the pixel anchor when clamping ${bound} span, ctrl=${ctrlOrMetaKey}`, () => {
        const input = baseInput({range: {from: 90, to: 110}, lastBarIndex: 100,
          ctrlOrMetaKey, coordinateToLogical: () => 100,
          deltaY: bound === 'min' ? -1000 : 1000, minSpan: 10, maxSpan: 25});
        const out = computeWheelOutcome(input)!;
        expect(out.to - out.from).toBeCloseTo(bound === 'min' ? 10 : 25, 9);
        expect(pixelX(out, 100)).toBeCloseTo(pixelX(input.range, 100), 9);
      });

      it(`does not pan at the ${bound} span limit, ctrl=${ctrlOrMetaKey}`, () => {
        const span = bound === 'min' ? 1 : 100;
        const range = {from: 99 - span, to: 99};
        const input = baseInput({range, ctrlOrMetaKey, lastBarIndex: 99,
          plotWidth: 942, minSpan: 1, maxSpan: 100, deltaY: bound === 'min' ? -120 : 120});
        expect(computeWheelOutcome(input)).toEqual(range);
      });
    }
  }

  it('preserves the historical right edge when clamped', () => {
    expect(computeWheelOutcome(baseInput({maxSpan: 105}))).toEqual({from: -5, to: 100});
  });

  it('ignores invalid nonpositive maxSpan instead of collapsing the viewport', () => {
    const unlimited = computeWheelOutcome(baseInput());
    expect(computeWheelOutcome(baseInput({maxSpan: 0}))).toEqual(unlimited);
    expect(computeWheelOutcome(baseInput({maxSpan: NaN}))).toEqual(unlimited);
  });

  it('allows zooming out from a single-bar inclusive range', () => {
    const out = computeWheelOutcome(baseInput({range: {from: 5, to: 5}, lastBarIndex: 5}))!;
    expect(out.to - out.from).toBeGreaterThan(0);
    expect(pixelX(out, 5)).toBeCloseTo(pixelX({from: 5, to: 5}, 5), 9);
  });

  for (const input of [baseInput({range: {from: 10, to: 5}}), baseInput({deltaY: 0}),
    baseInput({deltaY: NaN}), baseInput({range: {from: 0, to: Infinity}})]) {
    it(`ignores invalid/no-op input ${JSON.stringify(input.range)} delta=${input.deltaY}`, () => {
      expect(computeWheelOutcome(input)).toBeNull();
    });
  }

  it('pans left and right by 10% of the span', () => {
    expect(computeWheelOutcome(baseInput({shiftKey: true}))).toEqual({from: 10, to: 110});
    expect(computeWheelOutcome(baseInput({shiftKey: true, deltaY: -100}))).toEqual({from: -10, to: 90});
  });

  it('gives Shift priority over Ctrl/Cmd and ignores zoom limits', () => {
    expect(computeWheelOutcome(baseInput({shiftKey: true, ctrlOrMetaKey: true, maxSpan: 50})))
      .toEqual({from: 10, to: 110});
  });

  it('clamps Shift pan-right at its wall while preserving span', () => {
    expect(computeWheelOutcome(baseInput({range: {from: 50, to: 99}, shiftKey: true, maxTo: 100})))
      .toEqual({from: 51, to: 100});
  });

  it('lets Shift pan-left return from beyond the wall', () => {
    expect(computeWheelOutcome(baseInput({range: {from: 20, to: 115}, shiftKey: true, deltaY: -100, maxTo: 100})))
      .toEqual({from: 10.5, to: 105.5});
  });
});
