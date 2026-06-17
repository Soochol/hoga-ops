import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskPeak, Candle } from '../api/types';
import type { LiveTodayAskPeak } from '../api/liveSeries';
import { isContinuousBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import { isAfterRegularOpen } from '../util/tradingDay';
import { realMsToYyyymmdd } from './liveDateTime';
import {
  reduceDayAskPeak,
  FRESH_RATCHET,
  type DayPeak,
  type RatchetState,
} from './computeDayAskPeak';

type TradePriceState = {
  prices: Set<number>;
};

type ObservedPricePeaks = Map<number, DayPeak>;

type BufferCursor<T> = {
  tail: T | null;
};

const EMPTY_CANDLES: readonly Candle[] = [];

function freshCursor<T>(): BufferCursor<T> {
  return { tail: null };
}

function unreadSnapshots<T>(items: ReadonlyArray<T>, cursor: BufferCursor<T>): ReadonlyArray<T> {
  if (items.length === 0) {
    cursor.tail = null;
    return [];
  }
  const prevTail = cursor.tail;
  cursor.tail = items[items.length - 1] ?? null;
  if (prevTail === null) return items;
  const prevIndex = items.lastIndexOf(prevTail);
  if (prevIndex < 0) return items;
  return items.slice(prevIndex + 1);
}

function freshTradePriceState(seed: DayPeak | null, seededPrices: readonly number[] = []): TradePriceState {
  const prices = new Set<number>();
  for (const price of seededPrices) {
    if (Number.isFinite(price)) prices.add(price);
  }
  if (seed) prices.add(seed.price);
  return { prices };
}

function toDayPeak(peak: AskPeak | null): DayPeak | null {
  if (!peak) return null;
  return { price: peak.price, qty: peak.qty, t_ms: peak.t_ms };
}

function toAskPeak(date: string, peak: DayPeak | null): AskPeak | null {
  if (!peak) return null;
  return {
    date,
    price: peak.price,
    qty: peak.qty,
    t_ms: peak.t_ms,
    max_price: peak.price,
    max_qty: peak.qty,
    max_t_ms: peak.t_ms,
  };
}

function isEligibleTradeSide(side: number): boolean {
  return side === 1 || side === -1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function accumulateTradePrices(state: TradePriceState, trade: ReadonlyArray<TradeSnapshot>) {
  for (const snapshot of trade) {
    for (const ev of snapshot.trades) {
      if (isEligibleTradeSide(ev.side) && isFiniteNumber(ev.price)) {
        state.prices.add(ev.price);
      }
    }
  }
}

function putLargerPricePeak(peaks: ObservedPricePeaks, peak: DayPeak) {
  const current = peaks.get(peak.price);
  if (current === undefined || peak.qty > current.qty) {
    peaks.set(peak.price, peak);
  }
}

function observeAskPricePeaks(peaks: ObservedPricePeaks, obs: ReadonlyArray<ObSnapshot>) {
  for (const ob of obs) {
    if (!isContinuousBook(ob) || !isAfterRegularOpen(ob.t_ms) || !ob.asks) continue;
    for (const lv of ob.asks) {
      if (lv.qty > 0) putLargerPricePeak(peaks, { price: lv.price, qty: lv.qty, t_ms: ob.t_ms });
    }
  }
}

function bestTradedObservedPeak(
  seed: DayPeak | null,
  observed: ObservedPricePeaks,
  tradedPrices: Set<number>,
  isCandleRangeTraded: (price: number) => boolean = () => false,
): DayPeak | null {
  let best = seed;
  const eligiblePrices = new Set<number>(tradedPrices);
  for (const price of observed.keys()) {
    if (isCandleRangeTraded(price)) eligiblePrices.add(price);
  }
  for (const price of eligiblePrices) {
    const peak = observed.get(price);
    if (peak && (best === null || peak.qty > best.qty)) best = peak;
  }
  return best;
}

export function buildTodayTradedAskPeak(todayAskPeak: LiveTodayAskPeak | null): AskPeak | null {
  if (
    !todayAskPeak
    || todayAskPeak.traded_price === null
    || todayAskPeak.traded_qty === null
    || todayAskPeak.traded_t_ms === null
  ) {
    return null;
  }
  return {
    date: todayAskPeak.date,
    price: todayAskPeak.traded_price,
    qty: todayAskPeak.traded_qty,
    t_ms: todayAskPeak.traded_t_ms,
    max_price: todayAskPeak.traded_price,
    max_qty: todayAskPeak.traded_qty,
    max_t_ms: todayAskPeak.traded_t_ms,
  };
}

export function buildTodayAllPriceAskPeak(todayAskPeak: LiveTodayAskPeak | null): AskPeak | null {
  if (!todayAskPeak) return null;
  return {
    date: todayAskPeak.date,
    price: todayAskPeak.all_price,
    qty: todayAskPeak.all_qty,
    t_ms: todayAskPeak.all_t_ms,
    max_price: todayAskPeak.all_price,
    max_qty: todayAskPeak.all_qty,
    max_t_ms: todayAskPeak.all_t_ms,
  };
}

function candleRangeContainsPrice(price: number, candles: readonly Candle[], todayKst: string): boolean {
  return candles.some((c) => (
    realMsToYyyymmdd(c.ts_ms) === todayKst
    && c.low <= price
    && price <= c.high
  ));
}

function buildTodayCandleRangeAskPeak(
  todayAskPeak: LiveTodayAskPeak | null,
  candles: readonly Candle[],
  todayKst: string,
): AskPeak | null {
  if (!todayAskPeak || !candleRangeContainsPrice(todayAskPeak.all_price, candles, todayKst)) {
    return null;
  }
  return {
    date: todayAskPeak.date,
    price: todayAskPeak.all_price,
    qty: todayAskPeak.all_qty,
    t_ms: todayAskPeak.all_t_ms,
    max_price: todayAskPeak.all_price,
    max_qty: todayAskPeak.all_qty,
    max_t_ms: todayAskPeak.all_t_ms,
  };
}

/** 거래일별 매도 최대벽 리스트. LivePage에서 **1회** 호출(기존 live.ob 재사용 — useLiveSeries를
 *  다시 부르지 않아 2차 SSE 연결을 만들지 않는다).
 *
 *  - 과거일 항목(seed의 date != todayKst)은 백엔드 값 그대로 통과(불변).
 *  - 오늘 항목(date == todayKst)만 live.ob로 단조 ratchet 갱신(seed=오늘 백엔드 값).
 *  반환은 그날 segment 구간에 수평선으로 그릴 per-day AskPeak 배열. */
export function useDayAskPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): AskPeak[] {
  const backendTodayPeak = useMemo(
    () => buildTodayTradedAskPeak(todayAskPeak),
    [todayAskPeak],
  );
  const candleRangeTodayPeak = useMemo(
    () => buildTodayCandleRangeAskPeak(todayAskPeak, todayCandles, todayKst),
    [todayAskPeak, todayCandles, todayKst],
  );
  const backendTodaySeed = useMemo(
    () => toDayPeak(backendTodayPeak ?? candleRangeTodayPeak),
    [backendTodayPeak, candleRangeTodayPeak],
  );
  const backendTradedPrices = todayAskPeak?.traded_prices ?? [];

  const liveSeed = backendTodaySeed;

  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const tradePriceRef = useRef<TradePriceState>(
    freshTradePriceState(backendTodaySeed, backendTradedPrices),
  );
  const observedPricePeaksRef = useRef<ObservedPricePeaks>(new Map());
  const tradeCursorRef = useRef<BufferCursor<TradeSnapshot>>(freshCursor());
  const obCursorRef = useRef<BufferCursor<ObSnapshot>>(freshCursor());
  const [todayPeak, setTodayPeak] = useState<DayPeak | null>(liveSeed);

  // 종목 전환 → ratchet 리셋·재시드(remount 비의존).
  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    tradePriceRef.current = freshTradePriceState(backendTodaySeed, backendTradedPrices);
    observedPricePeaksRef.current = new Map();
    tradeCursorRef.current = freshCursor();
    obCursorRef.current = freshCursor();
    setTodayPeak(liveSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, todayKst, todayAskPeak, todayCandles]);

  // ob/trade 틱마다 오늘 ratchet 전진. REST todayAskPeak은 seed일 뿐, 이후 라이브를 계속 반영한다.
  useEffect(() => {
    const unreadTrade = unreadSnapshots(trade, tradeCursorRef.current);
    accumulateTradePrices(tradePriceRef.current, unreadTrade);
    const unreadOb = unreadSnapshots(ob, obCursorRef.current);
    observeAskPricePeaks(observedPricePeaksRef.current, unreadOb);
    const allowPrice = (price: number) => (
      tradePriceRef.current.prices.has(price)
      || candleRangeContainsPrice(price, todayCandles, todayKst)
    );
    const s = reduceDayAskPeak(stateRef.current, liveSeed, unreadOb, allowPrice);
    stateRef.current = s;
    setTodayPeak(bestTradedObservedPeak(
      s.peak ?? liveSeed,
      observedPricePeaksRef.current,
      tradePriceRef.current.prices,
      (price) => candleRangeContainsPrice(price, todayCandles, todayKst),
    ));
  }, [ob, trade, liveSeed, todayAskPeak, todayCandles, todayKst]);

  // 과거일 seed(그대로) + 오늘 ratchet 결과(date 부착)를 합친 per-day 리스트.
  // 오늘 entry는 live ratchet 값 하나만 추적하므로 close triple과 max triple을 동일하게 채운다.
  return useMemo(() => {
    const out: AskPeak[] = seeds.filter((p) => p.date !== todayKst);
    const peak = toAskPeak(todayKst, todayPeak);
    if (peak) out.push(peak);
    return out;
  }, [seeds, todayKst, todayPeak]);
}

