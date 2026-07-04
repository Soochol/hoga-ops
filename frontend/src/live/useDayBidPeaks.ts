import { useEffect, useMemo, useRef, useState } from 'react';
import type { BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import { isContinuousBook, type ObSnapshot, type TradeSnapshot } from './bucketHogaSeries';
import { isAfterRegularOpen } from '../util/tradingDay';
import { buildCandlePriceCoverage } from './candlePriceCoverage';
import {
  reduceDayBidPeak,
  FRESH_RATCHET,
  type DayPeak,
  type RatchetState,
} from './computeDayBidPeak';

type TradePriceState = {
  prices: Set<number>;
};

type ObservedPricePeaks = {
  items: DayPeak[];
  keys: Set<string>;
};

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

function toDayPeak(peak: BidPeak | null): DayPeak | null {
  if (!peak) return null;
  return { price: peak.price, qty: peak.qty, t_ms: peak.t_ms };
}

function toBidPeak(date: string, peak: DayPeak | null): BidPeak | null {
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

function sameDayPeaks(a: readonly DayPeak[], b: readonly DayPeak[]): boolean {
  return a.length === b.length && a.every((peak, idx) => (
    peak.price === b[idx].price
    && peak.qty === b[idx].qty
    && peak.t_ms === b[idx].t_ms
  ));
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

function freshObservedPricePeaks(): ObservedPricePeaks {
  return { items: [], keys: new Set() };
}

function dayPeakKey(peak: DayPeak): string {
  return `${peak.price}:${peak.qty}:${peak.t_ms}`;
}

function putObservedPricePeak(peaks: ObservedPricePeaks, peak: DayPeak) {
  const key = dayPeakKey(peak);
  if (peaks.keys.has(key)) return;
  peaks.keys.add(key);
  peaks.items.push(peak);
}

export function observeBidPricePeaks(peaks: ObservedPricePeaks, obs: ReadonlyArray<ObSnapshot>) {
  for (const ob of obs) {
    if (!isContinuousBook(ob) || !isAfterRegularOpen(ob.t_ms) || !ob.bids) continue;
    for (const lv of ob.bids) {
      if (lv.qty > 0) putObservedPricePeak(peaks, { price: lv.price, qty: lv.qty, t_ms: ob.t_ms });
    }
  }
}

export function bestTradedObservedPeak(
  seed: DayPeak | null,
  observed: ObservedPricePeaks,
  tradedPrices: Set<number>,
  isCandleRangeTraded: (price: number) => boolean = () => false,
): DayPeak | null {
  let best = seed;
  const eligiblePrices = new Set<number>(tradedPrices);
  for (const { price } of observed.items) {
    if (isCandleRangeTraded(price)) eligiblePrices.add(price);
  }
  for (const peak of observed.items) {
    if (eligiblePrices.has(peak.price) && (best === null || peak.qty > best.qty)) {
      best = peak;
    }
  }
  return best;
}

function topTradedObservedPeaks(
  seeds: readonly DayPeak[],
  observed: ObservedPricePeaks,
  tradedPrices: Set<number>,
  isCandleRangeTraded: (price: number) => boolean = () => false,
): DayPeak[] {
  return uniqueDayPeaks([
    ...seeds,
    ...observed.items.filter((peak) => tradedPrices.has(peak.price) || isCandleRangeTraded(peak.price)),
  ])
    .sort((a, b) => b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price);
}

function topObservedPeaks(seeds: readonly DayPeak[], observed: ObservedPricePeaks): DayPeak[] {
  return uniqueDayPeaks([...seeds, ...observed.items])
    .sort((a, b) => b.qty - a.qty || a.t_ms - b.t_ms || a.price - b.price);
}

function eligibleSeed(peak: DayPeak | null, allowPrice: (price: number) => boolean): DayPeak | null {
  return peak && allowPrice(peak.price) ? peak : null;
}

function candidatePeaks(peaks: readonly DayPeak[]) {
  return peaks.map((peak) => ({ price: peak.price, qty: peak.qty, t_ms: peak.t_ms }));
}

function uniqueDayPeaks(peaks: readonly DayPeak[]): DayPeak[] {
  const out: DayPeak[] = [];
  const keys = new Set<string>();
  for (const peak of peaks) {
    const key = dayPeakKey(peak);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(peak);
  }
  return out;
}

export function buildTodayTradedBidPeak(todayBidPeak: LiveTodayBidPeak | null): BidPeak | null {
  if (
    !todayBidPeak
    || todayBidPeak.traded_price === null
    || todayBidPeak.traded_qty === null
    || todayBidPeak.traded_t_ms === null
  ) {
    return null;
  }
  return {
    date: todayBidPeak.date,
    price: todayBidPeak.traded_price,
    qty: todayBidPeak.traded_qty,
    t_ms: todayBidPeak.traded_t_ms,
    max_price: todayBidPeak.traded_price,
    max_qty: todayBidPeak.traded_qty,
    max_t_ms: todayBidPeak.traded_t_ms,
    traded_peaks: todayBidPeak.traded_peaks,
    traded_max_peaks: todayBidPeak.traded_peaks,
  };
}

function buildTodayTradedBidPeakSeeds(todayBidPeak: LiveTodayBidPeak | null): DayPeak[] {
  if (!todayBidPeak) return [];
  const peaks = todayBidPeak.traded_peaks;
  if (peaks && peaks.length > 0) {
    return peaks
      .filter((peak) => Number.isFinite(peak.price) && Number.isFinite(peak.qty) && Number.isFinite(peak.t_ms))
      .map((peak) => ({ price: peak.price, qty: peak.qty, t_ms: peak.t_ms }));
  }
  const single = toDayPeak(buildTodayTradedBidPeak(todayBidPeak));
  return single ? [single] : [];
}

export function buildTodayAllPriceBidPeak(todayBidPeak: LiveTodayBidPeak | null): BidPeak | null {
  if (!todayBidPeak) return null;
  return {
    date: todayBidPeak.date,
    price: todayBidPeak.all_price,
    qty: todayBidPeak.all_qty,
    t_ms: todayBidPeak.all_t_ms,
    max_price: todayBidPeak.all_price,
    max_qty: todayBidPeak.all_qty,
    max_t_ms: todayBidPeak.all_t_ms,
    all_peaks: todayBidPeak.all_peaks,
    all_max_peaks: todayBidPeak.all_peaks,
  };
}

export function buildTodayCandleRangeBidPeak(
  todayBidPeak: LiveTodayBidPeak | null,
  isCandleRangeTraded: (price: number) => boolean,
): BidPeak | null {
  if (!todayBidPeak || !isCandleRangeTraded(todayBidPeak.all_price)) {
    return null;
  }
  return {
    date: todayBidPeak.date,
    price: todayBidPeak.all_price,
    qty: todayBidPeak.all_qty,
    t_ms: todayBidPeak.all_t_ms,
    max_price: todayBidPeak.all_price,
    max_qty: todayBidPeak.all_qty,
    max_t_ms: todayBidPeak.all_t_ms,
  };
}

/** 거래일별 매수 최대벽 리스트. LivePage에서 **1회** 호출(기존 live.ob 재사용 — useLiveSeries를
 *  다시 부르지 않아 2차 SSE 연결을 만들지 않는다).
 *
 *  - 과거일 항목(seed의 date != todayKst)은 백엔드 값 그대로 통과(불변).
 *  - 오늘 항목(date == todayKst)만 live.ob로 단조 ratchet 갱신(seed=오늘 백엔드 값).
 *  반환은 그날 segment 구간에 수평선으로 그릴 per-day BidPeak 배열. */
export function useDayBidPeaks(
  ob: ReadonlyArray<ObSnapshot>,
  trade: ReadonlyArray<TradeSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
  todayCandles: readonly Candle[] = EMPTY_CANDLES,
): BidPeak[] {
  const isCandleRangeTraded = useMemo(
    () => buildCandlePriceCoverage(todayCandles, todayKst),
    [todayCandles, todayKst],
  );
  const backendTodayPeak = useMemo(
    () => buildTodayTradedBidPeak(todayBidPeak),
    [todayBidPeak],
  );
  const backendTradedSeed = useMemo(
    () => toDayPeak(backendTodayPeak),
    [backendTodayPeak],
  );
  const backendTodayPeaks = useMemo(
    () => buildTodayTradedBidPeakSeeds(todayBidPeak),
    [todayBidPeak],
  );
  const candleRangeTodayPeak = useMemo(
    () => buildTodayCandleRangeBidPeak(todayBidPeak, isCandleRangeTraded),
    [todayBidPeak, isCandleRangeTraded],
  );
  const backendTodaySeed = useMemo(
    () => toDayPeak(backendTodayPeak ?? candleRangeTodayPeak),
    [backendTodayPeak, candleRangeTodayPeak],
  );
  const backendTradedPrices = todayBidPeak?.traded_prices ?? [];

  const liveSeeds = backendTodayPeaks.length > 0
    ? backendTodayPeaks
    : (backendTodaySeed ? [backendTodaySeed] : []);
  const liveSeed = liveSeeds[0] ?? null;

  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const tradePriceRef = useRef<TradePriceState>(
    freshTradePriceState(backendTradedSeed, backendTradedPrices),
  );
  const observedPricePeaksRef = useRef<ObservedPricePeaks>(freshObservedPricePeaks());
  const tradeCursorRef = useRef<BufferCursor<TradeSnapshot>>(freshCursor());
  const obCursorRef = useRef<BufferCursor<ObSnapshot>>(freshCursor());
  const [todayPeaks, setTodayPeaks] = useState<DayPeak[]>(liveSeeds);

  // 종목 전환 → ratchet 리셋·재시드(remount 비의존).
  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    tradePriceRef.current = freshTradePriceState(backendTradedSeed, backendTradedPrices);
    observedPricePeaksRef.current = freshObservedPricePeaks();
    tradeCursorRef.current = freshCursor();
    obCursorRef.current = freshCursor();
    setTodayPeaks((current) => (sameDayPeaks(current, liveSeeds) ? current : liveSeeds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, todayKst, todayBidPeak]);

  // ob/trade 틱마다 오늘 ratchet 전진. REST todayBidPeak은 seed일 뿐, 이후 라이브를 계속 반영한다.
  useEffect(() => {
    const unreadTrade = unreadSnapshots(trade, tradeCursorRef.current);
    accumulateTradePrices(tradePriceRef.current, unreadTrade);
    const unreadOb = unreadSnapshots(ob, obCursorRef.current);
    observeBidPricePeaks(observedPricePeaksRef.current, unreadOb);
    const allowPrice = (price: number) => (
      tradePriceRef.current.prices.has(price)
      || isCandleRangeTraded(price)
    );
    const s = reduceDayBidPeak(stateRef.current, liveSeed, unreadOb, allowPrice);
    stateRef.current = s;
    const bestPeak = bestTradedObservedPeak(
      eligibleSeed(s.peak, allowPrice) ?? eligibleSeed(liveSeed, allowPrice),
      observedPricePeaksRef.current,
      tradePriceRef.current.prices,
      isCandleRangeTraded,
    );
    const seedPeaks = bestPeak ? [...liveSeeds, bestPeak] : liveSeeds;
    const nextPeaks = topTradedObservedPeaks(
      seedPeaks,
      observedPricePeaksRef.current,
      tradePriceRef.current.prices,
      isCandleRangeTraded,
    );
    setTodayPeaks((current) => (sameDayPeaks(current, nextPeaks) ? current : nextPeaks));
  }, [ob, trade, liveSeed, todayBidPeak, todayKst, isCandleRangeTraded]);

  // 과거일 seed(그대로) + 오늘 후보 목록(date 부착)을 합친 per-day 리스트.
  // 오늘 후보들은 live ratchet 값이므로 close triple과 max triple을 동일하게 채운다.
  return useMemo(() => {
    const out: BidPeak[] = seeds.filter((p) => p.date !== todayKst);
    const peak = toBidPeak(todayKst, todayPeaks[0] ?? null);
    if (peak) {
      const candidates = candidatePeaks(todayPeaks);
      out.push({ ...peak, traded_peaks: candidates, traded_max_peaks: candidates });
    }
    return out;
  }, [seeds, todayKst, todayPeaks]);
}

export function useTodayAllPriceBidPeak(
  ob: ReadonlyArray<ObSnapshot>,
  seeds: readonly BidPeak[],
  todayKst: string,
  code: string | null,
  todayBidPeak: LiveTodayBidPeak | null = null,
): BidPeak | null {
  const backendTodayPeak = useMemo(
    () => buildTodayAllPriceBidPeak(todayBidPeak),
    [todayBidPeak],
  );
  const backendTodaySeed = useMemo(() => toDayPeak(backendTodayPeak), [backendTodayPeak]);
  const todaySeed: DayPeak | null = useMemo(
    () => seeds.find((p) => p.date === todayKst) ?? null,
    [seeds, todayKst],
  );
  const liveSeed = todayBidPeak !== null ? backendTodaySeed : todaySeed;
  const liveSeeds = useMemo(
    () => backendTodayPeak?.all_peaks?.map((peak) => ({ price: peak.price, qty: peak.qty, t_ms: peak.t_ms }))
      ?? (liveSeed ? [liveSeed] : []),
    [backendTodayPeak, liveSeed],
  );

  const stateRef = useRef<RatchetState>(FRESH_RATCHET);
  const observedPricePeaksRef = useRef<ObservedPricePeaks>(freshObservedPricePeaks());
  const obCursorRef = useRef<BufferCursor<ObSnapshot>>(freshCursor());
  const [todayPeaks, setTodayPeaks] = useState<DayPeak[]>(liveSeeds);

  useEffect(() => {
    stateRef.current = FRESH_RATCHET;
    observedPricePeaksRef.current = freshObservedPricePeaks();
    obCursorRef.current = freshCursor();
    setTodayPeaks((current) => (sameDayPeaks(current, liveSeeds) ? current : liveSeeds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, todayKst, todayBidPeak]);

  useEffect(() => {
    const unreadOb = unreadSnapshots(ob, obCursorRef.current);
    observeBidPricePeaks(observedPricePeaksRef.current, unreadOb);
    const s = reduceDayBidPeak(stateRef.current, liveSeed, unreadOb);
    stateRef.current = s;
    const seedPeaks = s.peak ? [...liveSeeds, s.peak] : liveSeeds;
    const nextPeaks = topObservedPeaks(seedPeaks, observedPricePeaksRef.current);
    setTodayPeaks((current) => (sameDayPeaks(current, nextPeaks) ? current : nextPeaks));
  }, [ob, liveSeed, liveSeeds]);

  return useMemo(() => {
    const peak = toBidPeak(todayKst, todayPeaks[0] ?? null);
    if (!peak) return null;
    const candidates = candidatePeaks(todayPeaks);
    return { ...peak, all_peaks: candidates, all_max_peaks: candidates };
  }, [todayKst, todayPeaks]);
}
