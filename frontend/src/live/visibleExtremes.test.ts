import { describe, it, expect } from 'vitest';
import { computeVisibleExtremes, computePriorDaysExtremes } from './visibleExtremes';
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
    expect(ex!.high.virtualSec).toBe(tHigh / 1000);
    expect(ex!.high.pct).toBeCloseTo(-4.38, 2); // (37100-38800)/38800*100
    expect(ex!.low.price).toBe(36_750);
    expect(ex!.low.virtualSec).toBe(tLast / 1000);
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

    expect(ex!.high.virtualSec).toBe(tFirst / 1000);
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

// ── computePriorDaysExtremes ────────────────────────────────────────────────
// 3거래일 픽스처를 **일부러 길게** 잡고 범위로 잘라서 잰다. 하루짜리 픽스처였다면
// "마지막 날을 뺀다" 는 축 자체가 테스트에서 사라진다(항상 null 이거나 항상 전체).
// 세 날의 고저를 전부 다르게 준 것도 같은 이유 — 어느 날이 섞였는지 값이 말해 준다.
const D0 = Date.UTC(2026, 5, 10, 0, 0, 0); // 06-10 09:00 KST
const D1 = Date.UTC(2026, 5, 11, 0, 0, 0); // 06-11
const D2 = Date.UTC(2026, 5, 12, 0, 0, 0); // 06-12 (마지막 날)
const SESSION_MS = 6.5 * 3_600_000;
const multiAxis: VirtualAxis = createVirtualAxis(
  [
    { date: '20260610', sessionOpenMs: D0, sessionCloseMs: D0 + SESSION_MS },
    { date: '20260611', sessionOpenMs: D1, sessionCloseMs: D1 + SESSION_MS },
    { date: '20260612', sessionOpenMs: D2, sessionCloseMs: D2 + SESSION_MS },
  ],
  D0,
);
// D0: 고 100 / 저 90 · D1: 고 120 / 저 80 · D2: 고 150 / 저 70
const MULTI_CANDLES = [
  candle(D0 + 60_000, 100, 95, 98),
  candle(D0 + 120_000, 99, 90, 92),
  candle(D1 + 60_000, 120, 110, 115),
  candle(D1 + 120_000, 118, 80, 85),
  candle(D2 + 60_000, 150, 140, 145),
  candle(D2 + 120_000, 148, 70, 75),
];
/** 두 실 ms 사이를 덮는 가시 범위(가상초) — 축이 간극을 접으므로 손으로 못 적는다. */
const vRange = (fromMs: number, toMs: number) => ({
  from: multiAxis.toVirtual(fromMs) / 1000,
  to: multiAxis.toVirtual(toMs) / 1000,
});

describe('computePriorDaysExtremes', () => {
  it('마지막 날(D2)을 통째로 빼고 이전 날 **전부**(D0+D1)에서 고저를 찾는다', () => {
    const ex = computePriorDaysExtremes(MULTI_CANDLES, multiAxis, vRange(D0, D2 + SESSION_MS));

    // D2 의 고 150 / 저 70 이 아니라 D0∪D1 의 고 120 / 저 80.
    expect(ex).toEqual({ high: 120, low: 80 });
  });

  it('우측 끝 날이 D1 로 바뀌면 컷오프도 따라 옮겨 간다 (뷰포트 의존)', () => {
    // 같은 캔들 배열, 범위만 D0~D1 로 좁힌다 → 이제 제외 대상은 D1, 남는 것은 D0.
    const ex = computePriorDaysExtremes(MULTI_CANDLES, multiAxis, vRange(D0, D1 + SESSION_MS));

    expect(ex).toEqual({ high: 100, low: 90 });
  });

  it('하루만 보이면 null — 그릴 이전 구간이 없다', () => {
    const ex = computePriorDaysExtremes(MULTI_CANDLES, multiAxis, vRange(D2, D2 + SESSION_MS));

    expect(ex).toBeNull();
  });

  it('마지막 날의 일부만 보여도 그 날 전체가 빠진다 (컷오프 = 개장 시각)', () => {
    // 범위 시작이 D2 장중이어도 D2 는 통째로 제외 대상이다. 남는 것은 D0∪D1.
    const ex = computePriorDaysExtremes(MULTI_CANDLES, multiAxis, vRange(D0, D2 + 90_000));

    expect(ex).toEqual({ high: 120, low: 80 });
  });

  it('보이는 범위가 비면 null', () => {
    expect(computePriorDaysExtremes(MULTI_CANDLES, multiAxis, null)).toBeNull();
    expect(computePriorDaysExtremes([], multiAxis, vRange(D0, D2))).toBeNull();
  });
});
