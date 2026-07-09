import { describe, it, expect } from 'vitest';
import {
  deriveCurrentPriceLine,
  freshLiveTradePrice,
  resolveLiveCurrentPrice,
  TRADE_PRICE_FRESH_MS,
} from './deriveCurrentPriceLine';
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';
import type { TradeSnapshot } from './bucketHogaSeries';

const COLORS = { up: 'UP', down: 'DOWN', neutral: 'NEUTRAL' };

function bundleWith(closes: number[]): RangeBundle {
  return {
    candles: closes.map((c, i) => ({
      ts_ms: i * 1000, open: c, close: c, high: c, low: c, vol_a: 0, vol_b: 0,
    })),
  } as RangeBundle;
}

function quote(over: Partial<LiveQuote>): LiveQuote {
  return { code: '005930', price: 0, change_pct: null, change_won: null, ...over };
}

/** 한 체결 이벤트를 담은 스냅샷. t_ms 는 스냅샷·이벤트 양쪽에 둔다. */
function tradeSnap(price: number, tMs: number, over: Partial<TradeSnapshot> = {}): TradeSnapshot {
  return { t_ms: tMs, trades: [{ t_ms: tMs, price, side: 1, qty: 10 }], ...over };
}

describe('deriveCurrentPriceLine', () => {
  it('returns null when there are no candles', () => {
    expect(deriveCurrentPriceLine(bundleWith([]), undefined, COLORS)).toBeNull();
  });

  it('falls back to the last candle close when no trade/usable-quote price', () => {
    const m = deriveCurrentPriceLine(
      bundleWith([100, 200, 70000]),
      quote({ change_won: 0, change_pct: 0 }), // price:0 → quote 폴백 불가
      COLORS,
    );
    expect(m).toEqual({ price: 70000, color: 'NEUTRAL' });
  });

  it('prefers liveTradePrice over quote.price and candle close', () => {
    const m = deriveCurrentPriceLine(
      bundleWith([70000]),
      quote({ price: 70500, change_won: 500, change_pct: 0.7 }),
      COLORS,
      70800,
    );
    expect(m).toEqual({ price: 70800, color: 'UP' });
  });

  it('uses usable quote.price when liveTradePrice is null', () => {
    const m = deriveCurrentPriceLine(
      bundleWith([70000]),
      quote({ price: 70500, change_won: 500, change_pct: 0.7 }),
      COLORS,
      null,
    );
    expect(m?.price).toBe(70500);
  });

  it('ignores a stale quote.price (falls back to candle close)', () => {
    const m = deriveCurrentPriceLine(
      bundleWith([70000]),
      quote({ price: 99999, stale: true, change_won: 100, change_pct: 0.1 }),
      COLORS,
    );
    expect(m?.price).toBe(70000);
  });

  it('returns null when candles empty even if a quote/trade price exists', () => {
    expect(
      deriveCurrentPriceLine(bundleWith([]), quote({ price: 70500 }), COLORS, 70800),
    ).toBeNull();
  });

  it('colors up when change_won is positive', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: 500, change_pct: 0.7 }), COLORS);
    expect(m?.color).toBe('UP');
  });

  it('colors down when change_won is negative', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: -300, change_pct: -0.4 }), COLORS);
    expect(m?.color).toBe('DOWN');
  });

  it('falls back to change_pct sign when change_won is null (OPEN-phase quote)', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: 1.2 }), COLORS);
    expect(m?.color).toBe('UP');
  });

  it('falls back to change_pct sign when change_won is null and pct is negative', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: -0.9 }), COLORS);
    expect(m?.color).toBe('DOWN');
  });

  it('is neutral when both change fields are null (pre-open)', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: null }), COLORS);
    expect(m?.color).toBe('NEUTRAL');
  });

  it('is neutral when quote is undefined', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), undefined, COLORS);
    expect(m?.color).toBe('NEUTRAL');
  });
});