export function useTodayAllPriceAskPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly AskPeak[],
  todayKst: string,
  code: string | null,
  todayAskPeak: LiveTodayAskPeak | null = null,
): AskPeak | null {
  const backendTodayPeak = useMemo(
    () => buildTodayAllPriceAskPeak(todayAskPeak),
    [todayAskPeak],
  );
  const backendTodaySeed = useMemo(() => toDayPeak(backendTodayPeak), [backendTodayPeak]);
  const todaySeed: DayPeak | null = useMemo(
    () => seeds.find((p) => p.date === todayKst) ?? null,
    [seeds, todayKst],
  );
  const liveSeed = todayAskPeak !== null ? backendTodaySeed : todaySeed;

  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const obCursorRef = useRef<BufferCursor<ObSnapshot>>(freshCursor());
  const [todayPeak, setTodayPeak] = useState<DayPeak | null>(liveSeed);

  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    obCursorRef.current = freshCursor();
    setTodayPeak(liveSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, todayKst, todayAskPeak]);

  useEffect(() => {
    const unreadOb = unreadSnapshots(ob, obCursorRef.current);
    const s = reduceDayAskPeak(stateRef.current, liveSeed, unreadOb);
    stateRef.current = s;
    setTodayPeak(s.peak ?? liveSeed);
  }, [ob, liveSeed]);

  return useMemo(() => toAskPeak(todayKst, todayPeak), [todayKst, todayPeak]);
}
