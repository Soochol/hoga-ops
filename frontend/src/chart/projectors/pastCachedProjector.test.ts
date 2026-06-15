import { describe, it, expect } from 'vitest';
import { makePastCachedProjector } from './pastCachedProjector';
import { projectRatio, projectRatioPoints, type RatioPaneContext } from './ratio';
import { projectBid, projectBidPoints, projectAsk, projectAskPoints } from './quoteTotals';
import { projectBuy, projectBuyPoints, projectSell, projectSellPoints } from './fillStrength';
import { projectCumulativeNetFill, makeCumulativeCachedProjector } from './fillStrength';
import { createVirtualAxis } from '../../util/virtualAxis';

// 3거래일. 각 날 09:00, 10:00, 그리고 종가 직전 동시호가(close-5min) 점.
const DAY = 24 * 60 * 60 * 1000;
const SESSION = 23_400_000; // 6.5h
const BASE = 1_779_062_400_000;

type QRSeed = {
  t: number;
  bid_total: number;
  ask_total: number;
  bid_max: number;
  ask_max: number;
  imb_max_bid: number;
  imb_max_ask: number;
};

function makeAxisAndBundle(nDays: number, extraTodayPoints: QRSeed[] = []) {
  const axisSegs = [];
  const snakeSegs = [];
  const points: QRSeed[] = [];
  for (let d = 0; d < nDays; d++) {
    const open = BASE + d * DAY;
    const close = open + SESSION;
    axisSegs.push({ date: `d${d}`, sessionOpenMs: open, sessionCloseMs: close });
    snakeSegs.push({ date: `d${d}`, session_open_ms: open, session_close_ms: close, source: 'kis_live' as const });
    points.push({ t: open, bid_total: 100, ask_total: 100, bid_max: 120, ask_max: 130, imb_max_bid: 40, imb_max_ask: 160 });
    points.push({ t: open + 3_600_000, bid_total: 100, ask_total: 200, bid_max: 150, ask_max: 260, imb_max_bid: 30, imb_max_ask: 300 }); // sell-heavy
    points.push({ t: open + 9000 * 1000, bid_total: 5000, ask_total: 50, bid_max: 5200, ask_max: 90, imb_max_bid: 6000, imb_max_ask: 20 }); // 극단값(outlier clamp 대상)
    points.push({ t: close - 5 * 60_000, bid_total: 100, ask_total: 150, bid_max: 110, ask_max: 170, imb_max_bid: 50, imb_max_ask: 220 }); // 동시호가창 (mask 대상)
  }
  const lastOpen = BASE + (nDays - 1) * DAY;
  for (const p of extraTodayPoints) points.push({ ...p, t: lastOpen + p.t });
  points.sort((a, b) => a.t - b.t);
  const axis = createVirtualAxis(axisSegs);
  // fill_strength.points는 quote_ratio.points와 같은 t 격자에 정렬(buy/sell 동등성 테스트용).
  const fsPoints = points.map((p) => ({ t: p.t, buy_qty: p.bid_total % 700, sell_qty: p.ask_total % 600 }));
  const bundle: any = {
    segments: snakeSegs,
    bucket_ms: 60_000,
    quote_ratio: { points },
    fill_strength: { points: fsPoints },
  };
  return { axis, bundle };
}

const CTX_MASKED: RatioPaneContext = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100 };

describe('makePastCachedProjector — 과거/당일 분리 캐시가 풀 투영과 동일 (P0)', () => {
  const getQR = (b: any) => b.quote_ratio.points;

  it('3일 번들 + 동시호가 마스킹 + outlier clamp 에서 풀 투영과 바이트 동일', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    expect(cached(bundle, axis, CTX_MASKED)).toEqual(projectRatio(bundle, axis, CTX_MASKED));
  });

  it('틱(당일 버킷 추가) 후에도 신선 — 스테일 캐시 아님', () => {
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    const first = makeAxisAndBundle(3);
    cached(first.bundle, first.axis, CTX_MASKED); // 캐시 워밍
    // 같은 axis/ctx, 당일에 새 버킷 1개 추가된 새 번들
    const tick = makeAxisAndBundle(3, [{
      t: 2 * 3_600_000,
      bid_total: 100,
      ask_total: 300,
      bid_max: 100,
      ask_max: 300,
      imb_max_bid: 100,
      imb_max_ask: 300,
    }]);
    expect(cached(tick.bundle, first.axis, CTX_MASKED)).toEqual(
      projectRatio(tick.bundle, first.axis, CTX_MASKED),
    );
  });

  it('ctx 변경(mask off) 시 캐시 무효화 — 새 ctx로 재투영', () => {
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    const { axis, bundle } = makeAxisAndBundle(3);
    cached(bundle, axis, CTX_MASKED); // 마스킹 켜진 상태로 워밍
    const ctxOff: RatioPaneContext = { auctionWindowMask: false, outlierFilterEnabled: false, outlierThreshold: 100 };
    expect(cached(bundle, axis, ctxOff)).toEqual(projectRatio(bundle, axis, ctxOff));
  });

  it('과거 확장(좌측 팬 → 새 axis) 시 캐시 무효화', () => {
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    const small = makeAxisAndBundle(3);
    cached(small.bundle, small.axis, CTX_MASKED);
    const big = makeAxisAndBundle(5); // 과거 2일 추가 → 새 axis/segments
    expect(cached(big.bundle, big.axis, CTX_MASKED)).toEqual(
      projectRatio(big.bundle, big.axis, CTX_MASKED),
    );
  });

  it('단일 세그먼트(분리 이득 없음)에서도 풀 투영과 동일', () => {
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    const { axis, bundle } = makeAxisAndBundle(1);
    expect(cached(bundle, axis, CTX_MASKED)).toEqual(projectRatio(bundle, axis, CTX_MASKED));
  });
});

