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
  it('includes live trades between the fixed auction time and a later structural cutoff in distribution bins', () => {
    const segment = {
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live' as const,
    };

    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 100, 10),
      trade(atKst(15, 25), 120, 50),
      trade(atKst(15, 30), 120, 500),
      trade(atKst(15, 31), 110, 500),
    ], {
      date: '20260624',
      candles: [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      rangeCount: 2,
      segment,
      continuousBeforeMs: atKst(15, 30),
    });

    expectPoc(poc, {
      centerPrice: 115,
      lowPrice: 110,
      highPrice: 120,
      qty: 50,
      t_ms: atKst(15, 25),
    });
  });

  it('keeps the fixed 15:20 gate when no structural cutoff is provided', () => {
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 100, 10),
      trade(atKst(15, 25), 120, 500),
    ]);

    expectPoc(poc, {
      centerPrice: 100,
      lowPrice: 99,
      highPrice: 101,
      qty: 10,
      t_ms: atKst(9, 1),
    });
  });

  it('selects the strongest continuous-trade volume-distribution bin', () => {
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 100, 10),
      trade(atKst(9, 2), 110, 20),
      trade(atKst(9, 3), 120, 30, 0),
    ], {
      date: '20260624',
      candles: [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      rangeCount: 2,
      segment: {
        date: '20260624',
        session_open_ms: atKst(9, 0),
        session_close_ms: atKst(15, 30),
        source: 'kis_live',
      },
    });

    expectPoc(poc, {
      centerPrice: 115,
      lowPrice: 110,
      highPrice: 120,
      qty: 20,
      t_ms: atKst(9, 2),
      date: '20260624',
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

  it('folds a trade at the day high into the last distribution bin', () => {
    const segment = {
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live' as const,
    };
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 100, 10),
      trade(atKst(9, 2), 120, 30),
    ], {
      date: '20260624',
      candles: [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      rangeCount: 2,
      segment,
    });

    expectPoc(poc, {
      centerPrice: 115,
      lowPrice: 110,
      highPrice: 120,
      qty: 30,
      t_ms: atKst(9, 2),
    });
  });

  it('keeps the earlier distribution bin when max-bin quantities tie', () => {
    const segment = {
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live' as const,
    };
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 100, 20),
      trade(atKst(9, 2), 110, 20),
    ], {
      date: '20260624',
      candles: [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      rangeCount: 2,
      segment,
    });

    expectPoc(poc, {
      centerPrice: 105,
      lowPrice: 100,
      highPrice: 110,
      qty: 20,
      t_ms: atKst(9, 1),
    });
  });

  it('handles single-price distribution ranges', () => {
    const segment = {
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live' as const,
    };
    const poc = computeTradeVolumePoc([
      trade(atKst(9, 1), 100, 20),
    ], {
      date: '20260624',
      candles: [{ ts_ms: atKst(9, 1), open: 100, high: 100, low: 100, close: 100, vol_a: 0, vol_b: 0 }],
      rangeCount: 5,
      segment,
    });

    expectPoc(poc, {
      centerPrice: 100,
      lowPrice: 100,
      highPrice: 101,
      qty: 20,
      t_ms: atKst(9, 1),
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
  it('falls back to candle close volume using the volume-distribution max bin', () => {
    const pocs = computeCandleVolumePocs([
      { ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 100, vol_a: 10, vol_b: 0 },
      { ts_ms: atKst(9, 2), open: 110, high: 120, low: 100, close: 110, vol_a: 20, vol_b: 0 },
      { ts_ms: atKst(15, 20), open: 120, high: 120, low: 120, close: 120, vol_a: 1_000, vol_b: 0 },
    ], [{
      date: '20260624',
      session_open_ms: atKst(9, 0),
      session_close_ms: atKst(15, 30),
      source: 'kis_live',
    }], { rangeCount: 2 });

    expect(pocs).toHaveLength(1);
    expect(pocs[0]).toMatchObject({
      date: '20260624',
      centerPrice: 115,
      lowPrice: 110,
      highPrice: 120,
      qty: 20,
      t_ms: atKst(9, 2),
    });
  });
});
