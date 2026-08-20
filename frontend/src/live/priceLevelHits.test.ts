import { describe, expect, it } from 'vitest';
import type { Candle, PriceLevelHit } from '../api/types';
import { buildLivePriceLevelHits, mergePriceLevelHits } from './priceLevelHits';

const todayOpen = Date.UTC(2026, 5, 24, 0, 0, 0);
const yesterdayOpen = Date.UTC(2026, 5, 23, 0, 0, 0);

function candle(ts_ms: number, open: number, close = open): Candle {
  return { ts_ms, open, high: open, low: open, close, vol_a: 0, vol_b: 0 };
}

function candleRange(ts_ms: number, open: number, high: number, low: number, close = open): Candle {
  return { ts_ms, open, high, low, close, vol_a: 0, vol_b: 0 };
}

describe('priceLevelHits', () => {
  it('builds live VI and limit hits from candle high/low touches', () => {
    const candles = [
      candle(yesterdayOpen + 60_000, 9_700, 10_000),
      candleRange(todayOpen + 60_000, 10_000, 10_900, 9_500),
      candleRange(todayOpen + 120_000, 10_800, 11_100, 10_700),
      candleRange(todayOpen + 180_000, 11_500, 12_100, 11_400),
      candleRange(todayOpen + 240_000, 12_000, 13_100, 11_900),
      candleRange(todayOpen + 300_000, 12_500, 12_600, 6_900),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 120_000],
      ['vi', 'lower', 10, 9_000, todayOpen + 300_000],
      ['limit', 'upper', 30, 13_000, todayOpen + 240_000],
      ['limit', 'lower', 30, 7_000, todayOpen + 300_000],
    ]);
  });

  it('keeps the first candle that touches a level', () => {
    const candles = [
      candleRange(todayOpen + 60_000, 10_000, 10_999, 9_900),
      candleRange(todayOpen + 120_000, 10_900, 11_001, 10_800),
      candleRange(todayOpen + 180_000, 11_000, 11_500, 10_900),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 120_000],
    ]);
  });

  it('uses the first post-VI cooling candle open as the second VI basis', () => {
    const candles = [
      candleRange(todayOpen, 10_000, 10_500, 9_500),
      candleRange(todayOpen + 60_000, 10_500, 11_000, 10_400),
      candleRange(todayOpen + 120_000, 11_000, 11_100, 10_900),
      candleRange(todayOpen + 180_000, 11_500, 12_600, 11_400),
      candleRange(todayOpen + 240_000, 12_500, 12_700, 12_400),
      candleRange(todayOpen + 300_000, 12_650, 12_700, 9_000),
      candleRange(todayOpen + 360_000, 9_000, 9_100, 8_800),
      candleRange(todayOpen + 420_000, 8_500, 8_600, 7_900),
      candleRange(todayOpen + 480_000, 8_000, 8_100, 7_650),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 60_000],
      ['vi', 'upper', 20, 12_650, todayOpen + 240_000],
      ['vi', 'lower', 10, 9_000, todayOpen + 300_000],
      ['vi', 'lower', 20, 7_650, todayOpen + 480_000],
    ]);
  });

  it('uses KRX tick-adjusted trigger prices instead of raw rounded percentages', () => {
    const candles = [
      candle(yesterdayOpen + 60_000, 23_000, 24_200),
      candleRange(todayOpen + 60_000, 29_100, 32_060, 29_000),
      candleRange(todayOpen + 120_000, 32_000, 32_010, 26_140),
      candleRange(todayOpen + 180_000, 26_200, 31_460, 26_100),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 32_050, todayOpen + 60_000],
      ['vi', 'upper', 20, 28_850, todayOpen + 180_000],
      ['vi', 'lower', 10, 26_150, todayOpen + 120_000],
      ['limit', 'upper', 30, 31_450, todayOpen + 60_000],
    ]);
  });

  it('dedupes backend and live hits by date price kind direction pct', () => {
    const backend: PriceLevelHit[] = [{
      date: '20260624',
      t_ms: todayOpen + 60_000,
      price: 11_000,
      kind: 'vi',
      direction: 'upper',
      pct: 10,
    }];
    const live: PriceLevelHit[] = [{
      ...backend[0],
      t_ms: todayOpen + 120_000,
    }];

    expect(mergePriceLevelHits(backend, live)).toEqual(backend);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 오늘 구간 찾기·직전 종가 찾기를 "전체 filter" 에서 "이진 탐색 + 오늘 구간 slice" 로
  // 바꿨다(90일 8.15ms/틱 → 0.065ms/틱). 두 계약이 그 교체의 표적이다:
  //   ① 오늘이 아닌 캔들이 도달 판정에 **섞이면 안 된다**
  //   ② 직전 종가는 **오늘 바로 앞 캔들**의 종가다(첫 캔들도, 며칠 전 캔들도 아니다)
  // 각 케이스는 잘못 짚었을 때 값이 실제로 달라지도록 세웠다 — 그렇지 않으면 통과해도
  // 아무것도 증명하지 못한다.
  describe('오늘 구간 슬라이스 · 직전 종가', () => {
    const twoDaysAgoOpen = Date.UTC(2026, 5, 22, 0, 0, 0);

    it('직전일 캔들이 상한가를 건드려도 오늘 히트로 잡지 않는다', () => {
      const candles = [
        // 어제 고가가 13,000 을 넘지만 어제 캔들이라 후보가 아니다. 오늘은 안 닿는다.
        candleRange(yesterdayOpen + 60_000, 10_000, 14_000, 9_900, 10_000),
        candleRange(todayOpen + 60_000, 10_000, 10_100, 9_950),
      ];
      expect(buildLivePriceLevelHits(candles, '20260624')).toEqual([]);
    });

    it('직전 종가는 오늘 **바로 앞** 캔들의 종가 — 더 과거 캔들이 아니다', () => {
      const candles = [
        // 이틀 전 종가 20,000 (여기서 기준을 잡으면 상한가가 26,000 이라 안 닿는다)
        candle(twoDaysAgoOpen + 60_000, 20_000, 20_000),
        // 어제 종가 10,000 → 상한가 13,000 · 하한가 7,000
        candle(yesterdayOpen + 60_000, 10_000, 10_000),
        candleRange(todayOpen + 60_000, 12_000, 13_100, 6_900),
      ];
      // VI 히트는 오늘 시가에서 파생돼 이 계약과 무관하다 — limit 만 본다.
      const limits = buildLivePriceLevelHits(candles, '20260624').filter((h) => h.kind === 'limit');
      expect(limits.map((h) => [h.direction, h.pct, h.price]))
        .toEqual([['upper', 30, 13_000], ['lower', 30, 7_000]]);
    });

    it('직전 거래일이 비어 있어도(며칠 건너뜀) 배열에서 바로 앞 캔들을 쓴다', () => {
      const candles = [
        candle(twoDaysAgoOpen + 60_000, 10_000, 10_000), // 어제 캔들 없음
        candleRange(todayOpen + 60_000, 12_000, 13_100, 6_900),
      ];
      // VI 히트는 오늘 시가에서 파생돼 이 계약과 무관하다 — limit 만 본다.
      const limits = buildLivePriceLevelHits(candles, '20260624').filter((h) => h.kind === 'limit');
      expect(limits.map((h) => [h.direction, h.pct, h.price]))
        .toEqual([['upper', 30, 13_000], ['lower', 30, 7_000]]);
    });

    it('오늘이 첫 거래일이면 직전 종가가 없어 상·하한가 후보가 없다', () => {
      const candles = [candleRange(todayOpen + 60_000, 12_000, 13_100, 6_900)];
      expect(buildLivePriceLevelHits(candles, '20260624').every((h) => h.kind === 'vi')).toBe(true);
    });

    it('오늘 캔들이 하나도 없으면 빈 배열', () => {
      const candles = [candle(yesterdayOpen + 60_000, 10_000, 10_000)];
      expect(buildLivePriceLevelHits(candles, '20260624')).toEqual([]);
    });
  });
});
