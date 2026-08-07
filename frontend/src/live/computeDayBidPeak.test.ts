import { describe, expect, it } from 'vitest';
import { foldBidPeak, type RatchetState } from './computeDayBidPeak';
import type { ObSnapshot } from './bucketHogaSeries';

const t = (h: number, m = 0) => Date.UTC(2026, 5, 13, h - 9, m); // KST -> unix ms
// 개장 하한(09:00 KST) — 종전엔 술어 안에 박혀 있던 값이라 테스트가 넘길 필요가
// 없었다. 지금은 필수 인자다: venue 별 확장 세션(NXT 08:00)을 표현하려면 값이
// 밖에서 와야 하기 때문. 여기서 09:00 을 넘기는 것은 **기존 동작 그대로**라는 뜻이다.
const OPEN_MS = t(9);

function deepOb(t_ms: number, bids: Array<[number, number]>): ObSnapshot {
  return {
    t_ms,
    total_ask_qty: 0,
    total_bid_qty: 0,
    asks: Array.from({ length: 10 }, (_, i) => ({ price: 25000 + i, qty: 100 })),
    bids: bids.map(([price, qty]) => ({ price, qty })),
  };
}

const noBids = (t_ms: number): ObSnapshot => ({ t_ms, total_ask_qty: 0, total_bid_qty: 0 });

const FRESH: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };

describe('foldBidPeak', () => {
  it('excludes deep pre-open books until regular trading begins', () => {
    const preOpen = deepOb(
      t(8, 55),
      [[24000, 99999], ...Array(9).fill([1, 1])] as Array<[number, number]>,
    );
    const s = foldBidPeak(FRESH, null, preOpen, OPEN_MS);
    expect(s.peak).toBeNull();

    const s2 = foldBidPeak(
      s,
      null,
      deepOb(t(9, 10), [[23900, 300], ...Array(9).fill([1, 1])] as Array<[number, number]>), OPEN_MS);
    expect(s2.peak).toEqual({ price: 23900, qty: 300, t_ms: t(9, 10) });
  });

  it('resets at trading-day boundary and reapplies the current seed', () => {
    const seed = { price: 23900, qty: 5000, t_ms: t(9) };
    let s: RatchetState = {
      peak: { price: 23800, qty: 99999, t_ms: t(9) - 86_400_000 },
      tradingDay: 0,
      lastTMs: t(9) - 86_400_000,
    };

    s = foldBidPeak(s, seed, noBids(t(9, 1)), OPEN_MS);
    expect(s.peak).toEqual(seed);
  });
});
