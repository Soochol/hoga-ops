import { describe, expect, it } from 'vitest';
import { projectIchimoku, valuesAtDisplayBar, ichimokuConnected, type IchimokuBar } from './ichimoku';
const bars: IchimokuBar[] = [10, 14, 12, 20, 18, 16].map((high, i) => ({ high, low: [2, 4, 6, 8, 10, 12][i], close: [6, 12, 9, 18, 14, 15][i], virtualSecond: i * 10, breakBefore: false }));
describe('Ichimoku source and display coordinates', () => {
  it('matches the independent high/low fixture and displaced display values', () => {
    const model = projectIchimoku(bars, { conversion: 2, base: 3, leadingB: 4, displacement: 2 });
    expect(model.lines.conversion.values).toEqual([null, 8, 9, 13, 14, 14]);
    expect(model.lines.base.values).toEqual([null, null, 8, 12, 13, 14]);
    expect(model.lines.leadingA.values).toEqual([null, null, 8.5, 12.5, 13.5, 14]);
    expect(model.lines.leadingB.values).toEqual([null, null, null, 11, 12, 13]);
    expect(valuesAtDisplayBar(model, 4).leadingA).toBe(8.5);
    expect(valuesAtDisplayBar(model, 7).leadingA).toBe(14);
    expect([0, 1, 2, 3].map(i => valuesAtDisplayBar(model, i).lagging)).toEqual([9, 18, 14, 15]);
    expect(valuesAtDisplayBar(model, 5).lagging).toBeNull();
  });
  it('uses exactly +26 and -26 with current-inclusive 9/26/52 windows', () => {
    const model = projectIchimoku(Array.from({ length: 52 }, (_, i) => ({ virtualSecond: i * 123, high: 100 + i, low: i, close: 50 + i, breakBefore: false })), { conversion: 9, base: 26, leadingB: 52, displacement: 26 });
    expect(valuesAtDisplayBar(model, 51)).toMatchObject({ conversion: 97, base: 88.5, lagging: null });
    expect(valuesAtDisplayBar(model, 77)).toMatchObject({ leadingA: 92.75, leadingB: 75.5 });
    expect(valuesAtDisplayBar(model, 25).lagging).toBe(101);
    expect(model.bars).toHaveLength(52);
    expect(model.lines.leadingA.values).toHaveLength(52);
  });
  it('retains invalid-window holes, zero displacement and source/target capture breaks', () => {
    const model = projectIchimoku(bars.map((bar, i) => ({ ...bar, ...(i === 2 ? { high: NaN, breakBefore: true } : {}) })), { conversion: 2, base: 3, leadingB: 4, displacement: 0 });
    expect(model.lines.conversion.values).toEqual([null, 8, null, null, 14, 14]);
    expect(valuesAtDisplayBar(model, 5).lagging).toBe(15);
    expect(ichimokuConnected(model, 2, 0)).toBe(false);
    expect(ichimokuConnected(model, 1, 1)).toBe(false);
    expect(ichimokuConnected(model, 4, 2)).toBe(true);
  });
});
