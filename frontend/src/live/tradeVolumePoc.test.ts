import { describe, expect, it } from 'vitest';
import {
  computeCandleVolumePocs,
  computeTradeVolumePoc,
  IncrementalTradeVolumePoc,
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

  it('selects a tick-adjusted price band from many distinct prices at scale', () => {
    // 8천 distinct 가격에서도 정확한 밴드를 고른다. 기존 벽시계 `elapsed < 80ms`는
    // full-suite 워커 경합에 flaky해 제거(issue #434) — 대규모 입력 정확성 단언은 남는다.
    const trades = Array.from({ length: 8_000 }, (_, i) =>
      trade(atKst(9 + Math.floor(i / 3_600), Math.floor((i % 3_600) / 60)), 10_000 + i * 1_000, 1),
    );

    const poc = computeTradeVolumePoc(trades, { bandPct: 0 });

    expectPoc(poc, {
      centerPrice: 10_000,
      lowPrice: 10_000,
      highPrice: 10_000,
      qty: 1,
    });
  });
});

describe('IncrementalTradeVolumePoc', () => {
  const SEGMENT = {
    date: '20260624',
    session_open_ms: atKst(9, 0),
    session_close_ms: atKst(15, 30),
    source: 'kis_live' as const,
  };

  // batch distribution 분기의 오라클 — 증분 결과와 라인 단위로 같아야 한다.
  function batch(
    trades: readonly TradeSnapshot[],
    range: { min: number; max: number },
    rangeCount: number,
    continuousBeforeMs: number | null,
  ): TradeVolumePoc | null {
    return computeTradeVolumePoc(trades, {
      date: SEGMENT.date,
      bandPct: 0.005,
      candles: [{
        ts_ms: atKst(9, 1), open: range.min, high: range.max,
        low: range.min, close: range.min, vol_a: 0, vol_b: 0,
      }],
      rangeCount,
      segment: SEGMENT,
      continuousBeforeMs,
    });
  }

  function incrUpdate(
    acc: IncrementalTradeVolumePoc,
    trades: readonly TradeSnapshot[],
    range: { min: number; max: number },
    rangeCount: number,
    continuousBeforeMs: number | null,
  ): TradeVolumePoc | null {
    return acc.update(trades, {
      date: SEGMENT.date,
      bandPct: 0.005,
      rangeMin: range.min,
      rangeMax: range.max,
      rangeCount,
      sessionOpenMs: SEGMENT.session_open_ms,
      sessionCloseMs: SEGMENT.session_close_ms,
      continuousBeforeMs,
    });
  }

  it('append-only 성장 스트림에서 매 스텝 batch 와 동일', () => {
    // 결정론적 의사난수(9973 소수 모듈러) — 3600개 체결을 한 스냅샷씩 append.
    const range = { min: 10_000, max: 60_000 };
    const rangeCount = 20;
    const snapshots: TradeSnapshot[] = [];
    const acc = new IncrementalTradeVolumePoc();
    let seed = 1;
    for (let i = 0; i < 300; i += 1) {
      seed = (seed * 48_271) % 2_147_483_647;
      const price = 10_000 + (seed % 50_001);
      const qty = 1 + (seed % 7);
      const side = (seed % 5 === 0) ? 0 : (seed % 2 === 0 ? 1 : -1); // 가끔 side=0(제외)
      const tMs = atKst(9, Math.min(359, Math.floor(i / 1)));
      snapshots.push({ t_ms: tMs, trades: [{ t_ms: tMs, price, qty, side }] });
      const incr = incrUpdate(acc, snapshots, range, rangeCount, null);
      const oracle = batch(snapshots, range, rangeCount, null);
      expect(incr).toEqual(oracle);
    }
  });

  it('가격범위 확장 시 전체 재빌드 후 batch 와 동일', () => {
    const acc = new IncrementalTradeVolumePoc();
    const s: TradeSnapshot[] = [
      { t_ms: atKst(9, 1), trades: [{ t_ms: atKst(9, 1), price: 12_000, qty: 10, side: 1 }] },
      { t_ms: atKst(9, 2), trades: [{ t_ms: atKst(9, 2), price: 18_000, qty: 30, side: 1 }] },
    ];
    // 초기 좁은 범위.
    expect(incrUpdate(acc, s, { min: 10_000, max: 20_000 }, 10, null))
      .toEqual(batch(s, { min: 10_000, max: 20_000 }, 10, null));
    // 범위 확장(재빌드 트리거) — 같은 trades, 넓은 범위.
    expect(incrUpdate(acc, s, { min: 10_000, max: 40_000 }, 10, null))
      .toEqual(batch(s, { min: 10_000, max: 40_000 }, 10, null));
  });

  it('continuousBeforeMs 등장(null→값) 시 재빌드 후 batch 와 동일', () => {
    const acc = new IncrementalTradeVolumePoc();
    const s: TradeSnapshot[] = [
      { t_ms: atKst(9, 1), trades: [{ t_ms: atKst(9, 1), price: 11_000, qty: 10, side: 1 }] },
      { t_ms: atKst(15, 25), trades: [{ t_ms: atKst(15, 25), price: 19_000, qty: 50, side: 1 }] },
    ];
    const range = { min: 10_000, max: 20_000 };
    expect(incrUpdate(acc, s, range, 10, null)).toEqual(batch(s, range, 10, null));
    const cutoff = atKst(15, 0);
    expect(incrUpdate(acc, s, range, 10, cutoff)).toEqual(batch(s, range, 10, cutoff));
  });

  it('비-append(종목 전환 = 배열 교체) 시 재빌드', () => {
    const acc = new IncrementalTradeVolumePoc();
    const range = { min: 10_000, max: 20_000 };
    const a: TradeSnapshot[] = [
      { t_ms: atKst(9, 1), trades: [{ t_ms: atKst(9, 1), price: 12_000, qty: 100, side: 1 }] },
    ];
    incrUpdate(acc, a, range, 10, null);
    // 완전히 다른 배열(참조 불일치) → prefix-guard 실패 → 전체 재빌드.
    const b: TradeSnapshot[] = [
      { t_ms: atKst(9, 2), trades: [{ t_ms: atKst(9, 2), price: 18_000, qty: 5, side: 1 }] },
    ];
    expect(incrUpdate(acc, b, range, 10, null)).toEqual(batch(b, range, 10, null));
  });

  it('같은 trades 로 두 번 update = 델타 0, 결과 불변(React 이중 호출 안전)', () => {
    const acc = new IncrementalTradeVolumePoc();
    const range = { min: 10_000, max: 20_000 };
    const s: TradeSnapshot[] = [
      { t_ms: atKst(9, 1), trades: [{ t_ms: atKst(9, 1), price: 12_000, qty: 100, side: 1 }] },
    ];
    const first = incrUpdate(acc, s, range, 10, null);
    const second = incrUpdate(acc, s, range, 10, null);
    expect(second).toEqual(first);
    expect(second).toEqual(batch(s, range, 10, null));
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
