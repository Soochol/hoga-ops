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

// 기준가 = "보이는 범위에서 가장 우측(최근) 캔들의 종가"라 close를 명시로 받는다.
function candle(tsMs: number, high: number, low: number, close: number): Candle {
  return { ts_ms: tsMs, open: close, close, high, low, vol_a: 0, vol_b: 0 };
}

describe('computeVisibleExtremes', () => {
  it('uses the RIGHTMOST visible candle close as the 극값 대비율 basis', () => {
    const tHigh = OPEN + 120_000; // 09:02
    const tLast = OPEN + 180_000; // 09:03 — rightmost visible → basis = its close (37,100)
    const candles = [
      candle(OPEN + 60_000, 37_000, 36_900, 36_950),
      candle(tHigh, 38_800, 38_000, 38_200),
      candle(tLast, 37_500, 36_750, 37_100),
    ];

    const ex = computeVisibleExtremes(candles, axis, FULL_RANGE);

    expect(ex).not.toBeNull();
    expect(ex!.high.price).toBe(38_800);
    expect(ex!.high.tsMs).toBe(tHigh);
    expect(ex!.high.virtualSec).toBe(tHigh / 1000);
    expect(ex!.high.pct).toBeCloseTo(-4.38, 2); // (37100-38800)/38800*100
    expect(ex!.low.price).toBe(36_750);
    expect(ex!.low.tsMs).toBe(tLast);
    expect(ex!.low.pct).toBeCloseTo(0.95, 2); // (37100-36750)/36750*100
  });

  it('recomputes the basis as the visible range shifts (pan) — same extreme, different %', () => {
    // 고가 40,000봉은 두 범위 모두에 보이지만, 우측 끝 캔들(=기준 종가)이 달라 % 가 달라진다.
    const candles = [
      candle(OPEN + 60_000, 40_000, 38_000, 38_500), // the HIGH (40,000), visible in both
      candle(OPEN + 120_000, 39_000, 38_000, 38_800), // rightmost when panned left
      candle(OPEN + 180_000, 39_500, 38_000, 39_200), // rightmost at live edge
    ];

    const liveEdge = computeVisibleExtremes(candles, axis, FULL_RANGE);
    // basis = 39,200 (rightmost = OPEN+180_000) → (39200-40000)/40000*100
    expect(liveEdge!.high.price).toBe(40_000);
    expect(liveEdge!.high.pct).toBeCloseTo(-2.0, 2);

    const pannedLeft = computeVisibleExtremes(candles, axis, {
      from: OPEN / 1000,
      to: (OPEN + 120_000) / 1000, // hides the 180_000 candle
    });
    // basis = 38,800 (rightmost now = OPEN+120_000) → (38800-40000)/40000*100
    expect(pannedLeft!.high.price).toBe(40_000);
    expect(pannedLeft!.high.pct).toBeCloseTo(-3.0, 2);
  });

  it('ignores candles outside the visible range (basis = rightmost VISIBLE candle)', () => {
    const candles = [
      candle(OPEN + 60_000, 37_000, 36_900, 36_950),
      candle(OPEN + 120_000, 38_000, 37_000, 37_500), // rightmost visible → basis 37,500
      candle(OPEN + 200_000, 50_000, 30_000, 40_000), // beyond `to` → excluded entirely
    ];
    const range = { from: OPEN / 1000, to: (OPEN + 150_000) / 1000 };

    const ex = computeVisibleExtremes(candles, axis, range);

    expect(ex!.high.price).toBe(38_000);
    expect(ex!.low.price).toBe(36_900);
    expect(ex!.high.pct).toBeCloseTo(((37_500 - 38_000) / 38_000) * 100, 2);
  });

  it('ignores candles not drawn on the axis (axis.contains false)', () => {
    const candles = [
      candle(OPEN - 60_000, 99_999, 1, 50_000), // pre-open (08:59) → not contained
      candle(OPEN + 120_000, 38_000, 37_000, 37_500),
    ];
    const range = { from: (OPEN - 60_000) / 1000, to: CLOSE / 1000 };

    const ex = computeVisibleExtremes(candles, axis, range);

    expect(ex!.high.price).toBe(38_000);
    expect(ex!.low.price).toBe(37_000);
  });

  it('keeps the first occurrence on a tie (stability under scroll)', () => {
    const tFirst = OPEN + 60_000;
    const tSecond = OPEN + 120_000;
    const candles = [
      candle(tFirst, 38_800, 36_000, 37_000),
      candle(tSecond, 38_800, 37_000, 37_100),
    ];

    const ex = computeVisibleExtremes(candles, axis, FULL_RANGE);

    expect(ex!.high.tsMs).toBe(tFirst);
  });

  it('returns null on null range / empty candles', () => {
    const candles = [candle(OPEN + 60_000, 38_000, 37_000, 37_500)];
    expect(computeVisibleExtremes(candles, axis, null)).toBeNull();
    expect(computeVisibleExtremes([], axis, FULL_RANGE)).toBeNull();
  });

  it('returns null when no candle falls in the visible range', () => {
    const candles = [
      candle(OPEN + 60_000, 38_000, 37_000, 37_500),
      candle(OPEN + 120_000, 38_500, 37_500, 38_000),
    ];
    const range = { from: (CLOSE - 10_000) / 1000, to: CLOSE / 1000 }; // after all candles

    expect(computeVisibleExtremes(candles, axis, range)).toBeNull();
  });

  it('yields pct 0 when the rightmost-visible close equals an extreme', () => {
    // 단일 캔들: 기준가 = 그 캔들 close(36,750) = 저가 → 저점대비 0%.
    const ex = computeVisibleExtremes([candle(OPEN + 60_000, 38_800, 36_750, 36_750)], axis, FULL_RANGE);
    expect(ex!.low.price).toBe(36_750);
    expect(ex!.low.pct).toBe(0);
  });
});
