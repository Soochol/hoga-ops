import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayBidPeaks, deriveDayBidPeaksIncremental } from './useDayBidPeaks';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
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

describe('useDayBidPeaks — 기록 갱신 시퀀스', () => {
  // 종전엔 매수 `attachFamilies` 에 기록 필드가 **통째로 없었다**(매도는 top-3 을
  // 실었다). 결과는 같아 드리프트가 안 보였고, 조립이 두 벌이라 한쪽만 고치는 수정이
  // 가능했다 — 지금은 `peakWallRecordSeries` 한 벌을 공유한다.

  it('오늘 seed 행은 버려져도 기록 갱신 시퀀스는 오늘 행에 살아남는다', () => {
    const morning = { price: 23800, qty: 5000, t_ms: atKst(9, 1) };
    const afternoon = { price: 23700, qty: 9000, t_ms: atKst(13, 0) };
    const seed: BidPeak = {
      date: '20260613',
      price: 23800, qty: 5000, t_ms: atKst(9, 1),
      max_price: 23800, max_qty: 5000, max_t_ms: atKst(9, 1),
      traded_record_peaks: [morning],
      traded_record_max_peaks: [morning],
    };
    const { result } = renderHook(() => useDayBidPeaks(
      [], [], [seed], '20260613', OPEN_MS, '005930',
      // 라이브 top-3 을 기록과 같은 벽으로 맞춘다 — 사유는 ask 쪽 같은 테스트 주석.
      todayBidPeak({
        traded_record_peaks: [afternoon],
        traded_price: afternoon.price,
        traded_qty: afternoon.qty,
        traded_t_ms: afternoon.t_ms,
      }),
    ));

    const today = byDate(result.current)['20260613'];
    expect(today.qty).toBe(9000);                       // carrier 는 라이브 파생
    expect(today.traded_record_peaks).toEqual([morning, afternoon]);
    expect(today.traded_record_max_peaks).toEqual([morning, afternoon]);
  });

  it('순위가 갱신돼도 접속 이후에 세운 기록은 남는다', () => {
    // 판별식은 **단조성**이다 — 사유는 ask 쪽 같은 이름의 테스트 주석.
    // 사다리는 10단을 채운다(`isContinuousBook` 게이트) — 채움 단(price 1)은 체결가
    // 이하가 아니라 터치되지 않으므로 판정에 끼지 않는다.
    const book = (price: number, qty: number): Array<[number, number]> =>
      [[price, qty], ...Array(9).fill([1, 1])] as Array<[number, number]>;
    const early = atKst(9, 20);
    const earlyTrade = trade(early + 1_000, [
      { t_ms: early + 1_000, side: 1, price: 23_800, qty: 10 },
    ]);
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayBidPeaks(ob, trades, [], '20260613', OPEN_MS, '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({ ob: [deep(early, book(23_800, 1_000))], trades: [earlyTrade] });
    const first = byDate(result.current)['20260613'];
    expect(first.traded_record_peaks).toContainEqual({ price: 23_800, qty: 1_000, t_ms: early });

    const late = atKst(13, 0);
    rerender({
      ob: [
        deep(early, book(23_800, 1_000)),
        deep(late, book(23_790, 50_000)),
        deep(late + 1_000, book(23_780, 40_000)),
        deep(late + 2_000, book(23_770, 30_000)),
      ],
      trades: [
        earlyTrade,
        trade(late + 3_000, [{ t_ms: late + 3_000, side: 1, price: 23_770, qty: 10 }]),
      ],
    });
    const second = byDate(result.current)['20260613'];
    expect(second.traded_peaks).not.toContainEqual({ price: 23_800, qty: 1_000, t_ms: early });
    expect(second.traded_record_peaks).toContainEqual({ price: 23_800, qty: 1_000, t_ms: early });
  });

  it('derive 자체는 기록 자리에 top-3 을 넣지 않는다(누적은 훅의 일이다)', () => {
    const rows = deriveDayBidPeaksIncremental(
      new IncrementalPeakWallSource('bid'),
      [], [], [], '20260613', OPEN_MS, todayBidPeak(),
    );
    const today = byDate(rows)['20260613'];
    expect(today.traded_peaks?.length).toBeGreaterThan(0);
    expect(today.traded_record_peaks).toEqual([]);
    expect(today.traded_record_max_peaks).toEqual([]);
  });
});
