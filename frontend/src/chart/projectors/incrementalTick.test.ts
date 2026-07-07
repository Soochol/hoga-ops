import { describe, it, expect } from 'vitest';
import { RATIO_SPEC } from './ratio';
import { QUOTE_TOTALS_SPEC } from './quoteTotals';
import { FILL_STRENGTH_SPEC } from './fillStrength';
import { classifyDataChange } from '../seriesDataDiff';
import { createVirtualAxis } from '../../util/virtualAxis';

// "win이 실재하는가" 검증: 실제 spec.data() 투영이 장중 SSE 틱(=today 마지막 버킷 변경)에
// 대해 classifyDataChange로 'update'(렌더 비용 win) 또는 'setData'(폴백)로 어떻게
// 분류되는지 잠근다. P0 캐시 적중(같은 axis/ctx 참조)을 전제로 한다.

const DAY = 24 * 60 * 60 * 1000;
const SESSION = 23_400_000; // 6.5h
const BASE = 1_779_062_400_000;
const BUCKET = 60_000;

// 3거래일. today는 장중 "지금"(13:00 근처, 경매창 15:20 한참 전)까지만 데이터.
function build(nowOffsetMin: number) {
  const axisSegs = [];
  const snakeSegs = [];
  const qr = [];
  const fs = [];
  for (let d = 0; d < 3; d++) {
    const open = BASE + d * DAY;
    const close = open + SESSION;
    axisSegs.push({ date: `d${d}`, sessionOpenMs: open, sessionCloseMs: close });
    snakeSegs.push({ date: `d${d}`, session_open_ms: open, session_close_ms: close, source: 'kis_live' as const });
    // 과거일은 풀 세션, today(d===2)는 nowOffsetMin까지만.
    const lastMin = d < 2 ? 389 : nowOffsetMin;
    for (let m = 0; m <= lastMin; m++) {
      const t = open + m * BUCKET;
      qr.push({ t, ask_total: 50000 + ((m * 37) % 9000), bid_total: 50000 + ((m * 53) % 9000) });
      fs.push({ t, buy_qty: (m * 17) % 1200, sell_qty: (m * 11) % 1100 });
    }
  }
  const axis = createVirtualAxis(axisSegs);
  const bundle: any = {
    segments: snakeSegs, bucket_ms: BUCKET,
    quote_ratio: { points: qr }, fill_strength: { points: fs },
  };
  return { axis, bundle };
}

// 틱: today 마지막 버킷(=지금)의 값만 바뀐 새 번들(같은 axis/ctx).
function tick(axis: any, prevBundle: any, dataFn: any, ctx: any) {
  const before = dataFn(prevBundle, axis, ctx);
  const qr2 = prevBundle.quote_ratio.points.slice();
  const fs2 = prevBundle.fill_strength.points.slice();
  const li = qr2.length - 1;
  qr2[li] = { ...qr2[li], ask_total: qr2[li].ask_total + 500, bid_total: qr2[li].bid_total + 300 };
  const fl = fs2.length - 1;
  fs2[fl] = { ...fs2[fl], buy_qty: fs2[fl].buy_qty + 100, sell_qty: fs2[fl].sell_qty + 80 };
  const nextBundle = { ...prevBundle, quote_ratio: { points: qr2 }, fill_strength: { points: fs2 } };
  const after = dataFn(nextBundle, axis, ctx);
  return classifyDataChange(before, after).kind;
}

const RATIO_CTX = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100 };

describe('장중 틱 → 증분 update() 분류 (P2 win 실재 검증)', () => {
  it('호가비(ratio)는 장중 틱에 update', () => {
    const { axis, bundle } = build(180); // 지금 = 03:00 경과(장중)
    expect(tick(axis, bundle, RATIO_SPEC.series[0].data, RATIO_CTX)).toBe('update');
  });

  it('총잔량 bid/ask 둘 다 장중 틱에 update', () => {
    const { axis, bundle } = build(180);
    expect(tick(axis, bundle, QUOTE_TOTALS_SPEC.series[0].data, true)).toBe('update');
    expect(tick(axis, bundle, QUOTE_TOTALS_SPEC.series[1].data, true)).toBe('update');
  });

  it('체결강도 매수/매도 히스토그램 둘 다 장중 틱에 update', () => {
    const { axis, bundle } = build(180);
    const ctx = { cumulativeEnabled: true, auctionWindowMask: true };
    expect(tick(axis, bundle, FILL_STRENGTH_SPEC.series[0].data, ctx)).toBe('update');
    expect(tick(axis, bundle, FILL_STRENGTH_SPEC.series[1].data, ctx)).toBe('update');
  });

  it('누적 라인: mask OFF면 update(트레일링 anchor 없음)', () => {
    const { axis, bundle } = build(180);
    const ctx = { cumulativeEnabled: true, auctionWindowMask: false };
    expect(tick(axis, bundle, FILL_STRENGTH_SPEC.series[2].data, ctx)).toBe('update');
  });

  it('누적 라인: mask ON에서도 장중 값-변경 틱에 update (마지막 세그먼트 앵커·패치 억제)', () => {
    const { axis, bundle } = build(180);
    const ctx = { cumulativeEnabled: true, auctionWindowMask: true };
    expect(tick(axis, bundle, FILL_STRENGTH_SPEC.series[2].data, ctx)).toBe('update');
  });

  it('누적 라인: mask ON에서 새 버킷 append 틱에도 update', () => {
    const { axis, bundle } = build(180);
    const ctx = { cumulativeEnabled: true, auctionWindowMask: true };
    const dataFn = FILL_STRENGTH_SPEC.series[2].data;
    const before = dataFn(bundle, axis, ctx);
    // 다음 분봉 버킷이 새로 열리는 틱: fill_strength에 점 1개 append.
    const fs2 = bundle.fill_strength.points.slice();
    const last = fs2[fs2.length - 1];
    fs2.push({ t: last.t + BUCKET, buy_qty: 700, sell_qty: 300 });
    const nextBundle = { ...bundle, fill_strength: { points: fs2 } };
    const after = dataFn(nextBundle, axis, ctx);
    expect(classifyDataChange(before, after).kind).toBe('update');
  });
});
