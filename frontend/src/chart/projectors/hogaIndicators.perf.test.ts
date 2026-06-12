// @vitest-environment node
// 라이브 보조지표(호가비/총잔량/체결강도) 틱당 처리 비용 실측.
// 캔들/거래량 제외. 순수 함수만 측정 — lwc setData(렌더) 비용은 별도(측정 불가, 정적 추정).
import { describe, it } from 'vitest';
import { bucketHogaSeries, type ObSnapshot, type TradeSnapshot } from '../../live/bucketHogaSeries';
import { projectRatio } from './ratio';
import { projectBid, projectAsk } from './quoteTotals';
import { projectBuy, projectSell, projectCumulativeNetFill } from './fillStrength';
import { computeSMA, selectSource } from './movingAverage';
import { createVirtualAxis } from '../../util/virtualAxis';

const DAY = 24 * 60 * 60 * 1000;
const SESSION = 6.5 * 60 * 60 * 1000; // 09:00–15:30
const BASE = 1_779_062_400_000;
const BUCKET_MS = 60_000; // 1분봉 (호가 팬은 분봉에서만 마운트)
const PER_DAY = 390; // 6.5h / 1m

// 기본 prefs (chartPrefs.ts 확인): 셋 다 켜짐 → 최악(기본) 경로
const RATIO_CTX = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100 };
const FS_CTX_MASK = true;
const CUMULATIVE_ON = true;

function makeAxisAndSegments(days: number) {
  const axisSegs = [];
  const bundleSegs = [];
  for (let d = 0; d < days; d++) {
    const open = BASE + d * DAY;
    const close = open + SESSION;
    axisSegs.push({ date: `d${d}`, sessionOpenMs: open, sessionCloseMs: close });
    bundleSegs.push({ date: `d${d}`, session_open_ms: open, session_close_ms: close, source: 'kis_live' as const });
  }
  return { axis: createVirtualAxis(axisSegs), bundleSegs };
}

// 과거+당일 호가 points: days × 390 버킷 (모두 in-session → 모두 렌더 대상 = 최악)
function makePoints(days: number) {
  const qr = [];
  const fs = [];
  for (let d = 0; d < days; d++) {
    const open = BASE + d * DAY;
    for (let m = 0; m < PER_DAY; m++) {
      const t = open + m * BUCKET_MS;
      qr.push({ t, ask_total: 50000 + ((m * 37) % 9000), bid_total: 50000 + ((m * 53) % 9000) });
      fs.push({ t, buy_qty: (m * 17) % 1200, sell_qty: (m * 11) % 1100 });
    }
  }
  return { qr, fs };
}

function makeBundle(days: number) {
  const { axis, bundleSegs } = makeAxisAndSegments(days);
  const { qr, fs } = makePoints(days);
  const bundle: any = {
    segments: bundleSegs,
    bucket_ms: BUCKET_MS,
    quote_ratio: { bucket_ms: BUCKET_MS, points: qr },
    fill_strength: { bucket_ms: BUCKET_MS, points: fs },
    investorPoints: [],
    candles: [],
  };
  return { bundle, axis, pointCount: qr.length };
}

// 15분 버퍼 (bucketHogaSeries 입력). append-only + t_ms 오름차순(실제 버퍼 불변식).
// 분봉 경로는 totals-only(asks/bids 없음) — isContinuousBook=true 경로.
function makeBuffer(obCount: number, tradeCount: number) {
  const now = BASE + 5 * DAY + 5 * 60 * 60 * 1000; // 장중 어느 시점
  const windowMs = 15 * 60_000;
  const ob: ObSnapshot[] = [];
  for (let i = 0; i < obCount; i++) {
    const t = now - windowMs + Math.floor((i / obCount) * windowMs);
    ob.push({ t_ms: t, total_ask_qty: 40000 + ((i * 31) % 8000), total_bid_qty: 41000 + ((i * 41) % 8000) });
  }
  const trade: TradeSnapshot[] = [];
  for (let i = 0; i < tradeCount; i++) {
    const t = now - windowMs + Math.floor((i / tradeCount) * windowMs);
    const side = (i % 3) === 0 ? -1 : 1;
    trade.push({ t_ms: t, trades: [{ side, qty: (i * 7) % 500 }, { side: -side, qty: (i * 3) % 300 }] });
  }
  return { ob, trade, sessionCloseMs: now + 2 * 60 * 60 * 1000 };
}

