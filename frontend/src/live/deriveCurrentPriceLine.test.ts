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

  it('KRX venue blocks an NXT-tagged trade (mirrors overlay gate, #523)', () => {
    const trades = [tradeSnap(70500, NOW - 1000, { venue: 'NXT' })];
    expect(freshLiveTradePrice(trades, 'KRX', NOW)).toBeNull();
  });

  it('NXT venue accepts an NXT-tagged trade — 정규장 시각에도 (ADR-0140 §5)', () => {
    // 예전 UN 규칙에선 시각이 판정에 들어가 10:00 의 NXT 태그가 거절됐다. NXT 는
    // 정규장에도 열려 있으므로 이제 현재가 라인이 그 체결을 따라간다.
    const sessionMs = Date.UTC(2026, 4, 18, 1, 0, 0);   // KST 10:00 정규장
    const afterHoursMs = Date.UTC(2026, 4, 18, 8, 0, 0); // KST 17:00 애프터마켓
    for (const at of [sessionMs, afterHoursMs]) {
      expect(freshLiveTradePrice([tradeSnap(70500, at, { venue: 'NXT' })], 'NXT', at + 1000))
        .toBe(70500);
    }
  });

  it('UN venue takes only UN-tagged trades — KRX·NXT 합집합이 아니다', () => {
    const at = Date.UTC(2026, 4, 18, 1, 0, 0); // KST 10:00
    expect(freshLiveTradePrice([tradeSnap(70500, at, { venue: 'UN' })], 'UN', at + 1000))
      .toBe(70500);
    // `_AL` 이 이미 병합본이라, KRX·NXT 를 함께 받으면 같은 체결이 중복 반영된다.
    expect(freshLiveTradePrice([tradeSnap(70500, at, { venue: 'KRX' })], 'UN', at + 1000))
      .toBeNull();
    expect(freshLiveTradePrice([tradeSnap(70500, at, { venue: 'NXT' })], 'UN', at + 1000))
      .toBeNull();
  });

  it('untagged 구백엔드 프레임은 KRX 로 승격된다 — 시각 무관', () => {
    const afterHoursMs = Date.UTC(2026, 4, 18, 8, 0, 0); // KST 17:00
    expect(freshLiveTradePrice([tradeSnap(70500, afterHoursMs)], 'KRX', afterHoursMs + 1000))
      .toBe(70500);
    expect(freshLiveTradePrice([tradeSnap(70500, afterHoursMs)], 'UN', afterHoursMs + 1000))
      .toBeNull();
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
