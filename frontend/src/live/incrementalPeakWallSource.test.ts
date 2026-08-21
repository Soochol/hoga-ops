import { describe, it, expect } from 'vitest';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import {
  deriveDayAskPeaks,
  deriveDayAskPeaksIncremental,
  deriveDayAskPeaksIncrementalAsOf,
} from './useDayAskPeaks';
import {
  deriveDayBidPeaks,
  deriveDayBidPeaksIncremental,
  deriveDayBidPeaksIncrementalAsOf,
} from './useDayBidPeaks';
import type { AskPeak, BidPeak } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const TODAY = '20260613';
const atKst = (hh: number, mm = 0, ss = 0) => Date.UTC(2026, 5, 13, hh - 9, mm, ss);
// 개장 하한(09:00 KST). 필수 인자가 된 이유는 computeDayAskPeak.test 의 같은 상수 주석 참조.
const OPEN_MS = atKst(9);

// isContinuousBook(딥 레벨 qty>0)과 isAfterRegularOpen(09:00↑)을 통과하는 스냅샷.
function ob(t_ms: number, asks: Array<{ price: number; qty: number }>): ObSnapshot {
  return {
    t_ms,
    total_ask_qty: 0,
    total_bid_qty: 0,
    asks: [...asks, ...Array.from({ length: Math.max(0, 10 - asks.length) }, () => ({ price: 1, qty: 1 }))],
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
  };
}

function tradeSnap(t_ms: number, trades: TradeSnapshot['trades']): TradeSnapshot {
  return { t_ms, trades };
}

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function genStream(seed: number, snapshots: number): { obs: ObSnapshot[]; trades: TradeSnapshot[] } {
  const rnd = seededRng(seed);
  const obs: ObSnapshot[] = [];
  const trades: TradeSnapshot[] = [];
  let t = atKst(9, 1);
  for (let i = 0; i < snapshots; i += 1) {
    t += Math.floor(rnd() * 3_000); // 동일 t_ms 스냅샷도 가끔 발생
    const levels = Array.from({ length: 3 }, () => ({
      price: 25000 + Math.floor(rnd() * 20) * 50,
      qty: 1 + Math.floor(rnd() * 20000),
    }));
    obs.push(ob(t, levels));
    if (rnd() < 0.6) {
      const sides = [1, -1, 0, 2] as const;
      trades.push(tradeSnap(t + 1, [{
        t_ms: rnd() < 0.8 ? t + 1 : (undefined as unknown as number), // 스냅샷 t_ms 폴백 경로도 커버
        side: sides[Math.floor(rnd() * sides.length)],
        price: 25000 + Math.floor(rnd() * 20) * 50,
        qty: 1 + Math.floor(rnd() * 100),
      }]));
    }
  }
  return { obs, trades };
}

const BACKEND: LiveTodayAskPeak = {
  date: TODAY,
  coverage: 'partial',
  traded_price: 25500,
  traded_qty: 9000,
  traded_t_ms: atKst(9, 10),
  all_price: 26000,
  all_qty: 12000,
  all_t_ms: atKst(9, 11),
};

const ASK_SEEDS: AskPeak[] = [
  { date: '20260611', price: 297000, qty: 32621, t_ms: 1, max_price: 300000, max_qty: 40000, max_t_ms: 11 },
  { date: TODAY, price: 25100, qty: 5000, t_ms: 2, max_price: 25100, max_qty: 5000, max_t_ms: 2 },
];
const BID_SEEDS: BidPeak[] = ASK_SEEDS.map((p) => ({ ...p }));

