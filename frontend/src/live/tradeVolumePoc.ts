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

function chooseBestPoc(
  buckets: readonly PriceBucket[],
  options: { bandPct: number; date: string },
): TradeVolumePoc | null {
  const { bandPct, date } = options;
  if (buckets.length === 0) return null;
  let best: TradeVolumePoc & { order: number } | null = null;
  for (const center of buckets) {
    const lowPrice = floorKrxStockTick(center.price * (1 - bandPct));
    const highPrice = ceilKrxStockTick(center.price * (1 + bandPct));
    let qty = 0;
    for (const bucket of buckets) {
      if (bucket.price >= lowPrice && bucket.price <= highPrice) qty += bucket.qty;
    }
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

export function computeTradeVolumePoc(
  trades: readonly TradeSnapshot[],
  options: { bandPct?: number; date?: string } = {},
): TradeVolumePoc | null {
  const bandPct = options.bandPct ?? DEFAULT_BAND_PCT;
  const byPrice = new Map<number, PriceBucket>();
  let order = 0;

  for (const snapshot of trades) {
    for (const event of snapshot.trades) {
      const tMs = event.t_ms ?? snapshot.t_ms;
      if (!isRegularContinuousTrade(tMs)) continue;
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

export function computeCandleVolumePocs(
  candles: readonly Candle[],
  segments: readonly RangeSegment[],
  options: { bandPct?: number } = {},
): TradeVolumePoc[] {
  const bandPct = options.bandPct ?? DEFAULT_BAND_PCT;
  const out: TradeVolumePoc[] = [];
  for (const segment of segments) {
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
