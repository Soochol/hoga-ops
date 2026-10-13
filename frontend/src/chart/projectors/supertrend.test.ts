import { describe, expect, it } from 'vitest';
import { computeSupertrend, supertrendLineData } from './supertrend';

const prices = (closes: number[]) => closes.map(close => ({ high: close + 1, low: close - 1, close }));

describe('computeSupertrend', () => {
  it('includes gaps in true range, seeds with SMA, then uses Wilder smoothing', () => {
    const out = computeSupertrend(prices([10, 10, 14, 15]), 3, 1);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toEqual({ atr: 3, direction: 'down', value: 17 }); // TR = 2, 2, 5
    expect(out[3]?.atr).toBeCloseTo(8 / 3); // RMA, not rolling SMA (= 3)
  });

  it('trails the final band and flips in both directions on strict crossings', () => {
    const out = computeSupertrend(prices([10, 10, 14, 15, 9, 8, 14, 15]), 2, 1);
    expect(out).toEqual([
      null,
      { value: 12, direction: 'down', atr: 2 },
      { value: 10.5, direction: 'up', atr: 3.5 },
      { value: 12.25, direction: 'up', atr: 2.75 },
      { value: 13.875, direction: 'down', atr: 4.875 },
      { value: 11.4375, direction: 'down', atr: 3.4375 },
      { value: 8.78125, direction: 'up', atr: 5.21875 },
      { value: 11.390625, direction: 'up', atr: 3.609375 },
    ]);
    const equal = computeSupertrend(prices([10, 10, 12, 14, 10.5]), 2, 1);
    expect(equal[2]?.direction).toBe('down'); // close == upper band
  });

  it('supports period 1, flat prices and reseeding after invalid data', () => {
    expect(computeSupertrend([{ high: 10, low: 10, close: 10 }], 1, 3)).toEqual([{ value: 10, direction: 'down', atr: 0 }]);
    const input = [...prices([10, 10]), { high: NaN, low: 9, close: 10 }, ...prices([20, 20])];
    expect(computeSupertrend(input, 2, 1)).toEqual([null, { atr: 2, value: 12, direction: 'down' }, null, null, { atr: 2, value: 22, direction: 'down' }]);
    expect(computeSupertrend(prices([10]), 10, 3)).toEqual([null]);
    for (const period of [0, -1, 1.2, NaN]) expect(computeSupertrend(prices([10]), period, 3)).toEqual([null]);
    for (const multiplier of [0, -1, Infinity, NaN]) expect(computeSupertrend(prices([10]), 1, multiplier)).toEqual([null]);
  });

  it('price corrections change only their suffix and the input remains immutable', () => {
    const input = prices([10, 10, 14, 15, 9, 8]);
    const original = structuredClone(input);
    const out = computeSupertrend(input, 2, 1);
    const corrected = computeSupertrend([...input.slice(0, -1), ...prices([20])], 2, 1);
    expect(corrected.slice(0, -1)).toEqual(out.slice(0, -1));
    expect(corrected.at(-1)?.direction).toBe('up');
    expect(input).toEqual(original);
  });
});

describe('supertrendLineData', () => {
  it('breaks outgoing flip/gap connectors and preserves the value for cursor reads', () => {
    const down = { value: 12, direction: 'down' as const, atr: 2 };
    const up = { value: 8, direction: 'up' as const, atr: 2 };
    expect(supertrendLineData([null, down, down, up, up, null, down], [1, 2, 3, 4, 5, 6, 7], '#F04452', '#3485FA')).toEqual([
      { time: 1 },
      { time: 2, value: 12, color: '#3485FA' },
      { time: 3, value: 12, color: 'transparent' },
      { time: 4, value: 8, color: '#F04452' },
      { time: 5, value: 8, color: 'transparent' },
      { time: 6 },
      { time: 7, value: 12, color: '#3485FA' },
    ]);
  });
});
