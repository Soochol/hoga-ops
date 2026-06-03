import { describe, it, expect } from 'vitest';
import { bucketHogaSeries } from './bucketHogaSeries';
import type { OrderbookLevel } from '../api/types';

// 10-level continuous book (deep levels populated).
const contLvls = (qty: number): OrderbookLevel[] =>
  Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty }));
// 3-level auction book (levels 1-3 only; 4-10 zero).
const aucLvls = (qty: number): OrderbookLevel[] =>
  Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: i < 3 ? qty : 0 }));
const cont = (t: number, a: number, b: number) => ({
  t_ms: t, total_ask_qty: a, total_bid_qty: b, asks: contLvls(a), bids: contLvls(b),
});
const auc = (t: number, a: number, b: number) => ({
  t_ms: t, total_ask_qty: a, total_bid_qty: b, asks: aucLvls(a), bids: aucLvls(b),
});

describe('bucketHogaSeries', () => {
  it('returns empty arrays for empty input', () => {
    const out = bucketHogaSeries([], [], 60_000);
    expect(out.quoteRatioPoints).toEqual([]);
    expect(out.fillStrengthPoints).toEqual([]);
  });

  it('Quote Totals uses last ob snapshot in each bucket', () => {
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_010_000, total_ask_qty: 200, total_bid_qty: 90 },
      { t_ms: 1700_000_070_000, total_ask_qty: 300, total_bid_qty: 95 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_070_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90 },
      { t: b1, ask_total: 300, bid_total: 95 },
    ]);
  });

  it('FillStrength sums buy/sell qty by side in each bucket', () => {
    const trade = [
      {
        t_ms: 1700_000_000_000,
        trades: [
          { side: 1, qty: 10 },
          { side: -1, qty: 4 },
          { side: 0, qty: 99 },
          { side: 2, qty: 50 },
        ],
      },
      {
        t_ms: 1700_000_010_000,
        trades: [{ side: 1, qty: 5 }],
      },
      {
        t_ms: 1700_000_070_000,
        trades: [{ side: -1, qty: 7 }],
      },
    ];
    const { fillStrengthPoints } = bucketHogaSeries([], trade, 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_070_000 / 60_000) * 60_000;
    expect(fillStrengthPoints).toEqual([
      { t: b0, buy_qty: 15, sell_qty: 4 },
      { t: b1, buy_qty: 0, sell_qty: 7 },
    ]);
  });

  it('omits empty buckets (no zero-padding)', () => {
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_300_000, total_ask_qty: 200, total_bid_qty: 90 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    expect(quoteRatioPoints.length).toBe(2);
    expect(quoteRatioPoints[1].t - quoteRatioPoints[0].t).toBe(300_000);
  });

  it('out-of-order input is sorted before bucketing', () => {
    const ob = [
      { t_ms: 1700_000_070_000, total_ask_qty: 300, total_bid_qty: 95 },
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 80 },
      { t_ms: 1700_000_010_000, total_ask_qty: 200, total_bid_qty: 90 },
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    const b1 = Math.floor(1700_000_070_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 200, bid_total: 90 },
      { t: b1, ask_total: 300, bid_total: 95 },
    ]);
  });

  it('de-contaminates a straddle bucket via structure (last continuous wins)', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base, 21, 11),
      cont(base + 60_000, 22, 12),      // last continuous → 정화값
      auc(base + 150_000, 98, 99),      // auction (3-level) → 제외
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 22, bid_total: 12 }]);
  });

  it('falls back to last snapshot for a fully-auction bucket', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base + 60_000, 50, 60),      // continuous → defines lastContinuous
      auc(base + 180_000, 41, 31),      // [base+3m,..) auction
      auc(base + 240_000, 42, 32),      // 마지막 auction → fallback
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 50, bid_total: 60 },
      { t: base + 180_000, ask_total: 42, bid_total: 32 },
    ]);
  });

  it('a post-close continuous book does not extend the boundary (close bound)', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 70_000;          // close inside the bucket
    const ob = [
      cont(base, 11, 21),                          // continuous <= close → threshold
      auc(base + 60_000, 98, 99),                  // auction (3-level) → 대표 못 됨 (seenPre already set)
      cont(base + 90_000, 77, 88),                 // post-close continuous (> close)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    // bucket represented by the base continuous, NOT the 60_000 auction.
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 11, bid_total: 21 }]);
  });

  it('treats totals-only snapshots (no asks/bids) as continuous → legacy last-in-bucket', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const ob = [
      { t_ms: base, total_ask_qty: 21, total_bid_qty: 11 },
      { t_ms: base + 60_000, total_ask_qty: 22, total_bid_qty: 12 },
      { t_ms: base + 150_000, total_ask_qty: 98, total_bid_qty: 99 },
    ];
    // No asks/bids + default sessionCloseMs(+Infinity) → all continuous →
    // lastContinuous = last t_ms → legacy last-in-bucket.
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 98, bid_total: 99 }]);
  });

  it('asks/bids-absent guard keeps totals-only continuous under a close bound', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    // Two totals-only snapshots in the SAME bucket; close falls between them.
    const ob = [
      { t_ms: base, total_ask_qty: 11, total_bid_qty: 21 },
      { t_ms: base + 60_000, total_ask_qty: 98, total_bid_qty: 99 },
    ];
    const sessionCloseMs = base + 30_000;
    // With the guard, both are "continuous"; the 2nd is > close so the threshold
    // is the 1st (base) → the 2nd is auction → seenPre skips it → representative is
    // the 1st. WITHOUT the guard, no snapshot is continuous → lastContinuous=+Infinity
    // → the 2nd would win. So this asserts the guard's effect.
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 11, bid_total: 21 }]);
  });

  it('detects the auction from a live-shaped ob payload (asks/bids passthrough contract)', () => {
    // Pins the live SSE ob payload shape that LiveSnapshotBuffer delivers as sseOb
    // (poller from_orderbook → model_dump → buffer passthrough): extra kind/phase/
    // code fields ride along, and asks/bids carry {price, qty} levels. Guards
    // against a payload-shape refactor silently renaming asks/bids and disabling
    // the structural cutoff (spec Risk: "라이브 페이로드에 asks/bids 존재를 테스트로 확인").
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const liveOb = (t: number, a: number, b: number, isAuction: boolean) => ({
      t_ms: t, kind: 'ob', phase: 'regular', code: '005930',
      total_ask_qty: a, total_bid_qty: b,
      asks: (isAuction ? aucLvls : contLvls)(a),
      bids: (isAuction ? aucLvls : contLvls)(b),
    });
    const ob = [
      liveOb(base, 21, 11, false),           // continuous
      liveOb(base + 60_000, 22, 12, false),  // last continuous → 정화값
      liveOb(base + 150_000, 98, 99, true),  // auction (3-level) → excluded
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([{ t: base, ask_total: 22, bid_total: 12 }]);
  });
});
