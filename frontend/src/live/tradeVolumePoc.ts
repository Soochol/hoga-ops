import type { TradeSnapshot } from './bucketHogaSeries';
import type { Candle, RangeSegment } from '../api/types';
import { kstMinuteOfDay } from '../util/tradingDay';

const REGULAR_OPEN_MIN = 9 * 60;
const CLOSING_AUCTION_START_MIN = 15 * 60 + 20;
const DEFAULT_BAND_PCT = 0.005;

export type TradeVolumePoc = {
  date: string;
  centerPrice: number;
  lowPrice: number;
  highPrice: number;
  qty: number;
  t_ms: number;
  bandPct: number;
};

type PriceBucket = {
  price: number;
  qty: number;
  firstTMs: number;
  order: number;
};

type DistributionBucket = {
  lowPrice: number;
  highPrice: number;
  qty: number;
  firstTMs: number;
  order: number;
};

function chooseBestPoc(
  buckets: readonly PriceBucket[],
  options: { bandPct: number; date: string },
): TradeVolumePoc | null {
  const { bandPct, date } = options;
  if (buckets.length === 0) return null;
  const byPrice = [...buckets].sort((a, b) => a.price - b.price);
  const prices = byPrice.map((bucket) => bucket.price);
  const prefixQty = new Array<number>(byPrice.length + 1);
  prefixQty[0] = 0;
  for (let i = 0; i < byPrice.length; i += 1) {
    prefixQty[i + 1] = prefixQty[i] + byPrice[i].qty;
  }
  let best: TradeVolumePoc & { order: number } | null = null;
  for (const center of buckets) {
    const lowPrice = floorKrxStockTick(center.price * (1 - bandPct));
    const highPrice = ceilKrxStockTick(center.price * (1 + bandPct));
    const start = lowerBoundPrice(prices, lowPrice);
    const end = upperBoundPrice(prices, highPrice);
    const qty = prefixQty[end] - prefixQty[start];
    if (
      best === null
      || qty > best.qty
      || (qty === best.qty && center.order < best.order)
    ) {
      best = {
        date,
        centerPrice: center.price,
        lowPrice,
        highPrice,
        qty,
        t_ms: center.firstTMs,
        bandPct,
        order: center.order,
      };
    }
  }
  if (best === null) return null;
  const { order: _order, ...poc } = best;
  return poc;
}

function lowerBoundPrice(prices: readonly number[], price: number): number {
  let lo = 0;
  let hi = prices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid] < price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundPrice(prices: readonly number[], price: number): number {
  let lo = 0;
  let hi = prices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid] <= price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function krxStockTickSize(price: number): number {
  if (price < 2_000) return 1;
  if (price < 5_000) return 5;
  if (price < 20_000) return 10;
  if (price < 50_000) return 50;
  if (price < 200_000) return 100;
  if (price < 500_000) return 500;
  return 1_000;
}

export function floorKrxStockTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  let candidate = Math.floor(price);
  candidate = Math.floor(candidate / krxStockTickSize(candidate)) * krxStockTickSize(candidate);
  while (candidate > price) candidate -= krxStockTickSize(candidate);
  return candidate;
}

export function ceilKrxStockTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  let candidate = Math.ceil(price);
  candidate = Math.ceil(candidate / krxStockTickSize(candidate)) * krxStockTickSize(candidate);
  while (candidate < price) candidate += krxStockTickSize(candidate);
  return candidate;
}

function isRegularContinuousTrade(tMs: number): boolean {
  const minute = kstMinuteOfDay(tMs);
  return minute >= REGULAR_OPEN_MIN && minute < CLOSING_AUCTION_START_MIN;
}

function isEligibleSide(side: number): boolean {
  return side === -1 || side === 1;
}

function isTradeTimeEligible(
  tMs: number,
  options: { openMinute: number; continuousBeforeMs?: number | null },
): boolean {
  if (options.continuousBeforeMs != null) {
    return kstMinuteOfDay(tMs) >= options.openMinute && tMs < options.continuousBeforeMs;
  }
  return isRegularContinuousTrade(tMs);
}

export function priceRangeFromCandles(candles: readonly Candle[]): { min: number; max: number } | null {
  const lows = candles.map((candle) => candle.low).filter(Number.isFinite);
  const highs = candles.map((candle) => candle.high).filter(Number.isFinite);
  if (lows.length === 0 || highs.length === 0) return null;
  return { min: Math.min(...lows), max: Math.max(...highs) };
}

function chooseBestDistributionBucket(
  buckets: readonly DistributionBucket[],
  options: { date: string; bandPct: number },
): TradeVolumePoc | null {
  let best: DistributionBucket | null = null;
  for (const bucket of buckets) {
    if (bucket.qty <= 0) continue;
    if (
      best === null
      || bucket.qty > best.qty
      || (bucket.qty === best.qty && bucket.order < best.order)
    ) {
      best = bucket;
    }
  }
  if (best === null) return null;
  return {
    date: options.date,
    centerPrice: Math.floor((best.lowPrice + best.highPrice) / 2),
    lowPrice: best.lowPrice,
    highPrice: best.highPrice,
    qty: best.qty,
    t_ms: best.firstTMs,
    bandPct: options.bandPct,
  };
}