function median(fn: () => void, runs = 9): number {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    xs.push(performance.now() - t0);
  }
  return xs.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

const FLUSH_HZ = 1000 / 150; // ≈6.7 — LIVE_FLUSH_MS=150ms 트레일링 스로틀

describe('라이브 호가 보조지표 — 틱당 처리 비용 (캔들/거래량 제외)', () => {
  it('A) projector 풀-배열 재투영 비용 (틱당, days 스윕)', () => {
    for (const days of [1, 5, 30, 90]) {
      const { bundle, axis, pointCount } = makeBundle(days);
      // warm-up
      projectRatio(bundle, axis, RATIO_CTX as any);
      projectBid(bundle, axis, FS_CTX_MASK);
      projectCumulativeNetFill(bundle, axis, FS_CTX_MASK);

      const tRatio = median(() => projectRatio(bundle, axis, RATIO_CTX as any));
      const tQuoteTotals = median(() => { projectBid(bundle, axis, FS_CTX_MASK); projectAsk(bundle, axis, FS_CTX_MASK); });
      const tFsHist = median(() => { projectBuy(bundle, axis, FS_CTX_MASK); projectSell(bundle, axis, FS_CTX_MASK); });
      const tCumulative = median(() => (CUMULATIVE_ON ? projectCumulativeNetFill(bundle, axis, FS_CTX_MASK) : []));
      const perTick = tRatio + tQuoteTotals + tFsHist + tCumulative;
      // eslint-disable-next-line no-console
      console.log(
        `[A] days=${String(days).padStart(2)} pts=${String(pointCount).padStart(5)} | ` +
        `ratio=${tRatio.toFixed(2)} totals=${tQuoteTotals.toFixed(2)} fsHist=${tFsHist.toFixed(2)} ` +
        `CUMUL=${tCumulative.toFixed(2)} | 틱합=${perTick.toFixed(2)}ms → /초(${FLUSH_HZ.toFixed(1)}Hz)=${(perTick * FLUSH_HZ).toFixed(0)}ms`,
      );
    }
  });

  it('B) bucketHogaSeries 재버킷팅 비용 (틱당, 버퍼 크기 스윕)', () => {
    for (const [obN, trN] of [[900, 900], [2000, 2000], [4000, 6000], [8000, 12000]] as const) {
      const { ob, trade, sessionCloseMs } = makeBuffer(obN, trN);
      bucketHogaSeries(ob, trade, BUCKET_MS, sessionCloseMs); // warm
      const t = median(() => bucketHogaSeries(ob, trade, BUCKET_MS, sessionCloseMs));
      // 낭비되는 정렬분만 분리 측정 (버퍼는 이미 t_ms 오름차순)
      const tSort = median(() => { [...ob].sort((a, b) => a.t_ms - b.t_ms); [...trade].sort((a, b) => a.t_ms - b.t_ms); });
      // eslint-disable-next-line no-console
      console.log(
        `[B] ob=${String(obN).padStart(5)} trade=${String(trN).padStart(5)} | ` +
        `bucket=${t.toFixed(2)}ms (정렬분=${tSort.toFixed(2)}ms, ${((tSort / t) * 100).toFixed(0)}%) → ` +
        `/초=${(t * FLUSH_HZ).toFixed(0)}ms`,
      );
    }
  });

  it('C) 증분 emit 달성 가능 바닥 (마지막 버킷만) vs 풀-배열', () => {
    const { bundle, axis, pointCount } = makeBundle(90);
    // 풀-배열 ratio
    const full = median(() => projectRatio(bundle, axis, RATIO_CTX as any));
    // 증분: 마지막 점 1개만 처리 (O(1)) — 리팩터 후 달성 가능한 이론 바닥
    const lastP = bundle.quote_ratio.points[bundle.quote_ratio.points.length - 1];
    const oneBundle: any = { ...bundle, quote_ratio: { ...bundle.quote_ratio, points: [lastP] } };
    const incr = median(() => projectRatio(oneBundle, axis, RATIO_CTX as any), 21);
    // eslint-disable-next-line no-console
    console.log(`[C] pts=${pointCount} | 풀배열 ratio=${full.toFixed(2)}ms vs 증분(1점)=${incr.toFixed(4)}ms → ${(full / Math.max(incr, 0.0001)).toFixed(0)}× 절감 여지`);
  });

  it('E) P0 과거/당일 분리 캐시 — 틱당 비용 (당일 세그먼트만 재투영 + concat)', () => {
    for (const days of [5, 30, 90]) {
      const { bundle, axis } = makeBundle(days);
      // 당일 세그먼트만 담은 미니 번들 (과거는 캐시 동결 가정)
      const todayOpen = BASE + (days - 1) * DAY;
      const todayClose = todayOpen + SESSION;
      const todayQr = bundle.quote_ratio.points.filter((p: any) => p.t >= todayOpen);
      const todayFs = bundle.fill_strength.points.filter((p: any) => p.t >= todayOpen);
      const todayBundle: any = {
        segments: [{ date: `d${days - 1}`, session_open_ms: todayOpen, session_close_ms: todayClose, source: 'kis_live' }],
        bucket_ms: BUCKET_MS,
        quote_ratio: { bucket_ms: BUCKET_MS, points: todayQr },
        fill_strength: { bucket_ms: BUCKET_MS, points: todayFs },
        investorPoints: [], candles: [],
      };
      // 과거 투영은 캐시에서 동결 배열로 온다고 가정 (틱당 비용 0). concat 대상으로 더미 길이만 맞춤.
      const cachedPastLen = bundle.quote_ratio.points.length - todayQr.length;
      const cachedPast = new Array(cachedPastLen).fill({ time: 0, value: 0 });

      // warm
      projectRatio(todayBundle, axis, RATIO_CTX as any);

      const perTick = median(() => {
        // 당일만 재투영 (6 projector)
        const r = projectRatio(todayBundle, axis, RATIO_CTX as any);
        const b = projectBid(todayBundle, axis, FS_CTX_MASK);
        const a = projectAsk(todayBundle, axis, FS_CTX_MASK);
        const buy = projectBuy(todayBundle, axis, FS_CTX_MASK);
        const sell = projectSell(todayBundle, axis, FS_CTX_MASK);
        const c = projectCumulativeNetFill(todayBundle, axis, FS_CTX_MASK);
        // setData에 넘길 전체 배열 = 캐시(과거) + 당일 재투영. concat O(N) 1회씩.
        void [...cachedPast, ...r]; void [...cachedPast, ...b]; void [...cachedPast, ...a];
        void [...cachedPast, ...buy]; void [...cachedPast, ...sell]; void [...cachedPast, ...c];
      });
      // eslint-disable-next-line no-console
      console.log(`[E] days=${String(days).padStart(2)} | P0 틱합=${perTick.toFixed(2)}ms (당일투영+concat) → /초=${(perTick * FLUSH_HZ).toFixed(0)}ms`);
    }
  });

  it('F) END-TO-END: 실제 스펙 data() 경로로 P0 win 검증 (90일, 워밍 후 틱당)', async () => {
    const { RATIO_SPEC } = await import('./ratio');
    const { QUOTE_TOTALS_SPEC } = await import('./quoteTotals');
    const { FILL_STRENGTH_SPEC } = await import('./fillStrength');
    const days = 90;
    const { axis } = makeAxisAndSegments(days);
    const ratioCtx = { auctionWindowMask: true, outlierFilterEnabled: true, outlierThreshold: 100 };
    const fsCtx = { cumulativeEnabled: true, auctionWindowMask: true };

    // 3개 호가 팬 전체 series(6개) data() 1회 = 틱 1회
    const tickOnce = (b: any) => {
      RATIO_SPEC.series.forEach((s) => s.data(b, axis, ratioCtx as any));
      QUOTE_TOTALS_SPEC.series.forEach((s) => s.data(b, axis, true as any));
      FILL_STRENGTH_SPEC.series.forEach((s) => s.data(b, axis, fsCtx as any));
    };

    // 매 틱 당일 마지막 버킷이 바뀐 새 번들 (과거 동결, axis/ctx 안정 → 캐시 적중)
    const todayOpen = BASE + (days - 1) * DAY;
    const makeTickBundle = (k: number) => {
      const { bundle } = makeBundle(days);
      bundle.quote_ratio.points.push({ t: todayOpen + (300 + k) * BUCKET_MS, ask_total: 50000 + k, bid_total: 50000 - k });
      bundle.fill_strength.points.push({ t: todayOpen + (300 + k) * BUCKET_MS, buy_qty: 100 + k, sell_qty: 50 });
      return bundle;
    };

    tickOnce(makeTickBundle(0)); // 워밍(과거 캐시 채움)
    const warmed = median(() => tickOnce(makeTickBundle(1)), 9);
    // eslint-disable-next-line no-console
    console.log(`[F] END-TO-END 90일 워밍 후 틱당=${warmed.toFixed(2)}ms → /초=${(warmed * FLUSH_HZ).toFixed(0)}ms (비교: [A]90일=~35ms/틱)`);
  });

  it('G) 총잔량 급증 마커 — 틱당 비용 (Split Cache seam vs 전구간 재계산, days 스윕)', async () => {
    const { QUOTE_TOTALS_SPEC } = await import('./quoteTotals');
    const { detectSurgeSide } = await import('../surge/detectSurges');
    const ctx = { auctionMask: true, surgeEnabled: true, surgeMarginPct: 50 };
    for (const days of [1, 5, 30, 90]) {
      const { bundle, axis, pointCount } = makeBundle(days);
      // 캐시 경로(현 구현): markers 프로젝터가 makePastCachedProjector를 거쳐 과거 동결.
      // 동일 번들 재호출 → 과거 캐시 적중(=틱당 비용이 깊이 무관함을 보임).
      QUOTE_TOTALS_SPEC.series.forEach((s) => s.markers?.(bundle, axis, ctx as any)); // warm
      const tSeam = median(() => QUOTE_TOTALS_SPEC.series.forEach((s) => s.markers?.(bundle, axis, ctx as any)));
      // 비교용: seam 없이 detectSurgeSide를 ask+bid 전구간 직접 호출(=리팩터 전 경로).
      const tFull = median(() => {
        detectSurgeSide(bundle.quote_ratio.points, 'ask', { margin: 0.5, isClosingAuction: (t) => axis.inClosingAuctionWindow(t) });
        detectSurgeSide(bundle.quote_ratio.points, 'bid', { margin: 0.5, isClosingAuction: (t) => axis.inClosingAuctionWindow(t) });
      });
      // eslint-disable-next-line no-console
      console.log(
        `[G] days=${String(days).padStart(2)} pts=${String(pointCount).padStart(5)} | ` +
        `seam(캐시)=${tSeam.toFixed(3)}ms vs 전구간=${tFull.toFixed(3)}ms → seam /초=${(tSeam * FLUSH_HZ).toFixed(1)}ms ` +
        `(${(tFull / Math.max(tSeam, 0.001)).toFixed(0)}× 절감, 깊이무관)`,
      );
    }
  });

  it('D) 참고: 이동평균(MA) — 안정 chartBundle 경로(틱당 아님), config개수 스윕', () => {
    const days = 90;
    const { axis } = makeAxisAndSegments(days);
    const candles = [];
    for (let d = 0; d < days; d++) {
      const open = BASE + d * DAY;
      for (let m = 0; m < PER_DAY; m++) candles.push({ ts_ms: open + m * BUCKET_MS, open: 100, high: 102, low: 99, close: 101 });
    }
    const inSession = candles.filter((c) => axis.contains(c.ts_ms));
    for (const nCfg of [3, 6]) {
      const t = median(() => {
        for (let k = 0; k < nCfg; k++) {
          const values = inSession.map((c) => selectSource(c as any, 'close'));
          computeSMA(values, 20 + k * 20);
        }
      });
      // eslint-disable-next-line no-console
      console.log(`[D] MA configs=${nCfg} candles=${inSession.length} | 재계산=${t.toFixed(2)}ms (캔들 변화 시에만, 틱당 아님)`);
    }
  });
});
