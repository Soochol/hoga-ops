import { describe, expect, it } from 'vitest';
import {
  computeCandleVolumePocs,
  computeTradeVolumePoc,
  krxStockTickSize,
  type TradeVolumePoc,
} from './tradeVolumePoc';
import type { TradeSnapshot } from './bucketHogaSeries';

const KST = 9 * 60 * 60 * 1000;

function atKst(h: number, m: number): number {
  return Date.UTC(2026, 5, 24, h, m) - KST;
}

function trade(t_ms: number, price: number, qty: number, side = 1): TradeSnapshot {
  return { t_ms, trades: [{ t_ms, price, qty, side }] };
}

function expectPoc(poc: TradeVolumePoc | null, expected: Partial<TradeVolumePoc>) {
  expect(poc).not.toBeNull();
  expect(poc).toMatchObject(expected);
}

describe('krxStockTickSize', () => {
  it('uses the KRX stock tick table around common boundaries', () => {
    expect(krxStockTickSize(1_999)).toBe(1);
    expect(krxStockTickSize(2_000)).toBe(5);
    expect(krxStockTickSize(20_000)).toBe(50);
    expect(krxStockTickSize(50_000)).toBe(100);
    expect(krxStockTickSize(500_000)).toBe(1_000);
  });
});

describe('computeTradeVolumePoc', () => {
  it('defaults to the strongest +/-0.5% tick-adjusted regular-session price band', () => {
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 71_500, 20),
      trade(atKst(9, 2), 72_300, 50),
      trade(atKst(9, 3), 73_100, 30),
      trade(atKst(9, 4), 76_000, 99),
    ]);

    expectPoc(poc, {
      centerPrice: 76_000,
      lowPrice: 75_600,
      highPrice: 76_400,
      qty: 99,
      t_ms: atKst(9, 4),
      date: '',
    });
  });

  it('can select the strongest +/-1% tick-adjusted regular-session price band', () => {
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 71_500, 20),
      trade(atKst(9, 2), 72_300, 50),
      trade(atKst(9, 3), 73_100, 30),
      trade(atKst(9, 4), 76_000, 99),
    ], { bandPct: 0.01 });

    expectPoc(poc, {
      centerPrice: 72_300,
      lowPrice: 71_500,
      highPrice: 73_100,
      qty: 100,
      t_ms: atKst(9, 2),
      date: '',
    });
  });

  it('excludes pre-open, closing-auction, neutral, and auction-side events', () => {
    const poc = computeTradeVolumePoc([
      trade(atKst(8, 59), 70_000, 1_000),
      trade(atKst(9, 1), 72_000, 10),
      trade(atKst(15, 19), 72_100, 20, 0),
      trade(atKst(15, 20), 70_000, 1_000),
      trade(atKst(10, 0), 70_000, 1_000, 2),
    ]);

    expectPoc(poc, {
      centerPrice: 72_000,
      lowPrice: 71_600,
      highPrice: 72_400,
      qty: 10,
    });
  });

  it('keeps the earlier center when two bands have the same accumulated volume', () => {
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 10_000, 10),
      trade(atKst(9, 2), 10_040, 10),
      trade(atKst(9, 3), 20_000, 20),
    ]);

    expectPoc(poc, {
      centerPrice: 10_000,
      qty: 20,
    });
  });
});

describe('computeCandleVolumePocs', () => {
  it('falls back to candle close volume when exact trade prices are unavailable', () => {
    const pocs = computeCandleVolumePocs([
      { ts_ms: atKst(9, 1), open: 71_500, high: 72_000, low: 71_000, close: 71_500, vol_a: 20, vol_b: 0 },
      { ts_ms: atKst(9, 2), open: 72_000, high: 72_500, low: 71_500, close: 72_300, vol_a: 50, vol_b: 0 },
      { ts_ms: atKst(9, 3), open: 72_500, high: 73_200, low: 72_000, close: 73_100, vol_a: 30, vol_b: 0 },
      { ts_ms: atKst(15, 20), open: 80_000, high: 80_000, low: 80_000, close: 80_000, vol_a: 1_000, vol_b: 0 },
    ], [{
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live',
    }]);

    expect(pocs).toHaveLength(1);
    expect(pocs[0]).toMatchObject({
      date: '20260624',
      centerPrice: 72_300,
      lowPrice: 71_900,
      highPrice: 72_700,
      qty: 50,
      t_ms: atKst(9, 2),
      bandPct: 0.005,
    });
  });
});
