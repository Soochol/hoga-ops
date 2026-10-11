import { describe, expect, it } from 'vitest';
import { projectTradeValue } from './tradeValue';
import { buildIndexBundle } from '../../live/buildIndexBundle';
import { createVirtualAxis } from '../../util/virtualAxis';
import { formatKoreanWonAmount } from '../../util/koreanNumber';

const open = Date.parse('2026-10-01T09:00:00+09:00');
const axis = createVirtualAxis([{ date: '20261001', sessionOpenMs: open, sessionCloseMs: open + 23400000 }]);

describe('index turnover projection', () => {
  it('aligns with candles, uses actual KRW, preserves zero and omits unavailable amounts', () => {
    const bundle = buildIndexBundle({
      indexId: 'KOSPI', from: '20261001', to: '20261001', bucketMs: 86400000,
      candles: [18840196000000, 54703685000000, 0, null, undefined, NaN, -1].map((trade_value_won, i) => ({
        t_ms: open + i * 1000, open: 3000, close: i === 1 ? 2900 : 3100,
        high: 3100, low: 2900, volume: 999999, trade_value_won,
      })),
    });
    const bars = projectTradeValue(bundle, axis);
    expect(bars.map(p => p.value)).toEqual([18840196000000, 54703685000000, 0]);
    expect(bars.map(p => p.time)).toEqual([0, 1, 2]);
    expect(bars[0].color).not.toBe(bars[1].color);
    expect(bars[0].color).toBe(bars[2].color);
    expect(projectTradeValue({ ...bundle, candles: [{ ...bundle.candles[0], ts_ms: open - 1000 }] }, axis)).toEqual([]);
  });

  it.each([
    [18840196000000, '18.84조'], [706727200000, '7,067억'], [125000000, '1.25억'], [0, '0억'],
  ])('formats %d KRW as %s', (value, label) => {
    expect(formatKoreanWonAmount(value)).toBe(label);
  });
});