describe('freshLiveTradePrice', () => {
  const NOW = 1_700_000_000_000;

  it('returns the last valid trade price within TTL', () => {
    const trades = [tradeSnap(70000, NOW - 5000), tradeSnap(70500, NOW - 1000)];
    expect(freshLiveTradePrice(trades, 'KRX', NOW)).toBe(70500);
  });

  it('returns null when the last trade is older than TTL', () => {
    const trades = [tradeSnap(70500, NOW - TRADE_PRICE_FRESH_MS - 1)];
    expect(freshLiveTradePrice(trades, 'KRX', NOW)).toBeNull();
  });

  it('returns null for a non-KRX venue (mirrors overlay gate)', () => {
    const trades = [tradeSnap(70500, NOW - 1000)];
    expect(freshLiveTradePrice(trades, 'NXT', NOW)).toBeNull();
  });

  it('UN hybrid (ADR-0096): KRX trade within the regular session is fresh', () => {
    const sessionMs = Date.UTC(2026, 4, 18, 1, 0, 0); // KST 2026-05-18(월) 10:00 — 정규장
    const trades = [tradeSnap(70500, sessionMs)];
    expect(freshLiveTradePrice(trades, 'UN', sessionMs + 1000)).toBe(70500);
  });

  it('UN hybrid: NXT-hours KRX trade stays blocked (통합 REST가 정본)', () => {
    const afterHoursMs = Date.UTC(2026, 4, 18, 8, 0, 0); // KST 17:00 — NXT 전용 시간대
    const trades = [tradeSnap(70500, afterHoursMs)];
    expect(freshLiveTradePrice(trades, 'UN', afterHoursMs + 1000)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(freshLiveTradePrice([], 'KRX', NOW)).toBeNull();
  });

  it('skips invalid events (qty<=0, price<=0) and uses the last valid one', () => {
    const trades: TradeSnapshot[] = [
      { t_ms: NOW - 1000, trades: [
        { t_ms: NOW - 1200, price: 70000, side: 1, qty: 10 },
        { t_ms: NOW - 1100, price: 0, side: 1, qty: 10 },      // price<=0 → skip
        { t_ms: NOW - 1000, price: 70500, side: 1, qty: 0 },   // qty<=0 → skip
      ] },
    ];
    expect(freshLiveTradePrice(trades, 'KRX', NOW)).toBe(70000);
  });

  it('falls back to snapshot.t_ms when the event t_ms is missing', () => {
    const trades: TradeSnapshot[] = [
      { t_ms: NOW - 500, trades: [{ price: 70500, side: 1, qty: 10 }] },
    ];
    expect(freshLiveTradePrice(trades, 'KRX', NOW)).toBe(70500);
  });
});

describe('resolveLiveCurrentPrice', () => {
  it('returns null when lastClose is null (no candles)', () => {
    expect(resolveLiveCurrentPrice(null, quote({ price: 70500 }), 70800)).toBeNull();
  });

  it('prefers liveTradePrice', () => {
    expect(resolveLiveCurrentPrice(70000, quote({ price: 70500 }), 70800)).toBe(70800);
  });

  it('uses usable quote.price when trade price is null', () => {
    expect(resolveLiveCurrentPrice(70000, quote({ price: 70500 }), null)).toBe(70500);
  });

  it('ignores stale / zero / non-finite quote.price', () => {
    expect(resolveLiveCurrentPrice(70000, quote({ price: 70500, stale: true }), null)).toBe(70000);
    expect(resolveLiveCurrentPrice(70000, quote({ price: 0 }), null)).toBe(70000);
    expect(resolveLiveCurrentPrice(70000, quote({ price: Number.NaN }), null)).toBe(70000);
  });

  it('falls back to lastClose when neither trade nor usable quote', () => {
    expect(resolveLiveCurrentPrice(70000, undefined, null)).toBe(70000);
  });
});