describe('IncrementalPeakWallSource — 배치 derive와의 동등성', () => {
  it.each([1, 7, 42, 1234])('ask: 청크 공급 결과가 배치와 동일하다 (seed %i)', (seed) => {
    const { obs, trades } = genStream(seed, 300);
    const source = new IncrementalPeakWallSource('ask');
    const cuts = [0, 30, 31, 120, 121, 299, 300];
    for (const cut of cuts) {
      const obSlice = obs.slice(0, cut);
      const tradeSlice = trades.slice(0, Math.min(cut, trades.length));
      const incremental = deriveDayAskPeaksIncremental(
        source, obSlice, tradeSlice, ASK_SEEDS, TODAY, OPEN_MS, BACKEND,
      );
      const batch = deriveDayAskPeaks(obSlice, tradeSlice, ASK_SEEDS, TODAY, OPEN_MS, '005930', BACKEND);
      expect(incremental).toEqual(batch);
    }
  });

  it.each([1, 7, 42, 1234])('bid: 청크 공급 결과가 배치와 동일하다 (seed %i)', (seed) => {
    const { obs, trades } = genStream(seed, 300);
    const source = new IncrementalPeakWallSource('bid');
    for (const cut of [0, 50, 51, 200, 300]) {
      const obSlice = obs.slice(0, cut);
      const tradeSlice = trades.slice(0, Math.min(cut, trades.length));
      const incremental = deriveDayBidPeaksIncremental(
        source, obSlice, tradeSlice, BID_SEEDS, TODAY, OPEN_MS, null,
      );
      const batch = deriveDayBidPeaks(obSlice, tradeSlice, BID_SEEDS, TODAY, OPEN_MS, '005930', null);
      expect(incremental).toEqual(batch);
    }
  });

  it('touch t_ms가 wall event t_ms와 정확히 같은 경계도 배치와 동일하다 (line 172 경계)', () => {
    const T = atKst(10, 0);
    // 최대 벽(qty 50000)이 시각 T, 정확히 같은 시각 T에 그 가격(26000)을 때리는 체결.
    const obs = [ob(T, [{ price: 26000, qty: 50000 }])];
    const trades = [tradeSnap(T, [{ t_ms: T, side: 1, price: 26000, qty: 100 }])];
    const source = new IncrementalPeakWallSource('ask');
    const incremental = deriveDayAskPeaksIncremental(source, obs, trades, ASK_SEEDS, TODAY, OPEN_MS, null);
    const batch = deriveDayAskPeaks(obs, trades, ASK_SEEDS, TODAY, OPEN_MS, '005930', null);
    expect(incremental).toEqual(batch);
    // 경계가 실제로 물리는지(판별성) 보증: T 시각 체결이 벽을 traded로 만들어 오늘 벽이 출력에 있어야 함.
    const today = incremental.find((p) => p.date === TODAY);
    expect(today?.qty).toBe(50000);
  });

  it('체결이 시간 역순으로 도착해도 배치와 동일하다 (분 극값은 순서 무관)', () => {
    // ADR-0084 시절엔 역순 도착이 정렬·lockstep argsort 를 요구했고, 그 정렬이
    // touchCounts 대응을 깨서 축출을 폴백시켰다. ADR-0156 의 분 극값은 순서에
    // 무관하므로 그 기계가 통째로 사라졌다 — 그래도 결과가 같아야 한다.
    const Ta = atKst(9, 30);   // 벽 A: 26000 / qty 50000 (분 570)
    const Tb = atKst(10, 0);   // 벽 B: 25000 / qty 40000 (분 600)
    const obs = [
      ob(Ta, [{ price: 26000, qty: 50000 }]),
      ob(Tb, [{ price: 25000, qty: 40000 }]),
    ];
    // 배열[0]=10:00:30(25000, 분 600), 배열[1]=9:30:15(30000, 분 570) — 역순 공급.
    const T2 = atKst(10, 0, 30);
    const T1 = atKst(9, 30, 15);
    const trades = [
      tradeSnap(T2, [{ t_ms: T2, side: 1, price: 25000, qty: 100 }]),
      tradeSnap(T1, [{ t_ms: T1, side: 1, price: 30000, qty: 100 }]),
    ];
    const source = new IncrementalPeakWallSource('ask');
    const incremental = deriveDayAskPeaksIncremental(source, obs, trades, ASK_SEEDS, TODAY, OPEN_MS, null);
    const batch = deriveDayAskPeaks(obs, trades, ASK_SEEDS, TODAY, OPEN_MS, '005930', null);
    expect(incremental).toEqual(batch);
    // 두 벽 모두 자기 분에서 지배당한다 → 큰 쪽(A, 50000)이 1위.
    const today = incremental.find((p) => p.date === TODAY);
    expect(today?.qty).toBe(50000);
  });

  it('prefix가 깨지면(배열 교체) 리셋 폴백으로 배치와 동일하다', () => {
    const a = genStream(11, 150);
    const b = genStream(22, 90); // 완전히 다른 스트림 = 종목 전환 모사
    const source = new IncrementalPeakWallSource('ask');
    deriveDayAskPeaksIncremental(source, a.obs, a.trades, ASK_SEEDS, TODAY, OPEN_MS, BACKEND);
    const incremental = deriveDayAskPeaksIncremental(source, b.obs, b.trades, ASK_SEEDS, TODAY, OPEN_MS, BACKEND);
    const batch = deriveDayAskPeaks(b.obs, b.trades, ASK_SEEDS, TODAY, OPEN_MS, '005930', BACKEND);
    expect(incremental).toEqual(batch);
  });

  it('배열이 줄어들어도(버퍼 리셋) 리셋 폴백으로 배치와 동일하다', () => {
    const { obs, trades } = genStream(33, 200);
    const source = new IncrementalPeakWallSource('ask');
    deriveDayAskPeaksIncremental(source, obs, trades, ASK_SEEDS, TODAY, OPEN_MS, BACKEND);
    const shrunkOb = obs.slice(0, 50);
    const shrunkTrade = trades.slice(0, 20);
    const incremental = deriveDayAskPeaksIncremental(source, shrunkOb, shrunkTrade, ASK_SEEDS, TODAY, OPEN_MS, BACKEND);
    const batch = deriveDayAskPeaks(shrunkOb, shrunkTrade, ASK_SEEDS, TODAY, OPEN_MS, '005930', BACKEND);
    expect(incremental).toEqual(batch);
  });
});

