import { describe, expect, it } from 'vitest';
import type { Candle } from '../api/types';
import { createSessionCandleLookup } from './sessionCandles';
const candle = (ts_ms: number): Candle => ({ ts_ms, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 });
describe('session candle lookup', () => {
  it.each([{ times: [1, 2, 2, 3, 5] }, { times: [5, 2, 3, 2, 1] }, { times: [1, NaN, 3] }])('preserves filter semantics and order for %j', ({ times }) => {
    const candles = times.map(candle);
    const lookup = createSessionCandleLookup(candles);
    for (const open of [0, 1, 2, 4, 6]) for (const close of [0, 2, 3, 7]) {
      expect(lookup({ session_open_ms: open, session_close_ms: close }))
        .toEqual(candles.filter(c => c.ts_ms >= open && c.ts_ms < close));
    }
  });
  it('does not scan all candles again for each sorted session', () => {
    let reads = 0;
    const candles = Array.from({ length: 1000 }, (_, i) => ({ ...candle(i), get ts_ms() { reads++; return i; } }));
    const lookup = createSessionCandleLookup(candles);
    for (let i = 0; i < 30; i++) expect(lookup({ session_open_ms: i * 30, session_close_ms: (i + 1) * 30 })).toHaveLength(30);
    expect(reads).toBeLessThan(4000); // one ordering pass plus 60 binary searches; formerly 30,000+.
  });
});