describe('makePastCachedProjector — 총잔량(bid/ask)·체결강도 히스토그램(buy/sell) 동등성', () => {
  const getQR = (b: any) => b.quote_ratio.points;
  const getFS = (b: any) => b.fill_strength.points;
  const MASK = true; // 총잔량/체결강도 ctx = auctionWindowMask boolean

  it('projectBid 분리-캐시 == 풀(마스킹 on)', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectBidPoints, getQR);
    expect(cached(bundle, axis, MASK)).toEqual(projectBid(bundle, axis, MASK));
  });

  it('projectAsk 분리-캐시 == 풀(마스킹 on)', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectAskPoints, getQR);
    expect(cached(bundle, axis, MASK)).toEqual(projectAsk(bundle, axis, MASK));
  });

  it('projectBuy 분리-캐시 == 풀(마스킹 on, whitespace 포함)', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectBuyPoints, getFS);
    expect(cached(bundle, axis, MASK)).toEqual(projectBuy(bundle, axis, MASK));
  });

  it('projectSell 분리-캐시 == 풀(마스킹 on, 음수값)', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectSellPoints, getFS);
    expect(cached(bundle, axis, MASK)).toEqual(projectSell(bundle, axis, MASK));
  });

  it('틱 후 buy 신선 — 당일 새 버킷 반영', () => {
    const cached = makePastCachedProjector(projectBuyPoints, getFS);
    const first = makeAxisAndBundle(3);
    cached(first.bundle, first.axis, MASK);
    const tick = makeAxisAndBundle(3, [{
      t: 2 * 3_600_000,
      bid_total: 640,
      ask_total: 480,
      bid_max: 640,
      ask_max: 480,
      imb_max_bid: 640,
      imb_max_ask: 480,
    }]);
    expect(cached(tick.bundle, first.axis, MASK)).toEqual(projectBuy(tick.bundle, first.axis, MASK));
  });
});

describe('Split Cache 등가 — Intra-Bar Max 필드 포함, intraMax ON/OFF 양쪽 (P5 회귀)', () => {
  const getQR = (b: any) => b.quote_ratio.points;
  const bidProj = (im: boolean) => (pts: any, ax: any, mask: boolean) => projectBidPoints(pts, ax, mask, im);
  const askProj = (im: boolean) => (pts: any, ax: any, mask: boolean) => projectAskPoints(pts, ax, mask, im);
  const CTX_RATIO_OFF: RatioPaneContext = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100, intraMax: false };
  const CTX_RATIO_ON: RatioPaneContext = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100, intraMax: true };

  it.each([false, true])('projectBid 분리-캐시 == 풀 (intraMax=%s)', (im) => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(bidProj(im), getQR);
    expect(cached(bundle, axis, true)).toEqual(bidProj(im)(getQR(bundle), axis, true));
  });

  it.each([false, true])('projectAsk 분리-캐시 == 풀 (intraMax=%s)', (im) => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(askProj(im), getQR);
    expect(cached(bundle, axis, true)).toEqual(askProj(im)(getQR(bundle), axis, true));
  });

  it('projectRatio 분리-캐시 == 풀, mask+outlier ON (intraMax OFF=종가)', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    expect(cached(bundle, axis, CTX_RATIO_OFF)).toEqual(projectRatio(bundle, axis, CTX_RATIO_OFF));
  });

  it('projectRatio 분리-캐시 == 풀, mask+outlier ON (intraMax ON=imb_max)', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const cached = makePastCachedProjector(projectRatioPoints, getQR);
    expect(cached(bundle, axis, CTX_RATIO_ON)).toEqual(projectRatio(bundle, axis, CTX_RATIO_ON));
  });

  it('intraMax ON 투영 != OFF 투영', () => {
    const { axis, bundle } = makeAxisAndBundle(3);
    const pts = getQR(bundle);
    expect(projectBidPoints(pts, axis, true, true)).not.toEqual(projectBidPoints(pts, axis, true, false));
  });

  it('틱 후에도 ON 경로 신선 — 스테일 캐시 아님', () => {
    const cached = makePastCachedProjector(askProj(true), getQR);
    const first = makeAxisAndBundle(3);
    cached(first.bundle, first.axis, true);
    const tick = makeAxisAndBundle(3, [{
      t: 2 * 3_600_000,
      bid_total: 100,
      ask_total: 300,
      bid_max: 130,
      ask_max: 380,
      imb_max_bid: 40,
      imb_max_ask: 420,
    }]);
    expect(cached(tick.bundle, first.axis, true)).toEqual(askProj(true)(getQR(tick.bundle), first.axis, true));
  });
});

