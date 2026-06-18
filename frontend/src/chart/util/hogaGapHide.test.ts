import { describe, expect, it } from 'vitest';
import type { Candle, QuoteRatioPoint } from '../../api/types';
import { isSyntheticHogaGapPoint, withHogaGapSentinels } from './hogaGapHide';

const MINUTE = 60_000;
const T0 = 1_779_926_400_000;

function candle(t: number): Candle {
  return { ts_ms: t, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 };
}

function qr(t: number, bid = 100, ask = 200): QuoteRatioPoint {
  return {
    t,
    bid_total: bid,
    ask_total: ask,
    bid_max: bid,
    ask_max: ask,
    imb_max_bid: bid,
    imb_max_ask: ask,
  };
}

describe('withHogaGapSentinels', () => {
  it('returns an empty array when there are no hoga points at all', () => {
    expect(withHogaGapSentinels([], [candle(T0), candle(T0 + MINUTE)], MINUTE)).toEqual([]);
  });

  it('returns sorted real points when candles are absent', () => {
    expect(withHogaGapSentinels([qr(T0 + MINUTE), qr(T0)], [], MINUTE).map((p) => p.t)).toEqual([
      T0,
      T0 + MINUTE,
    ]);
  });

  it('injects a synthetic zero point for candle buckets without hoga between real hoga points', () => {
    const out = withHogaGapSentinels(
      [qr(T0, 10, 20), qr(T0 + 2 * MINUTE, 30, 40)],
      [candle(T0), candle(T0 + MINUTE), candle(T0 + 2 * MINUTE)],
      MINUTE,
    );

    expect(out.map((p) => p.t)).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE]);
    expect(isSyntheticHogaGapPoint(out[0])).toBe(false);
    expect(isSyntheticHogaGapPoint(out[1])).toBe(true);
    expect(out[1]).toMatchObject({
      bid_total: 0,
      ask_total: 0,
      bid_max: 0,
      ask_max: 0,
      imb_max_bid: 0,
      imb_max_ask: 0,
    });
    expect(isSyntheticHogaGapPoint(out[2])).toBe(false);
  });

  it('does not inject leading or trailing sentinels outside the hoga-covered span', () => {
    const out = withHogaGapSentinels(
      [qr(T0 + MINUTE), qr(T0 + 3 * MINUTE)],
      [
        candle(T0),
        candle(T0 + MINUTE),
        candle(T0 + 2 * MINUTE),
        candle(T0 + 3 * MINUTE),
        candle(T0 + 4 * MINUTE),
      ],
      MINUTE,
    );

    expect(out.map((p) => p.t)).toEqual([T0 + MINUTE, T0 + 2 * MINUTE, T0 + 3 * MINUTE]);
    expect(isSyntheticHogaGapPoint(out[1])).toBe(true);
  });
});