function emptyDistributionBuckets(priceMin: number, priceMax: number, rangeCount: number): DistributionBucket[] {
  const rawBinWidth = (priceMax - priceMin) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  return Array.from({ length: rangeCount }, (_, idx) => ({
    lowPrice: Math.floor(priceMin + idx * binWidth),
    highPrice: idx === rangeCount - 1 ? priceMax : Math.floor(priceMin + (idx + 1) * binWidth),
    qty: 0,
    firstTMs: Number.POSITIVE_INFINITY,
    order: idx,
  }));
}

function distributionIndex(price: number, priceMin: number, priceMax: number, rangeCount: number): number {
  const rawBinWidth = (priceMax - priceMin) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  return Math.max(0, Math.min(rangeCount - 1, Math.floor((price - priceMin) / binWidth)));
}

export function computeTradeVolumePoc(
  trades: readonly TradeSnapshot[],
  options: {
    bandPct?: number;
    date?: string;
    candles?: readonly Candle[];
    rangeCount?: number;
    segment?: RangeSegment;
    continuousBeforeMs?: number | null;
  } = {},
): TradeVolumePoc | null {
  const bandPct = options.bandPct ?? DEFAULT_BAND_PCT;
  const rangeCount = options.rangeCount;
  if (options.candles && options.segment && typeof rangeCount === 'number' && Number.isInteger(rangeCount) && rangeCount > 0) {
    const range = priceRangeFromCandles(options.candles);
    if (range === null) return null;
    const buckets = emptyDistributionBuckets(range.min, range.max, rangeCount);
    const openMinute = kstMinuteOfDay(options.segment.session_open_ms);
    for (const snapshot of trades) {
      for (const event of snapshot.trades) {
        const tMs = event.t_ms ?? snapshot.t_ms;
        if (tMs < options.segment.session_open_ms || tMs >= options.segment.session_close_ms) continue;
        if (!isTradeTimeEligible(tMs, { openMinute, continuousBeforeMs: options.continuousBeforeMs })) continue;
        if (!isEligibleSide(event.side)) continue;
        const rawPrice = event.price;
        const qty = event.qty;
        if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0) continue;
        if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) continue;
        if (rawPrice < range.min || rawPrice > range.max) continue;
        const idx = distributionIndex(rawPrice, range.min, range.max, rangeCount);
        buckets[idx].qty += qty;
        buckets[idx].firstTMs = Math.min(buckets[idx].firstTMs, tMs);
      }
    }
    return chooseBestDistributionBucket(buckets, {
      bandPct,
      date: options.date ?? '',
    });
  }

  const byPrice = new Map<number, PriceBucket>();
  let order = 0;

  for (const snapshot of trades) {
    for (const event of snapshot.trades) {
      const tMs = event.t_ms ?? snapshot.t_ms;
      if (!isTradeTimeEligible(tMs, { openMinute: REGULAR_OPEN_MIN, continuousBeforeMs: options.continuousBeforeMs })) continue;
      if (!isEligibleSide(event.side)) continue;
      const rawPrice = event.price;
      const qty = event.qty;
      if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice)) continue;
      if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) continue;
      const price = Math.round(rawPrice);
      const current = byPrice.get(price);
      if (current) {
        current.qty += qty;
        current.firstTMs = Math.min(current.firstTMs, tMs);
      } else {
        byPrice.set(price, { price, qty, firstTMs: tMs, order });
        order += 1;
      }
    }
  }

  return chooseBestPoc(Array.from(byPrice.values()), {
    bandPct,
    date: options.date ?? '',
  });
}

/** computeTradeVolumePoc 의 distribution 분기(candles+segment+rangeCount)를 증분화한다.
 *  당일 POC 를 SSE 틱마다 trades 전량 재-bin 하던 것을, 파라미터(가격범위·rangeCount·
 *  세션·continuousBeforeMs)가 안정적이고 trades 가 append-only 인 동안은 델타 trade 만
 *  기존 버킷에 누적하도록 바꾼다. 파라미터 변경(범위 확장 등)이나 trades 비-append(종목
 *  전환·버퍼 리셋)에는 전체 재빌드로 폴백한다 — 폴백 경로 연산이 batch 와 동일하므로
 *  정확성은 computeTradeVolumePoc 가 보증한다(IncrementalPeakWallSource 선례).
 *
 *  bandPct·date 는 bin 이 아니라 chooseBestDistributionBucket 출력 라벨/선택에만 영향
 *  주므로 재빌드 키에 넣지 않고 매 호출 전달한다(bandPct 변경이 bin 재계산을 강제하지
 *  않는다). update 는 같은 trades 로 두 번 불러도 델타 0 → 결과 불변(React 이중 호출 안전).
 */
