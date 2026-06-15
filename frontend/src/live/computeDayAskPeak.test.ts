import { describe, it, expect } from 'vitest';
import { foldAskPeak, reduceDayAskPeak, type RatchetState } from './computeDayAskPeak';
import type { ObSnapshot } from './bucketHogaSeries';

const t = (h: number, m = 0) => Date.UTC(2026, 5, 13, h - 9, m); // KST 시각의 unix ms

// 깊은(연속거래) 호가창: asks 길이 10, 레벨4+ qty>0
function deepOb(t_ms: number, asks: Array<[number, number]>): ObSnapshot {
  return {
    t_ms, total_ask_qty: 0, total_bid_qty: 0,
    asks: asks.map(([price, qty]) => ({ price, qty })),
    bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
  };
}

// asks 없는 ObSnapshot(totals-only) — seed-only와 거래일경계 리셋 케이스에 사용
const noAsks = (t_ms: number): ObSnapshot => ({ t_ms, total_ask_qty: 0, total_bid_qty: 0 });

const FRESH: RatchetState = { peak: null, tradingDay: -1, lastTMs: -1 };

describe('foldAskPeak', () => {
  it('seed-only: 버퍼 빈, seed 유지', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    const s = foldAskPeak(FRESH, seed, noAsks(t(9, 1)));
    expect(s.peak).toEqual(seed);
  });

  it('버퍼 신기록이 seed 초과 → 교체', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    const ob = deepOb(t(10), [[26000, 9000], [25000, 10], ...Array(8).fill([0, 0])] as Array<[number, number]>);
    const s = foldAskPeak(FRESH, seed, ob);
    expect(s.peak).toEqual({ price: 26000, qty: 9000, t_ms: t(10) });
  });

  it('단조: 큰 값 뒤 작은 값 무시', () => {
    const seed = null;
    let s = foldAskPeak(FRESH, seed, deepOb(t(10), [[26000, 9000], ...Array(9).fill([1, 1])] as Array<[number, number]>));
    s = foldAskPeak(s, seed, deepOb(t(11), [[25000, 100], ...Array(9).fill([1, 1])] as Array<[number, number]>));
    expect(s.peak!.qty).toBe(9000);
  });

  it('붕괴 호가창(isContinuousBook=false) 스킵', () => {
    const seed = null;
    const collapsed: ObSnapshot = {
      t_ms: t(15, 21), total_ask_qty: 0, total_bid_qty: 0,
      asks: [{ price: 25000, qty: 99999 }, { price: 25050, qty: 1 }, { price: 25100, qty: 1 },
             ...Array(7).fill({ price: 0, qty: 0 })],
      bids: [{ price: 24000, qty: 1 }, { price: 23950, qty: 1 }, { price: 23900, qty: 1 },
             ...Array(7).fill({ price: 0, qty: 0 })],
    };
    const s = foldAskPeak(FRESH, seed, collapsed);
    expect(s.peak).toBeNull(); // 99999 무시
  });

  it('개장 동시호가(<09:00)는 깊은 호가창이어도 배제', () => {
    // 08:55 개장 동시호가: 10레벨 누적이라 isContinuousBook은 통과하지만(레벨4+ qty>0),
    // 시각 게이트(isAfterRegularOpen)로 배제 — 보통 그날 최대 누적이라 게이트 없으면 가로챈다.
    const preOpen = deepOb(t(8, 55), [[24000, 99999], ...Array(9).fill([1, 1])] as Array<[number, number]>);
    const s = foldAskPeak(FRESH, null, preOpen);
    expect(s.peak).toBeNull(); // 개장 99999 무시
    // 이어지는 09:10 연속거래의 실제 벽은 반영.
    const s2 = foldAskPeak(s, null, deepOb(t(9, 10), [[25000, 300], ...Array(9).fill([1, 1])] as Array<[number, number]>));
    expect(s2.peak).toEqual({ price: 25000, qty: 300, t_ms: t(9, 10) });
  });

  it('동률은 먼저 것 유지', () => {
    const seed = { price: 25500, qty: 7000, t_ms: t(9) };
    const ob = deepOb(t(10), [[26000, 7000], ...Array(9).fill([1, 1])] as Array<[number, number]>);
    const s = foldAskPeak(FRESH, seed, ob);
    expect(s.peak!.price).toBe(25500); // 동률 비교체
  });

  it('거래일 경계: 리셋 후 재시드', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    let s: RatchetState = { peak: { price: 99, qty: 99999, t_ms: t(9) - 86_400_000 },
                            tradingDay: 0, lastTMs: t(9) - 86_400_000 };
    s = foldAskPeak(s, seed, noAsks(t(9, 1)));
    expect(s.peak).toEqual(seed); // 어제 99999 버리고 오늘 seed로
  });

  it('증분 멱등: 이미 fold한 tMs 이하 재공급 무시', () => {
    const seed = null;
    const ob = deepOb(t(10), [[26000, 9000], ...Array(9).fill([1, 1])] as Array<[number, number]>);
    let s = foldAskPeak(FRESH, seed, ob);
    s = foldAskPeak(s, seed, ob); // 같은 tMs
    expect(s.peak!.qty).toBe(9000);
  });
});

describe('reduceDayAskPeak (배치 reducer — 당일 peak 규칙 전체 소유)', () => {
  const mk = (tMs: number, price: number, qty: number): ObSnapshot =>
    deepOb(tMs, [[price, qty], ...Array(9).fill([1, 1])] as Array<[number, number]>);

  it('빈 배치: seed가 하한 → peak=seed', () => {
    const seed = { price: 25100, qty: 5000, t_ms: t(9) };
    expect(reduceDayAskPeak(FRESH, seed, []).peak).toEqual(seed);
    expect(reduceDayAskPeak(FRESH, null, []).peak).toBeNull();
  });

  it('배치 내 최대 단계를 집계', () => {
    const obs = [mk(t(10), 26000, 3000), mk(t(10, 1), 25500, 8000), mk(t(10, 2), 25800, 4000)];
    expect(reduceDayAskPeak(FRESH, null, obs).peak).toEqual({ price: 25500, qty: 8000, t_ms: t(10, 1) });
  });

  it('seed 하한: 배치보다 큰 seed가 늦게 와도 반영', () => {
    const seed = { price: 24000, qty: 9000, t_ms: t(9) };
    expect(reduceDayAskPeak(FRESH, seed, [mk(t(10), 26000, 6000)]).peak).toEqual(seed); // 9000 > 6000
  });

  it('seed 동률은 더 이른 seed 유지(strict >)', () => {
    const seed = { price: 24000, qty: 6000, t_ms: t(9) };
    // seed(09:00)와 배치(10:00) qty 동률 → 먼저 도달한 seed 유지
    expect(reduceDayAskPeak(FRESH, seed, [mk(t(10), 26000, 6000)]).peak!.price).toBe(24000);
  });

  it('배치 간 단조: 이전 상태 이어받아 더 작은 후속 배치는 무시', () => {
    let s = reduceDayAskPeak(FRESH, null, [mk(t(10), 26000, 9000)]);
    s = reduceDayAskPeak(s, null, [mk(t(11), 25000, 100)]);
    expect(s.peak!.qty).toBe(9000);
  });
});
