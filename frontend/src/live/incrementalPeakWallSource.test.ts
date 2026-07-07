import { describe, it, expect } from 'vitest';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import {
  deriveDayAskPeaks,
  deriveDayAskPeaksIncremental,
  deriveTodayAllPriceAskPeak,
  deriveTodayAllPriceAskPeakIncremental,
} from './useDayAskPeaks';
import {
  deriveDayBidPeaks,
  deriveDayBidPeaksIncremental,
  deriveTodayAllPriceBidPeak,
  deriveTodayAllPriceBidPeakIncremental,
} from './useDayBidPeaks';
import type { AskPeak, BidPeak } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const TODAY = '20260613';
const atKst = (hh: number, mm = 0, ss = 0) => Date.UTC(2026, 5, 13, hh - 9, mm, ss);

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
  traded_prices: [25500],
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
        source, obSlice, tradeSlice, ASK_SEEDS, TODAY, BACKEND,
      );
      const batch = deriveDayAskPeaks(obSlice, tradeSlice, ASK_SEEDS, TODAY, '005930', BACKEND);
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
        source, obSlice, tradeSlice, BID_SEEDS, TODAY, null,
      );
      const batch = deriveDayBidPeaks(obSlice, tradeSlice, BID_SEEDS, TODAY, '005930', null);
      expect(incremental).toEqual(batch);
    }
  });

  it('todayAllPrice(ask): 터치 없는 all 패밀리도 배치와 동일하다', () => {
    const { obs } = genStream(99, 200);
    const source = new IncrementalPeakWallSource('ask');
    for (const cut of [0, 80, 200]) {
      const obSlice = obs.slice(0, cut);
      const incremental = deriveTodayAllPriceAskPeakIncremental(source, obSlice, ASK_SEEDS, TODAY, BACKEND);
      const batch = deriveTodayAllPriceAskPeak(obSlice, ASK_SEEDS, TODAY, '005930', BACKEND);
      expect(incremental).toEqual(batch);
    }
  });

  it('todayAllPrice(bid): 터치 없는 all 패밀리도 배치와 동일하다', () => {
    const { obs } = genStream(99, 200);
    const source = new IncrementalPeakWallSource('bid');
    for (const cut of [0, 80, 200]) {
      const obSlice = obs.slice(0, cut);
      const incremental = deriveTodayAllPriceBidPeakIncremental(source, obSlice, BID_SEEDS, TODAY, null);
      const batch = deriveTodayAllPriceBidPeak(obSlice, BID_SEEDS, TODAY, '005930', null);
      expect(incremental).toEqual(batch);
    }
  });

  it('backend가 null이어도(seed 폴백 경로) 동일하다', () => {
    const { obs } = genStream(5, 100);
    const source = new IncrementalPeakWallSource('ask');
    const incremental = deriveTodayAllPriceAskPeakIncremental(source, obs, ASK_SEEDS, TODAY, null);
    const batch = deriveTodayAllPriceAskPeak(obs, ASK_SEEDS, TODAY, '005930', null);
    expect(incremental).toEqual(batch);
  });

  it('prefix가 깨지면(배열 교체) 리셋 폴백으로 배치와 동일하다', () => {
    const a = genStream(11, 150);
    const b = genStream(22, 90); // 완전히 다른 스트림 = 종목 전환 모사
    const source = new IncrementalPeakWallSource('ask');
    deriveDayAskPeaksIncremental(source, a.obs, a.trades, ASK_SEEDS, TODAY, BACKEND);
    const incremental = deriveDayAskPeaksIncremental(source, b.obs, b.trades, ASK_SEEDS, TODAY, BACKEND);
    const batch = deriveDayAskPeaks(b.obs, b.trades, ASK_SEEDS, TODAY, '005930', BACKEND);
    expect(incremental).toEqual(batch);
  });

  it('배열이 줄어들어도(버퍼 리셋) 리셋 폴백으로 배치와 동일하다', () => {
    const { obs, trades } = genStream(33, 200);
    const source = new IncrementalPeakWallSource('ask');
    deriveDayAskPeaksIncremental(source, obs, trades, ASK_SEEDS, TODAY, BACKEND);
    const shrunkOb = obs.slice(0, 50);
    const shrunkTrade = trades.slice(0, 20);
    const incremental = deriveDayAskPeaksIncremental(source, shrunkOb, shrunkTrade, ASK_SEEDS, TODAY, BACKEND);
    const batch = deriveDayAskPeaks(shrunkOb, shrunkTrade, ASK_SEEDS, TODAY, '005930', BACKEND);
    expect(incremental).toEqual(batch);
  });
});
