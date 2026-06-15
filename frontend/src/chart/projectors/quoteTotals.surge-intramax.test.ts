import { describe, it, expect } from 'vitest';
import { askSurgeMarkers, type QuoteTotalsCtx } from './quoteTotals';
import type { QuoteRatioPoint, RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';

const D = 1_700_000_000_000;
const mk = (i: number, ask: number, ask_max: number): QuoteRatioPoint => ({
  t: D + i * 60_000,
  bid_total: 1,
  ask_total: ask,
  bid_max: 1,
  ask_max,
  imb_max_bid: 1,
  imb_max_ask: ask_max,
});
const pts: QuoteRatioPoint[] = [mk(0, 100, 100), mk(1, 50, 50), mk(2, 98, 500)];
const bundle = {
  quote_ratio: { bucket_ms: 60_000, points: pts },
  segments: [{ session_open_ms: D - 60_000, session_close_ms: D + 23_400_000 }],
} as unknown as RangeBundle;
const axis = createVirtualAxis([
  { date: '20231114', sessionOpenMs: D - 60_000, sessionCloseMs: D + 23_400_000 },
]);
const ctx = (intraMax: boolean): QuoteTotalsCtx => ({
  auctionMask: false,
  intraMax,
  surgeEnabled: true,
  surgeApproachPct: 95,
  surgeRearmPct: 85,
  surgeStartHHMM: 0,
});

describe('급증 마커 — 감지 종가 고정, 높이만 Intra-Bar Max', () => {
  it('발사 시점(time)은 intraMax ON/OFF 동일', () => {
    const off = askSurgeMarkers(bundle, axis, ctx(false));
    const on = askSurgeMarkers(bundle, axis, ctx(true));
    expect(off.length).toBe(1);
    expect(on.length).toBe(1);
    expect(on[0].time).toBe(off[0].time);
  });

  it('마커 높이(price): OFF=종가 98, ON=그 버킷 ask_max 500', () => {
    expect(askSurgeMarkers(bundle, axis, ctx(false))[0].price).toBe(98);
    expect(askSurgeMarkers(bundle, axis, ctx(true))[0].price).toBe(500);
  });
});
