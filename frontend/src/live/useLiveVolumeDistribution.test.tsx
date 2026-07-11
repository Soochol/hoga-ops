/**
 * 사이드바 체결분포 증분화의 패리티 계약.
 *
 * 핵심 불변식: 어떤 틱 시퀀스(append·축출·버퍼 리셋·베이스 변경)에서도
 * 증분 훅의 결과는 "매 렌더 전체 재계산"(구 경로)과 값이 동일해야 한다.
 * 구 경로 함수들(compute/merge/select)이 프로덕션에 상존하므로 오라클로 쓴다.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Candle, DayVolumeDistribution, RangeSegment } from '../api/types';
import type { TradeSnapshot } from './bucketHogaSeries';
import {
  computeContinuousTradeVolumeDistribution,
  mergeVolumeDistributionTail,
  type ContinuousTradeLike,
} from './continuousTradeVolumeDistribution';
import {
  useLiveDistributionTrades,
  useLiveTodayVolumeDistribution,
  type LiveDistributionTradesResult,
} from './useLiveVolumeDistribution';

const SEGMENT: RangeSegment = {
  date: '20260711',
  session_open_ms: 1_000_000,
  session_close_ms: 2_000_000,
} as RangeSegment;

function snap(tMs: number, trades: Array<[number, number, number]>): TradeSnapshot {
  return {
    t_ms: tMs,
    trades: trades.map(([price, qty, side]) => ({ price, qty, side })),
  } as unknown as TradeSnapshot;
}

function candle(low: number, high: number): Candle {
  return { ts_ms: 1_100_000, open: low, high, low, close: high, vol_a: 0, vol_b: 0 } as Candle;
}

function flattenAll(snapshots: readonly TradeSnapshot[]): ContinuousTradeLike[] {
  return snapshots.flatMap((s) =>
    s.trades.map((t) => ({
      t_ms: t.t_ms ?? s.t_ms, price: t.price ?? NaN, qty: t.qty, side: t.side,
    })),
  );
}

describe('useLiveDistributionTrades — 증분 flatten 엔진', () => {
  it('OFF면 stable EMPTY 참조를 유지한다', () => {
    const { result, rerender } = renderHook(
      ({ snaps }: { snaps: TradeSnapshot[] }) => useLiveDistributionTrades(snaps, false),
      { initialProps: { snaps: [snap(1_100_000, [[100, 1, 1]])] } },
    );
    const first = result.current;
    rerender({ snaps: [snap(1_100_000, [[100, 1, 1]]), snap(1_100_500, [[101, 2, -1]])] });
    expect(result.current.trades).toBe(first.trades);
    expect(result.current.trades).toHaveLength(0);
  });

  it('append·축출·리셋 시퀀스에서 전체 flatten과 동일하다 (패리티)', () => {
    const s1 = snap(1_100_000, [[100, 1, 1], [101, 2, -1]]);
    const s2 = snap(1_100_500, [[102, 3, 1]]);
    const s3 = snap(1_101_000, [[103, 4, -1], [104, 5, 1]]);
    const s4 = snap(1_101_500, [[105, 6, 1]]);
    const sequences: TradeSnapshot[][] = [
      [s1],
      [s1, s2],            // append
      [s1, s2, s3],        // append
      [s2, s3, s4],        // 축출 + append (동시)
      [s3, s4],            // 축출만
      [snap(1_200_000, [[110, 1, 1]])],  // 전체 리셋 (tail 소실)
    ];
    const { result, rerender } = renderHook(
      ({ snaps }: { snaps: TradeSnapshot[] }) => useLiveDistributionTrades(snaps, true),
      { initialProps: { snaps: sequences[0] } },
    );
    expect(result.current.trades).toEqual(flattenAll(sequences[0]));
    for (const snaps of sequences.slice(1)) {
      rerender({ snaps });
      expect(result.current.trades).toEqual(flattenAll(snaps));
    }
  });

  it('변화 없는 리렌더는 동일 참조를 반환한다 (StrictMode 멱등)', () => {
    const snaps = [snap(1_100_000, [[100, 1, 1]])];
    const { result, rerender } = renderHook(
      ({ s }: { s: TradeSnapshot[] }) => useLiveDistributionTrades(s, true),
      { initialProps: { s: snaps } },
    );
    const first = result.current.trades;
    rerender({ s: snaps });
    expect(result.current.trades).toBe(first);
    expect(result.current.fresh).toHaveLength(0);
  });
});

type TodayArgs = {
  snaps: TradeSnapshot[];
  persisted: DayVolumeDistribution | null;
  candles: Candle[];
  rangeCount?: number;
};

function useHarness({ snaps, persisted, candles, rangeCount = 4 }: TodayArgs) {
  const live: LiveDistributionTradesResult = useLiveDistributionTrades(snaps, true);
  return useLiveTodayVolumeDistribution({
    enabled: true,
    stockCode: '005930',
    todayKst: '20260711',
    isMinute: true,
    rangeCount,
    todayCandles: candles,
    todaySegment: SEGMENT,
    persistedToday: persisted,
    liveTrades: live,
    continuousBeforeMs: null,
  });
}

/** 구 경로(매 렌더 전체 계산) 오라클. */
function oracle({ snaps, persisted, candles, rangeCount = 4 }: TodayArgs): DayVolumeDistribution | null {
  const trades = flattenAll(snaps);
  const persistedUsable = !!(
    persisted &&
    persisted.bins.length === rangeCount &&
    !(persisted.last_trade_ms == null && persisted.bins.every((b) => b.qty === 0))
  );
  if (persistedUsable && persisted) {
    return mergeVolumeDistributionTail(persisted, trades, null, null);
  }
  return candles.length
    ? computeContinuousTradeVolumeDistribution({
        date: '20260711', candles, trades, rangeCount, segment: SEGMENT,
        continuousBeforeMs: null,
      })
    : null;
}

