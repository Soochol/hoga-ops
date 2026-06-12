import { describe, it, expect } from 'vitest';
import { computeVisibleExtremes } from './visibleExtremes';
import { createVirtualAxis, type VirtualAxis } from '../util/virtualAxis';
import type { Candle } from '../api/types';

// 단일 거래일 axis: 2026-06-12, 09:00–15:30 KST. originMs = sessionOpen (real-anchored,
// /live와 동일) → 세션 내 봉의 toVirtual(t) = t (가상=실 ms), vSec = t/1000.
const OPEN = Date.UTC(2026, 5, 12, 0, 0, 0); // 09:00 KST = 00:00 UTC
const CLOSE = OPEN + 6.5 * 3_600_000; // 15:30 KST
const axis: VirtualAxis = createVirtualAxis(
  [{ date: '20260612', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }],
  OPEN,
);
const FULL_RANGE = { from: OPEN / 1000, to: CLOSE / 1000 };

function candle(tsMs: number, high: number, low: number): Candle {
  const mid = (high + low) / 2;
  return { ts_ms: tsMs, open: mid, close: mid, high, low, vol_a: 0, vol_b: 0 };
}

describe('computeVisibleExtremes', () => {
  it('finds the highest-high and lowest-low visible candle with 극값 대비율', () => {
    const tHigh = OPEN + 120_000; // 09:02
    const tLow = OPEN + 180_000; // 09:03
    const candles = [
      candle(OPEN + 60_000, 37_000, 36_900),
      candle(tHigh, 38_800, 38_000),
      candle(tLow, 37_500, 36_750),
    ];

    const ex = computeVisibleExtremes(candles, axis, FULL_RANGE, 37_100);

    expect(ex).not.toBeNull();
    expect(ex!.high.price).toBe(38_800);
    expect(ex!.high.tsMs).toBe(tHigh);
    expect(ex!.high.virtualSec).toBe(tHigh / 1000);
    expect(ex!.high.pct).toBeCloseTo(-4.38, 2); // (37100-38800)/38800*100
    expect(ex!.low.price).toBe(36_750);
    expect(ex!.low.tsMs).toBe(tLow);
    expect(ex!.low.pct).toBeCloseTo(0.95, 2); // (37100-36750)/36750*100
  });

  it('ignores candles outside the visible range', () => {
    const candles = [
      candle(OPEN + 60_000, 37_000, 36_900),
      candle(OPEN + 120_000, 38_000, 37_000),
      candle(OPEN + 200_000, 50_000, 30_000), // beyond `to` → excluded
    ];
    const range = { from: OPEN / 1000, to: (OPEN + 150_000) / 1000 };

    const ex = computeVisibleExtremes(candles, axis, range, 37_100);

    expect(ex!.high.price).toBe(38_000);
    expect(ex!.low.price).toBe(36_900);
  });

  it('ignores candles not drawn on the axis (axis.contains false)', () => {
    const candles = [
      candle(OPEN - 60_000, 99_999, 1), // pre-open (08:59) → not contained
      candle(OPEN + 120_000, 38_000, 37_000),
    ];
    const range = { from: (OPEN - 60_000) / 1000, to: CLOSE / 1000 };

    const ex = computeVisibleExtremes(candles, axis, range, 37_100);

    expect(ex!.high.price).toBe(38_000);
    expect(ex!.low.price).toBe(37_000);
  });

  it('keeps the first occurrence on a tie (stability under scroll)', () => {
    const tFirst = OPEN + 60_000;
    const tSecond = OPEN + 120_000;
    const candles = [candle(tFirst, 38_800, 36_000), candle(tSecond, 38_800, 37_000)];

    const ex = computeVisibleExtremes(candles, axis, FULL_RANGE, 37_100);

    expect(ex!.high.tsMs).toBe(tFirst);
  });

  it('returns null on null/empty inputs', () => {
    const candles = [candle(OPEN + 60_000, 38_000, 37_000)];
    expect(computeVisibleExtremes(candles, axis, null, 37_100)).toBeNull();
    expect(computeVisibleExtremes([], axis, FULL_RANGE, 37_100)).toBeNull();
    expect(computeVisibleExtremes(candles, axis, FULL_RANGE, null)).toBeNull();
  });

  it('returns null when no candle falls in the visible range', () => {
    const candles = [candle(OPEN + 60_000, 38_000, 37_000), candle(OPEN + 120_000, 38_500, 37_500)];
    const range = { from: (CLOSE - 10_000) / 1000, to: CLOSE / 1000 }; // after all candles

    expect(computeVisibleExtremes(candles, axis, range, 37_100)).toBeNull();
  });

  it('yields pct 0 when current price equals an extreme', () => {
    const ex = computeVisibleExtremes([candle(OPEN + 60_000, 38_800, 36_750)], axis, FULL_RANGE, 36_750);
    expect(ex!.low.price).toBe(36_750);
    expect(ex!.low.pct).toBe(0);
  });
});
