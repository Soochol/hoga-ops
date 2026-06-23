import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayAskPeaks, useTodayAllPriceAskPeak } from './useDayAskPeaks';
import type { AskPeak, Candle } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const deep = (t_ms: number, q: number, price = 26000): ObSnapshot => ({
  t_ms, total_ask_qty: 0, total_bid_qty: 0,
  asks: [{ price, qty: q }, ...Array.from({ length: 9 }, () => ({ price: 1, qty: 1 }))],
  bids: Array.from({ length: 10 }, (_, i) => ({ price: 24000 - i, qty: 100 })),
});

const byDate = (peaks: readonly AskPeak[]) => {
  const out: Record<string, AskPeak> = {};
  for (const peak of peaks) {
    const current = out[peak.date];
    if (!current || peak.qty > current.qty) out[peak.date] = peak;
  }
  return out;
};
const atKst = (hh: number, mm = 0) => Date.UTC(2026, 5, 13, hh - 9, mm);
const candle = (t_ms: number, low: number, high: number): Candle => ({
  ts_ms: t_ms,
  open: low,
  high,
  low,
  close: high,
  vol_a: 1,
  vol_b: 0,
});

const todayAskPeak = (overrides: Partial<LiveTodayAskPeak> = {}): LiveTodayAskPeak => ({
  date: '20260613',
  coverage: 'partial',
  traded_prices: [25500],
  traded_price: 25500,
  traded_qty: 9000,
  traded_t_ms: atKst(9, 10),
  all_price: 26000,
  all_qty: 12000,
  all_t_ms: atKst(9, 11),
  ...overrides,
});

const trade = (
  t_ms: number,
  trades: TradeSnapshot['trades'],
): TradeSnapshot => ({ t_ms, trades });