describe('useLiveTodayVolumeDistribution — 증분 fold 패리티', () => {
  const CANDLES = [candle(100, 120)];

  it('recompute 베이스: append 시퀀스에서 전체 재계산과 값이 동일하다', () => {
    const steps: TradeSnapshot[][] = [
      [snap(1_100_000, [[100, 5, 1]])],
      [snap(1_100_000, [[100, 5, 1]]), snap(1_100_500, [[110, 3, -1], [120, 2, 1]])],
      [snap(1_100_000, [[100, 5, 1]]), snap(1_100_500, [[110, 3, -1], [120, 2, 1]]),
       snap(1_101_000, [[105, 7, 1], [0, 9, 0]])],  // side=0·price=0 필터 확인
    ];
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { snaps: steps[0], persisted: null, candles: CANDLES },
    });
    expect(result.current).toEqual(oracle({ snaps: steps[0], persisted: null, candles: CANDLES }));
    for (const snaps of steps.slice(1)) {
      rerender({ snaps, persisted: null, candles: CANDLES });
      expect(result.current).toEqual(oracle({ snaps, persisted: null, candles: CANDLES }));
    }
  });

  it('persisted 베이스: baseline 이전(≤ last_trade_ms) 체결은 fold에서도 드롭된다', () => {
    const persisted: DayVolumeDistribution = {
      date: '20260711', range_count: 4, price_min: 100, price_max: 120,
      session_open_ms: SEGMENT.session_open_ms, session_close_ms: SEGMENT.session_close_ms,
      last_trade_ms: 1_100_400, bins: [
        { price_low: 100, price_high: 105, qty: 10 },
        { price_low: 105, price_high: 110, qty: 0 },
        { price_low: 110, price_high: 115, qty: 0 },
        { price_low: 115, price_high: 120, qty: 0 },
      ],
    };
    const s1 = snap(1_100_300, [[100, 99, 1]]);   // baseline 이전 — 드롭돼야 함
    const s2 = snap(1_100_800, [[110, 4, -1]]);
    const s3 = snap(1_100_400, [[100, 50, 1]]);   // baseline과 같은 ms — 드롭(구 의미론)
    const steps: TradeSnapshot[][] = [[s1], [s1, s2], [s1, s2, s3]];
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { snaps: steps[0], persisted, candles: CANDLES },
    });
    for (const snaps of steps) {
      rerender({ snaps, persisted, candles: CANDLES });
      expect(result.current).toEqual(oracle({ snaps, persisted, candles: CANDLES }));
    }
  });

  it('베이스 변경(승격·그리드·rangeCount)마다 전체 재구축으로 수렴한다', () => {
    const s1 = snap(1_100_000, [[100, 5, 1]]);
    const s2 = snap(1_100_500, [[118, 3, -1]]);
    let props: TodayArgs = { snaps: [s1], persisted: null, candles: CANDLES };
    const { result, rerender } = renderHook(useHarness, { initialProps: props });
    expect(result.current).toEqual(oracle(props));

    // 그리드 변동 (신고가 캔들)
    props = { snaps: [s1, s2], persisted: null, candles: [candle(100, 140)] };
    rerender(props);
    expect(result.current).toEqual(oracle(props));

    // 승격 도착 (persisted 베이스로 전환)
    const promoted: DayVolumeDistribution = {
      date: '20260711', range_count: 4, price_min: 100, price_max: 140,
      session_open_ms: SEGMENT.session_open_ms, session_close_ms: SEGMENT.session_close_ms,
      last_trade_ms: 1_100_000, bins: [
        { price_low: 100, price_high: 110, qty: 5 },
        { price_low: 110, price_high: 120, qty: 0 },
        { price_low: 120, price_high: 130, qty: 0 },
        { price_low: 130, price_high: 140, qty: 0 },
      ],
    };
    props = { snaps: [s1, s2], persisted: promoted, candles: [candle(100, 140)] };
    rerender(props);
    expect(result.current).toEqual(oracle(props));

    // rangeCount 변경 → persisted 불일치 → recompute 폴백
    props = { snaps: [s1, s2], persisted: promoted, candles: [candle(100, 140)], rangeCount: 8 };
    rerender(props);
    expect(result.current).toEqual(oracle(props));
  });

  it('신규 체결이 없으면 동일 참조를 반환한다 (하류 memo 스킵)', () => {
    const snaps = [snap(1_100_000, [[100, 5, 1]])];
    const props: TodayArgs = { snaps, persisted: null, candles: CANDLES };
    const { result, rerender } = renderHook(useHarness, { initialProps: props });
    const first = result.current;
    rerender({ ...props });
    expect(result.current).toBe(first);
  });

  it('버퍼 리셋(generation 증가) 시 전체 재구축한다', () => {
    const s1 = snap(1_100_000, [[100, 5, 1]]);
    const { result, rerender } = renderHook(useHarness, {
      initialProps: { snaps: [s1], persisted: null, candles: CANDLES } as TodayArgs,
    });
    // tail 소실 = 완전히 새 버퍼 (종목 전환/재연결)
    const fresh = [snap(1_105_000, [[115, 9, 1]])];
    rerender({ snaps: fresh, persisted: null, candles: CANDLES });
    expect(result.current).toEqual(oracle({ snaps: fresh, persisted: null, candles: CANDLES }));
  });
});