// 누적 체결강도: 첫 점이 open 이후라 zero anchor 발생, 다일이라 일경계 break,
// 동시호가 점이라 경매 anchor + lastPreAuctionIdx 패치까지 모두 자극.
function makeCumulativeBundle(nDays: number, extraToday: number[] = []) {
  const axisSegs = [];
  const snakeSegs = [];
  const fs: { t: number; buy_qty: number; sell_qty: number }[] = [];
  for (let d = 0; d < nDays; d++) {
    const open = BASE + d * DAY;
    const close = open + SESSION;
    axisSegs.push({ date: `d${d}`, sessionOpenMs: open, sessionCloseMs: close });
    snakeSegs.push({ date: `d${d}`, session_open_ms: open, session_close_ms: close, source: 'kis_live' as const });
    fs.push({ t: open + 3_600_000, buy_qty: 300, sell_qty: 120 }); // open 이후 → zero anchor
    fs.push({ t: open + 2 * 3_600_000, buy_qty: 80, sell_qty: 400 });
    fs.push({ t: close - 5 * 60_000, buy_qty: 50, sell_qty: 50 }); // 동시호가창
  }
  const lastOpen = BASE + (nDays - 1) * DAY;
  for (const dt of extraToday) fs.push({ t: lastOpen + dt, buy_qty: 200, sell_qty: 90 });
  fs.sort((a, b) => a.t - b.t);
  return {
    axis: createVirtualAxis(axisSegs),
    bundle: { segments: snakeSegs, bucket_ms: 60_000, fill_strength: { points: fs } } as any,
  };
}

describe('makeCumulativeCachedProjector — 누적 체결강도 분리-캐시 동등성 (P0, 최난도)', () => {
  it('3일 + zero anchor + 일경계 break + 경매 anchor 에서 풀 투영과 동일', () => {
    const { axis, bundle } = makeCumulativeBundle(3);
    const cached = makeCumulativeCachedProjector();
    expect(cached(bundle, axis, true)).toEqual(projectCumulativeNetFill(bundle, axis, true));
  });

  it('마스킹 off 에서도 동일', () => {
    const { axis, bundle } = makeCumulativeBundle(3);
    const cached = makeCumulativeCachedProjector();
    expect(cached(bundle, axis, false)).toEqual(projectCumulativeNetFill(bundle, axis, false));
  });

  it('틱(당일 새 버킷) 후 신선 — runningSum 후속 전부 갱신', () => {
    const cached = makeCumulativeCachedProjector();
    const first = makeCumulativeBundle(3);
    cached(first.bundle, first.axis, true); // 워밍
    const tick = makeCumulativeBundle(3, [2.5 * 3_600_000]);
    expect(cached(tick.bundle, first.axis, true)).toEqual(
      projectCumulativeNetFill(tick.bundle, first.axis, true),
    );
  });

  it('ctx(mask) 변경 시 캐시 무효화', () => {
    const cached = makeCumulativeCachedProjector();
    const { axis, bundle } = makeCumulativeBundle(3);
    cached(bundle, axis, true);
    expect(cached(bundle, axis, false)).toEqual(projectCumulativeNetFill(bundle, axis, false));
  });

  it('단일 세그먼트에서도 동일', () => {
    const { axis, bundle } = makeCumulativeBundle(1);
    const cached = makeCumulativeCachedProjector();
    expect(cached(bundle, axis, true)).toEqual(projectCumulativeNetFill(bundle, axis, true));
  });
});
