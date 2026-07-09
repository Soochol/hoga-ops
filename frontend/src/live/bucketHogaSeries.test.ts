import { describe, it, expect } from 'vitest';
import { bucketHogaSeries } from './bucketHogaSeries';
import { quoteImbalance } from '../util/imbalance';
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
      // b0: max over (a100,b80),(a200,b90) → bid_max90/ask_max200; |imb(90,200)|>|imb(80,90)| → imb_max=(90,200).
      { t: b0, ask_total: 200, bid_total: 90, bid_max: 90, ask_max: 200, imb_max_bid: 90, imb_max_ask: 200 },
      { t: b1, ask_total: 300, bid_total: 95, bid_max: 95, ask_max: 300, imb_max_bid: 95, imb_max_ask: 300 },
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

  it('quote-totals Intra-Bar Max takes each side independently (Q5)', () => {
    // One bucket; bid peaks at t1 (snapshot A), ask peaks at t2 (snapshot B) — different snapshots.
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 100, total_bid_qty: 900 }, // bid peak here
      { t_ms: 1700_000_030_000, total_ask_qty: 800, total_bid_qty: 200 }, // ask peak here (close)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      // close = last snapshot (a800,b200); bid_max=900 (from A), ask_max=800 (from B) — independent times.
      { t: b0, ask_total: 800, bid_total: 200, bid_max: 900, ask_max: 800, imb_max_bid: 900, imb_max_ask: 100 },
    ]);
  });

  it('호가비 Intra-Bar Max keeps the max-|imbalance| snapshot — sign can flip vs side-max', () => {
    // Spec example: A(bid100,ask2) → quoteImbalance=−49 (buy-heavy); B(bid10,ask300) → +29 (sell-heavy).
    // |imb(A)|=48 > |imb(B)|=29 → imb_max=(bid100,ask2). NOT max-of-each-side (bid100,ask300 → +2).
    const ob = [
      { t_ms: 1700_000_000_000, total_ask_qty: 2, total_bid_qty: 100 },   // A: strong buy-heavy
      { t_ms: 1700_000_030_000, total_ask_qty: 300, total_bid_qty: 10 },  // B: sell-heavy (close)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], 60_000);
    const b0 = Math.floor(1700_000_000_000 / 60_000) * 60_000;
    expect(quoteRatioPoints).toEqual([
      { t: b0, ask_total: 300, bid_total: 10, bid_max: 100, ask_max: 300, imb_max_bid: 100, imb_max_ask: 2 },
    ]);
    // quoteImbalance(imb_max) = quoteImbalance(100, 2) = −(100/2−1) = −49 (buy-heavy);
    // quoteImbalance(bid_max, ask_max) = quoteImbalance(100, 300) = 300/100−1 = +2 (sell-heavy) — opposite sign.
    const p = quoteRatioPoints[0];
    expect(quoteImbalance(p.imb_max_bid, p.imb_max_ask)).toBe(-49);
    expect(quoteImbalance(p.bid_max, p.ask_max)).toBe(2);
  });

  it('fully-auction bucket emits 0 sentinel for all Intra-Bar Max fields', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base + 60_000, 50, 60),      // continuous → defines lastContinuous in bucket `base`
      auc(base + 180_000, 41, 31),      // [base+3m,..) fully-auction → excluded everywhere
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    const aucBucket = quoteRatioPoints.find((p) => p.t === base + 180_000)!;
    expect(aucBucket).toEqual({
      t: base + 180_000, ask_total: 0, bid_total: 0,
      bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0,
    });
  });

  it('excludes an intraday VI collapse from a mixed bucket — continuous wins (ADR-0062 v2)', () => {
    const BUCKET = 60_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 3_600_000; // 마감 멀리 — lastContinuous를 마감 근처로.
    const ob = [
      cont(base + 10_000, 50, 60),   // 연속거래(deep) — 버킷 `base`
      auc(base + 30_000, 41, 31),    // 같은 버킷의 **시간상 더 늦은** 장중 VI 붕괴책
      cont(base + 120_000, 70, 80),  // 연속거래 앵커 → lastContinuousMs (VI는 그 이전)
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    const viBucket = quoteRatioPoints.find((p) => p.t === base)!;
    // 대표 = 연속거래(50,60), 시간상 늦은 VI 붕괴책(41,31) 아님.
    expect(viBucket.ask_total).toBe(50);
    expect(viBucket.bid_total).toBe(60);
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
      // b0: max over (a100,b80),(a200,b90) → bid_max90/ask_max200; |imb(90,200)|>|imb(80,90)| → imb_max=(90,200).
      { t: b0, ask_total: 200, bid_total: 90, bid_max: 90, ask_max: 200, imb_max_bid: 90, imb_max_ask: 200 },
      { t: b1, ask_total: 300, bid_total: 95, bid_max: 95, ask_max: 300, imb_max_bid: 95, imb_max_ask: 300 },
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
    // max over continuous (a21,b11),(a22,b12); |imb(11,21)|>|imb(12,22)| → imb_max=(11,21) (first wins).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 22, bid_total: 12, bid_max: 12, ask_max: 22, imb_max_bid: 11, imb_max_ask: 21 },
    ]);
  });

  it('excludes a fully-auction bucket (emits 0, keeps the slot)', () => {
    const BUCKET = 180_000;
    const base = Math.floor(1_700_000_000_000 / BUCKET) * BUCKET;
    const sessionCloseMs = base + 600_000;
    const ob = [
      cont(base + 60_000, 50, 60),      // continuous → defines lastContinuous
      auc(base + 180_000, 41, 31),      // [base+3m,..) fully-auction
      auc(base + 240_000, 42, 32),      // 같은 버킷, 여전히 auction
    ];
    const { quoteRatioPoints } = bucketHogaSeries(ob, [], BUCKET, sessionCloseMs);
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 50, bid_total: 60, bid_max: 60, ask_max: 50, imb_max_bid: 60, imb_max_ask: 50 },
      // no pre-auction member → auction book excluded, slot kept at 0 (ADR-0062) — all Intra-Bar Max 0 too.
      { t: base + 180_000, ask_total: 0, bid_total: 0, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 },
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
    // bucket represented by the base continuous, NOT the 60_000 auction. Max candidates are only the
    // base snapshot (t <= lastContinuousMs = base), so the post-close 90_000 book is excluded from max too.
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 11, bid_total: 21, bid_max: 21, ask_max: 11, imb_max_bid: 21, imb_max_ask: 11 },
    ]);
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
    // All 3 continuous → max over (a21,b11),(a22,b12),(a98,b99): bid_max99/ask_max98;
    // |imb(11,21)|>|imb(12,22)|>|imb(99,98)| → imb_max=(11,21) (first, largest magnitude).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 98, bid_total: 99, bid_max: 99, ask_max: 98, imb_max_bid: 11, imb_max_ask: 21 },
    ]);
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
    // Only the base snapshot is a max candidate (t <= lastContinuousMs = base).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 11, bid_total: 21, bid_max: 21, ask_max: 11, imb_max_bid: 21, imb_max_ask: 11 },
    ]);
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
    // Same shape as the structural straddle test — Intra-Bar Max over continuous (a21,b11),(a22,b12).
    expect(quoteRatioPoints).toEqual([
      { t: base, ask_total: 22, bid_total: 12, bid_max: 12, ask_max: 22, imb_max_bid: 11, imb_max_ask: 21 },
    ]);
  });
});