export type TradeVolumePocDistParams = {
  date: string;
  bandPct: number;
  rangeMin: number;
  rangeMax: number;
  rangeCount: number;
  sessionOpenMs: number;
  sessionCloseMs: number;
  continuousBeforeMs: number | null;
};

export class IncrementalTradeVolumePoc {
  private key = '';
  private buckets: DistributionBucket[] = [];
  private consumed = 0;
  private lastRef: TradeSnapshot | null = null;
  private openMinute = 0;

  update(trades: readonly TradeSnapshot[], params: TradeVolumePocDistParams): TradeVolumePoc | null {
    const key = `${params.rangeMin}|${params.rangeMax}|${params.rangeCount}`
      + `|${params.sessionOpenMs}|${params.sessionCloseMs}|${params.continuousBeforeMs ?? 'n'}`;
    const appendOnly = trades.length >= this.consumed
      && (this.consumed === 0 || trades[this.consumed - 1] === this.lastRef);
    if (key !== this.key || !appendOnly) {
      this.key = key;
      this.openMinute = kstMinuteOfDay(params.sessionOpenMs);
      this.buckets = emptyDistributionBuckets(params.rangeMin, params.rangeMax, params.rangeCount);
      this.consume(trades, params);
    } else if (trades.length > this.consumed) {
      this.consume(trades.slice(this.consumed), params);
    }
    this.consumed = trades.length;
    this.lastRef = trades.length > 0 ? trades[trades.length - 1] : null;
    return chooseBestDistributionBucket(this.buckets, { bandPct: params.bandPct, date: params.date });
  }

  /** computeTradeVolumePoc distribution 분기의 bin 루프와 라인 단위로 동일해야 한다. */
  private consume(snapshots: readonly TradeSnapshot[], params: TradeVolumePocDistParams): void {
    for (const snapshot of snapshots) {
      for (const event of snapshot.trades) {
        const tMs = event.t_ms ?? snapshot.t_ms;
        if (tMs < params.sessionOpenMs || tMs >= params.sessionCloseMs) continue;
        if (!isTradeTimeEligible(tMs, { openMinute: this.openMinute, continuousBeforeMs: params.continuousBeforeMs })) continue;
        if (!isEligibleSide(event.side)) continue;
        const rawPrice = event.price;
        const qty = event.qty;
        if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0) continue;
        if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) continue;
        if (rawPrice < params.rangeMin || rawPrice > params.rangeMax) continue;
        const idx = distributionIndex(rawPrice, params.rangeMin, params.rangeMax, params.rangeCount);
        this.buckets[idx].qty += qty;
        this.buckets[idx].firstTMs = Math.min(this.buckets[idx].firstTMs, tMs);
      }
    }
  }
}

export function computeCandleVolumePocs(
  candles: readonly Candle[],
  segments: readonly RangeSegment[],
  options: { bandPct?: number; rangeCount?: number } = {},
): TradeVolumePoc[] {
  const bandPct = options.bandPct ?? DEFAULT_BAND_PCT;
  const rangeCount = options.rangeCount;
  const out: TradeVolumePoc[] = [];
  for (const segment of segments) {
    const segmentCandles = candles.filter(
      (candle) => candle.ts_ms >= segment.session_open_ms && candle.ts_ms < segment.session_close_ms,
    );
    if (typeof rangeCount === 'number' && Number.isInteger(rangeCount) && rangeCount > 0) {
      const range = priceRangeFromCandles(segmentCandles);
      if (range === null) continue;
      const buckets = emptyDistributionBuckets(range.min, range.max, rangeCount);
      for (const candle of segmentCandles) {
        if (!isRegularContinuousTrade(candle.ts_ms)) continue;
        const price = candle.close;
        const qty = Math.max(0, Math.round((candle.vol_a ?? 0) + (candle.vol_b ?? 0)));
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
        if (price < range.min || price > range.max) continue;
        const idx = distributionIndex(price, range.min, range.max, rangeCount);
        buckets[idx].qty += qty;
        buckets[idx].firstTMs = Math.min(buckets[idx].firstTMs, candle.ts_ms);
      }
      const poc = chooseBestDistributionBucket(buckets, { bandPct, date: segment.date });
      if (poc) out.push(poc);
      continue;
    }

    const byPrice = new Map<number, PriceBucket>();
    let order = 0;
    for (const candle of candles) {
      if (candle.ts_ms < segment.session_open_ms || candle.ts_ms >= segment.session_close_ms) continue;
      if (!isRegularContinuousTrade(candle.ts_ms)) continue;
      const price = Math.round(candle.close);
      const qty = Math.max(0, Math.round((candle.vol_a ?? 0) + (candle.vol_b ?? 0)));
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
      const current = byPrice.get(price);
      if (current) {
        current.qty += qty;
        current.firstTMs = Math.min(current.firstTMs, candle.ts_ms);
      } else {
        byPrice.set(price, { price, qty, firstTMs: candle.ts_ms, order });
        order += 1;
      }
    }
    const poc = chooseBestPoc(Array.from(byPrice.values()), {
      bandPct,
      date: segment.date,
    });
    if (poc) out.push(poc);
  }
  return out;
}
