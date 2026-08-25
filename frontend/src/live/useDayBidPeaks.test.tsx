import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayBidPeaks } from './useDayBidPeaks';
import type { BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const deep = (
  t_ms: number,
  levels: Array<[number, number]>,
): ObSnapshot => ({
  t_ms,
  total_ask_qty: 0,
  total_bid_qty: 0,
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 25000 + i, qty: 100 })),
  bids: levels.map(([price, qty]) => ({ price, qty })),
});

const byDate = (peaks: readonly BidPeak[]) => Object.fromEntries(peaks.map((p) => [p.date, p]));
const atKst = (hh: number, mm = 0) => Date.UTC(2026, 5, 13, hh - 9, mm);
// 개장 하한(09:00 KST) — 필수 인자화 경위는 computeDayAskPeak.test 의 같은 상수 참조.
const OPEN_MS = atKst(9);
const candle = (t_ms: number, low: number, high: number): Candle => ({
  ts_ms: t_ms,
  open: high,
  high,
  low,
  close: low,
  vol_a: 1,
  vol_b: 0,
});
const trade = (t_ms: number, trades: TradeSnapshot['trades']): TradeSnapshot => ({ t_ms, trades });

const todayBidPeak = (overrides: Partial<LiveTodayBidPeak> = {}): LiveTodayBidPeak => ({
  date: '20260613',
  coverage: 'partial',
  traded_price: 23900,
  traded_qty: 9000,
  traded_t_ms: atKst(9, 10),
  all_price: 23800,
  all_qty: 12000,
  all_t_ms: atKst(9, 11),
  ...overrides,
});

describe('useDayBidPeaks', () => {
  it('only promotes bid walls touched in their own minute, even when a larger one exists', () => {
    const { result } = renderHook(() => useDayBidPeaks(
      [
        deep(atKst(9, 20), [
          [23850, 15000],
          [23900, 9000],
          ...Array(8).fill([1, 1]),
        ] as Array<[number, number]>),
      ],
      [trade(atKst(9, 20) + 30_000, [
        { t_ms: atKst(9, 20) + 30_000, side: 1, price: 23900, qty: 10 },
      ])],
      [],
      '20260613',
      OPEN_MS,
      '005930',
    ));

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23900,
      qty: 9000,
      t_ms: atKst(9, 20),
    });
  });

  it('promotes REST all-price bid peaks when the price falls inside a today candle range', () => {
    const restPeak = todayBidPeak({
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
      all_price: 23800,
      all_qty: 12000,
      all_t_ms: atKst(10, 42),
    });

    const { result } = renderHook(() => useDayBidPeaks(
      [],
      [],
      [],
      '20260613', OPEN_MS,
      '005930',
      restPeak,
      [candle(atKst(10, 42), 23700, 23900)],
    ));

    // 체결 기준선(carrier)은 승격되지 않는다 — 행은 전체 벽 패밀리 운반용으로만 남는다.
    const today = byDate(result.current)['20260613'];
    expect(today).toMatchObject({ price: null, qty: null, t_ms: null });
    expect(today.all_peaks).toContainEqual({ price: 23800, qty: 12000, t_ms: atKst(10, 42) });
  });

  it('preserves REST traded bid candidates for current-day cutoff recalculation', () => {
    const restPeak = todayBidPeak({
      traded_price: 23800,
      traded_qty: 20000,
      traded_t_ms: atKst(10, 0),
      traded_peaks: [
        { price: 23900, qty: 9000, t_ms: atKst(9, 10) },
        { price: 23800, qty: 20000, t_ms: atKst(10, 0) },
        { price: 23700, qty: 8000, t_ms: atKst(9, 20) },
        { price: 23600, qty: 7000, t_ms: atKst(9, 30) },
      ],
    });

    const { result } = renderHook(() => useDayBidPeaks(
      [],
      [],
      [],
      '20260613', OPEN_MS,
      '005930',
      restPeak,
    ));

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23800,
      traded_peaks: [
        { price: 23800, qty: 20000, t_ms: atKst(10, 0) },
        { price: 23900, qty: 9000, t_ms: atKst(9, 10) },
        { price: 23700, qty: 8000, t_ms: atKst(9, 20) },
      ],
    });
  });

  it('judges same-price bid walls on their own minute (ADR-0156)', () => {
    const { result } = renderHook(() => useDayBidPeaks(
      [
        deep(atKst(9, 10), [[23900, 1200], ...Array(9).fill([1, 1])] as Array<[number, number]>),
        deep(atKst(9, 12), [[23900, 9000], ...Array(9).fill([1, 1])] as Array<[number, number]>),
      ],
      [trade(atKst(9, 10) + 30_000, [
        { t_ms: atKst(9, 10) + 30_000, side: 1, price: 23900, qty: 10 },
      ])],
      [],
      '20260613',
      OPEN_MS,
      '005930',
    ));

    const today = byDate(result.current)['20260613'];
    expect(today).toMatchObject({
      price: 23900,
      qty: 1200,
      t_ms: atKst(9, 10),
    });
    expect(today.traded_peaks).toContainEqual({ price: 23900, qty: 1200, t_ms: atKst(9, 10) });
    // 09:12 의 **더 큰** 벽은 자기 분에 체결이 없어 체결 후보가 아니다.
    expect(today.traded_peaks).not.toContainEqual({ price: 23900, qty: 9000, t_ms: atKst(9, 12) });
    expect(today.all_peaks?.slice(0, 2)).toEqual([
      { price: 23900, qty: 9000, t_ms: atKst(9, 12) },
      { price: 23900, qty: 1200, t_ms: atKst(9, 10) },
    ]);
  });

  it('promotes an already-seen bid wall when a later trade lands in the same minute', () => {
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayBidPeaks(ob, trades, [], '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [],
      ob: [deep(atKst(9, 20), [[23800, 20000], ...Array(9).fill([1, 1])] as Array<[number, number]>)],
    });
    // 터치 전: 체결 기준선 carrier 는 비어 있고 all 패밀리만 벽을 든다.
    const untouched = result.current.find((p) => p.date === '20260613');
    expect(untouched?.price).toBeNull();
    expect(untouched?.all_peaks).toContainEqual({ price: 23800, qty: 20000, t_ms: atKst(9, 20) });

    rerender({
      trades: [trade(atKst(9, 20) + 40_000, [
        { t_ms: atKst(9, 20) + 40_000, side: 1, price: 23800, qty: 10 },
      ])],
      ob: [deep(atKst(9, 20), [[23800, 20000], ...Array(9).fill([1, 1])] as Array<[number, number]>)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23800,
      qty: 20000,
      t_ms: atKst(9, 20),
    });
  });

  // (제거됨, issue #434) 대량 버퍼 무정지 벽시계 테스트는 full-suite 워커 경합에
  // flaky했다. IncrementalPeakWallSource의 append-only 델타 소비는 useDayPeaks.perf
  // .test.tsx가 결정론적으로 검증한다(ask/bid 공유 소스).
});