describe('IncrementalPeakWallSource — cutoff(as-of) 증분 = 배치 cutoff (ADR-0106)', () => {
  // 스트림의 ob 시각들에서 cutoff 후보를 뽑는다: 정확히 이벤트 시각 + 사이값 + 경계 밖.
  function cutoffCandidates(obs: ObSnapshot[]): number[] {
    if (obs.length === 0) return [atKst(9, 1)];
    const times = obs.map((o) => o.t_ms);
    const min = times[0];
    const max = times[times.length - 1];
    const mid = times[Math.floor(times.length / 2)];
    return [
      min - 1,          // 모든 이벤트 이전(빈 결과)
      min,              // 첫 이벤트 정확히
      mid,              // 중간(정확한 이벤트 시각)
      mid + 1,          // 중간 직후(사이값)
      max,              // 마지막 이벤트 정확히
      max + 10_000,     // 모든 이벤트 이후(cutoff 무효과)
    ];
  }

  it.each([1, 7, 42, 1234])('ask dayPeaks: cutoff 스윕이 배치와 동일 (seed %i)', (seed) => {
    const { obs, trades } = genStream(seed, 300);
    // 전체 누적 후 cutoff 를 오름차순·내림차순으로 스윕(팬 좌우 = cutoff 이동).
    const source = new IncrementalPeakWallSource('ask');
    const cuts = cutoffCandidates(obs);
    for (const cutoffMs of [...cuts, ...cuts.slice().reverse()]) {
      const incremental = deriveDayAskPeaksIncrementalAsOf(
        source, obs, trades, ASK_SEEDS, TODAY, OPEN_MS, BACKEND, cutoffMs,
      );
      const batch = deriveDayAskPeaks(
        obs, trades, ASK_SEEDS, TODAY, OPEN_MS, '005930', BACKEND, [], { date: TODAY, tMs: cutoffMs },
      );
      expect(incremental).toEqual(batch);
    }
  });

  it.each([1, 7, 42, 1234])('bid dayPeaks: cutoff 스윕이 배치와 동일 (seed %i)', (seed) => {
    const { obs, trades } = genStream(seed, 300);
    const source = new IncrementalPeakWallSource('bid');
    const cuts = cutoffCandidates(obs);
    for (const cutoffMs of [...cuts, ...cuts.slice().reverse()]) {
      const incremental = deriveDayBidPeaksIncrementalAsOf(
        source, obs, trades, BID_SEEDS, TODAY, OPEN_MS, null, cutoffMs,
      );
      const batch = deriveDayBidPeaks(
        obs, trades, BID_SEEDS, TODAY, OPEN_MS, '005930', null, [], { date: TODAY, tMs: cutoffMs },
      );
      expect(incremental).toEqual(batch);
    }
  });

  it('cutoff 증분: ob/trade 가 자라는 매 스텝에서 live-edge cutoff 가 배치와 동일', () => {
    // 팬 없이 실시간 뷰(cutoff=마지막 캔들 시각)에서 틱마다 성장하는 경우.
    const { obs, trades } = genStream(555, 200);
    const source = new IncrementalPeakWallSource('ask');
    for (const n of [1, 5, 20, 50, 120, 200]) {
      const obSlice = obs.slice(0, n);
      const tradeSlice = trades.slice(0, Math.min(n, trades.length));
      const cutoffMs = obSlice[obSlice.length - 1].t_ms; // live edge
      const incremental = deriveDayAskPeaksIncrementalAsOf(
        source, obSlice, tradeSlice, ASK_SEEDS, TODAY, OPEN_MS, BACKEND, cutoffMs,
      );
      const batch = deriveDayAskPeaks(
        obSlice, tradeSlice, ASK_SEEDS, TODAY, OPEN_MS, '005930', BACKEND, [], { date: TODAY, tMs: cutoffMs },
      );
      expect(incremental).toEqual(batch);
    }
  });

  it('경계: cutoff 가 벽·터치 시각과 정확히 같아도 배치와 동일(터치 재분류)', () => {
    const Twall = atKst(10, 0);
    const Ttouch = atKst(10, 0, 30);
    const obs = [ob(Twall, [{ price: 26000, qty: 50000 }])];
    const trades = [tradeSnap(Ttouch, [{ t_ms: Ttouch, side: 1, price: 26000, qty: 100 }])];
    const source = new IncrementalPeakWallSource('ask');
    // cutoff 가 터치 직전 → 터치 아님, 터치 시각 이상 → 터치. 두 경우 모두 배치와 일치.
    for (const cutoffMs of [Twall, Ttouch - 1, Ttouch, Ttouch + 1]) {
      const incremental = deriveDayAskPeaksIncrementalAsOf(source, obs, trades, ASK_SEEDS, TODAY, OPEN_MS, null, cutoffMs);
      const batch = deriveDayAskPeaks(obs, trades, ASK_SEEDS, TODAY, OPEN_MS, '005930', null, [], { date: TODAY, tMs: cutoffMs });
      expect(incremental).toEqual(batch);
    }
  });
});