describe('useDayAskPeaks', () => {
  it('과거일 seed는 그대로 통과, 오늘 기준선은 체결된 가격의 live.ob로 ratchet', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
        max_price: 300000, max_qty: 40000, max_t_ms: 11 },
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
        max_price: 25100, max_qty: 5000, max_t_ms: 2 },
    ];
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, seeds, '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );
    let m = byDate(result.current);
    expect(m['20260611'].qty).toBe(32621); // 과거일 그대로
    expect(m['20260613']).toBeUndefined(); // 오늘 seed는 체결가격 기준선으로 쓰지 않음

    const t = atKst(9, 20);
    rerender({
      ob: [deep(t + 1_000, 9000)],
      trades: [trade(t, [{ t_ms: t, side: 1, price: 26000, qty: 10 }])],
    });
    m = byDate(result.current);
    expect(m['20260611'].qty).toBe(32621); // 과거일 불변
    expect(m['20260613'].qty).toBe(9000); // 오늘 체결가격 기준 ratchet 전진
    expect(m['20260613'].date).toBe('20260613');
    expect(m['20260611'].max_qty).toBe(40000); // 과거일 seed의 max_* 그대로 통과
  });

  it('오늘 seed 없어도 체결된 가격의 live.ob 신기록이면 오늘 항목 생성', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
        max_price: 300000, max_qty: 40000, max_t_ms: 11 },
    ];
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, seeds, '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );
    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();
    const t = atKst(9, 20);
    rerender({
      ob: [deep(t + 1_000, 7000)],
      trades: [trade(t, [{ t_ms: t, side: -1, price: 26000, qty: 10 }])],
    });
    expect(result.current.find((p) => p.date === '20260613')?.qty).toBe(7000);
  });

  it('오늘 entry는 close triple과 max triple이 동일(ratchet 동일값 — 토글 무효)', () => {
    const seeds: AskPeak[] = [
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
        max_price: 25100, max_qty: 5000, max_t_ms: 2 },
    ];
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, seeds, '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );
    const t = atKst(9, 20);
    rerender({
      ob: [deep(t + 1_000, 9000, 26500)],
      trades: [trade(t, [{ t_ms: t, side: 1, price: 26500, qty: 10 }])],
    });
    const today = byDate(result.current)['20260613'];
    expect(today.qty).toBe(9000);
    expect(today.max_qty).toBe(today.qty);
    expect(today.max_price).toBe(today.price);
    expect(today.max_t_ms).toBe(today.t_ms);
  });

  it('backend today payload가 있으면 traded triple로 오늘 기준선을 만들고 과거 seed는 보존', () => {
    const seeds: AskPeak[] = [
      { date: '20260611', price: 297000, qty: 32621, t_ms: 1,
        max_price: 300000, max_qty: 40000, max_t_ms: 11 },
      { date: '20260613', price: 25100, qty: 5000, t_ms: 2,
        max_price: 25100, max_qty: 5000, max_t_ms: 2 },
    ];
    const restPeak = todayAskPeak({
      traded_t_ms: 3,
      all_t_ms: 4,
    });

    const { result } = renderHook(
      () => useDayAskPeaks([deep(5, 15000)], [], seeds, '20260613', '005930', restPeak),
    );

    const m = byDate(result.current);
    expect(m['20260611']).toEqual(seeds[0]);
    expect(m['20260613']).toEqual({
      date: '20260613',
      price: 25500,
      qty: 9000,
      t_ms: 3,
      max_price: 25500,
      max_qty: 9000,
      max_t_ms: 3,
    });
  });

  it('backend today payload의 traded_peaks를 체결가격 기준 후보 목록으로 보존한다', () => {
    const restPeak = todayAskPeak({
      traded_peaks: [
        { price: 25500, qty: 9000, t_ms: 3 },
        { price: 25600, qty: 8000, t_ms: 4 },
        { price: 25700, qty: 7000, t_ms: 5 },
      ],
    });

    const { result } = renderHook(
      () => useDayAskPeaks([], [], [], '20260613', '005930', restPeak),
    );

    expect(result.current).toEqual([
      { date: '20260613', price: 25500, qty: 9000, t_ms: 3, max_price: 25500, max_qty: 9000, max_t_ms: 3 },
      { date: '20260613', price: 25600, qty: 8000, t_ms: 4, max_price: 25600, max_qty: 8000, max_t_ms: 4 },
      { date: '20260613', price: 25700, qty: 7000, t_ms: 5, max_price: 25700, max_qty: 7000, max_t_ms: 5 },
    ]);
  });

  it('backend today payload에 traded peak가 없으면 오늘 기준선을 만들지 않는다', () => {
    const restPeak = todayAskPeak({
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
      all_t_ms: 4,
    });

    const { result } = renderHook(
      () => useDayAskPeaks([deep(5, 15000)], [], [], '20260613', '005930', restPeak),
    );

    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();
  });

  it('backend all-price peak가 REST 캔들 범위 안이면 체결 기준선으로 승격한다', () => {
    const restPeak = todayAskPeak({
      traded_prices: [],
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
      all_price: 27000,
      all_qty: 12000,
      all_t_ms: atKst(10, 42),
    });

    const { result } = renderHook(
      () => useDayAskPeaks(
        [],
        [],
        [],
        '20260613',
        '005930',
        restPeak,
        [candle(atKst(10, 42), 26900, 27100)],
      ),
    );

    expect(byDate(result.current)['20260613']).toEqual({
      date: '20260613',
      price: 27000,
      qty: 12000,
      t_ms: atKst(10, 42),
      max_price: 27000,
      max_qty: 12000,
      max_t_ms: atKst(10, 42),
    });
  });

  it('WS trade가 없어도 REST 캔들 범위 안의 live.ob 벽은 체결 기준선 후보가 된다', () => {
    const { result, rerender } = renderHook(
      ({ ob, candles }: { ob: ObSnapshot[]; candles: Candle[] }) =>
        useDayAskPeaks(ob, [], [], '20260613', '005930', null, candles),
      { initialProps: { ob: [] as ObSnapshot[], candles: [] as Candle[] } },
    );

    rerender({
      ob: [deep(atKst(10, 42), 12000, 27000)],
      candles: [candle(atKst(10, 42), 26900, 27100)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 12000,
      t_ms: atKst(10, 42),
    });
  });

  it('캔들 범위가 좁아지면 캔들로만 허용된 live.ob 벽은 오늘 후보에서 제외한다', () => {
    const ob = [deep(atKst(10, 42), 12000, 27000)];
    const { result, rerender } = renderHook(
      ({ candles }: { candles: Candle[] }) =>
        useDayAskPeaks(ob, [], [], '20260613', '005930', null, candles),
      { initialProps: { candles: [candle(atKst(10, 42), 26900, 27100)] } },
    );

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 12000,
    });

    rerender({ candles: [candle(atKst(10, 43), 28000, 28100)] });

    expect(byDate(result.current)['20260613']).toBeUndefined();
  });

  it('REST today seed keeps updating traded baseline from later trade prices and OB walls', () => {
    const restPeak = todayAskPeak();
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    expect(byDate(result.current)['20260613']?.qty).toBe(9000);

    rerender({
      trades: [trade(atKst(9, 20), [{ t_ms: atKst(9, 20), side: 1, price: 27000, qty: 10 }])],
      ob: [deep(atKst(9, 21), 20000, 27000)],
    });

    const today = byDate(result.current)['20260613'];
    expect(today).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: atKst(9, 21),
      max_price: 27000,
      max_qty: 20000,
      max_t_ms: atKst(9, 21),
    });
  });

  it('retroactively promotes a previously seen wall once that price trades later', () => {
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [],
      ob: [deep(atKst(9, 20), 20000, 27000)],
    });
    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();

    rerender({
      trades: [trade(atKst(9, 21), [{ t_ms: atKst(9, 21), side: 1, price: 27000, qty: 10 }])],
      ob: [deep(atKst(9, 20), 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: atKst(9, 20),
    });
  });

  it('seeds all backend-traded prices so pre-load non-peak prices remain eligible', () => {
    const restPeak = todayAskPeak({
      traded_prices: [25500, 27000],
      traded_price: 25500,
      traded_qty: 9000,
      traded_t_ms: atKst(9, 10),
    });
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [],
      ob: [deep(atKst(9, 21), 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: atKst(9, 21),
    });
  });

  it('ignores trade events without numeric prices when updating traded baseline', () => {
    const restPeak = todayAskPeak();
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [trade(atKst(9, 20), [{ t_ms: atKst(9, 20), side: 1, qty: 10 }])],
      ob: [deep(atKst(9, 21), 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']?.qty).toBe(9000);
  });

  it('same-second trade snapshots all contribute prices to traded baseline', () => {
    const restPeak = todayAskPeak();
    const sameSecond = atKst(9, 20);
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayAskPeaks(ob, trades, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [
        trade(sameSecond, [{ t_ms: sameSecond, side: 1, price: 26900, qty: 10 }]),
        trade(sameSecond, [{ t_ms: sameSecond, side: 1, price: 27000, qty: 10 }]),
      ],
      ob: [deep(atKst(9, 21), 20000, 27000)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 27000,
      qty: 20000,
      t_ms: atKst(9, 21),
    });
  });

  it('omits today traded baseline when no traded peak exists even though all-price REST data exists', () => {
    const restPeak = todayAskPeak({
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
    });

    const { result } = renderHook(
      () => useDayAskPeaks([], [], [], '20260613', '005930', restPeak),
    );

    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();
  });

  it('all-price peak keeps advancing from later OB walls after REST seed', () => {
    const restPeak = todayAskPeak();
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) =>
        useTodayAllPriceAskPeak(ob, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );

    expect(result.current?.qty).toBe(12000);

    rerender({ ob: [deep(atKst(9, 25), 25000, 28000)] });

    expect(result.current).toMatchObject({
      date: '20260613',
      price: 28000,
      qty: 25000,
      t_ms: atKst(9, 25),
      max_price: 28000,
      max_qty: 25000,
      max_t_ms: atKst(9, 25),
    });
  });

  it('all-price peak ignores collapsed 3-level auction/VI books', () => {
    const restPeak = todayAskPeak();
    const collapsed: ObSnapshot = {
      t_ms: atKst(10, 0),
      total_ask_qty: 100001,
      total_bid_qty: 3,
      asks: [
        { price: 29000, qty: 99999 },
        { price: 29100, qty: 1 },
        { price: 29200, qty: 1 },
        ...Array.from({ length: 7 }, () => ({ price: 0, qty: 0 })),
      ],
      bids: [
        { price: 28900, qty: 1 },
        { price: 28800, qty: 1 },
        { price: 28700, qty: 1 },
        ...Array.from({ length: 7 }, () => ({ price: 0, qty: 0 })),
      ],
    };
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) =>
        useTodayAllPriceAskPeak(ob, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );

    expect(result.current?.qty).toBe(12000);
    rerender({ ob: [collapsed] });

    expect(result.current).toMatchObject({
      price: 26000,
      qty: 12000,
    });
  });

  it('all-price peak ignores one-sided collapsed ask books even when bids remain deep', () => {
    const restPeak = todayAskPeak();
    const oneSidedCollapsed: ObSnapshot = {
      t_ms: atKst(10, 0),
      total_ask_qty: 100001,
      total_bid_qty: 1000,
      asks: [
        { price: 29000, qty: 99999 },
        { price: 29100, qty: 1 },
        { price: 29200, qty: 1 },
        ...Array.from({ length: 7 }, () => ({ price: 0, qty: 0 })),
      ],
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 28900 - i * 100, qty: 100 })),
    };
    const { result, rerender } = renderHook(
      ({ ob }: { ob: ObSnapshot[] }) =>
        useTodayAllPriceAskPeak(ob, [], '20260613', '005930', restPeak),
      { initialProps: { ob: [] as ObSnapshot[] } },
    );

    rerender({ ob: [oneSidedCollapsed] });

    expect(result.current).toMatchObject({
      price: 26000,
      qty: 12000,
    });
  });

  it('keeps live ask peak updates responsive with many candles and repeated prices', () => {
    const base = Date.UTC(2026, 5, 13, 0, 0, 0);
    const candles = Array.from({ length: 2500 }, (_, i) =>
      candle(base + (i % 300) * 60_000, 20_000 + i * 10, 20_005 + i * 10),
    );
    const ob = Array.from({ length: 2000 }, (_, i): ObSnapshot => ({
      t_ms: base + i * 1000,
      total_ask_qty: 1,
      total_bid_qty: 1,
      asks: Array.from({ length: 10 }, (_unused, level) => ({
        price: 40_000 + level,
        qty: 100 + i + level,
      })),
      bids: Array.from({ length: 10 }, (_unused, level) => ({
        price: 39_000 - level,
        qty: 100 + i + level,
      })),
    }));

    const started = performance.now();
    const { result } = renderHook(() =>
      useDayAskPeaks(ob, [], [], '20260613', '005930', null, candles),
    );
    const elapsed = performance.now() - started;

    expect(result.current.at(-1)?.price).toBeGreaterThanOrEqual(40_000);
    expect(elapsed).toBeLessThan(500);
  });
});
