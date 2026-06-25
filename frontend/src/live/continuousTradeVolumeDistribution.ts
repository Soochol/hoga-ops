import type { Candle, DayVolumeDistribution, RangeSegment } from '../api/types';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

export function computeContinuousTradeVolumeDistribution(args: {
  date: string;
  candles: readonly Candle[];
  trades: readonly ContinuousTradeLike[];
  rangeCount: number;
  segment: RangeSegment;
}): DayVolumeDistribution | null {
  const { date, candles, trades, rangeCount, segment } = args;
  if (!Number.isInteger(rangeCount) || rangeCount <= 0) return null;

  const lows = candles.map((candle) => candle.low).filter(Number.isFinite);
  const highs = candles.map((candle) => candle.high).filter(Number.isFinite);
  if (lows.length === 0 || highs.length === 0) return null;

  const priceMin = Math.min(...lows);
  const priceMax = Math.max(...highs);
  const rawBinWidth = (priceMax - priceMin) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const qtyByBin = Array.from({ length: rangeCount }, () => 0);

  for (const trade of trades) {
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.t_ms < segment.session_open_ms || trade.t_ms >= segment.session_close_ms) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;

    const idx = Math.floor((trade.price - priceMin) / binWidth);
    qtyByBin[Math.max(0, Math.min(rangeCount - 1, idx))] += trade.qty;
  }

  return {
    date,
    range_count: rangeCount,
    price_min: priceMin,
    price_max: priceMax,
    session_open_ms: segment.session_open_ms,
    session_close_ms: segment.session_close_ms,
    bins: qtyByBin.map((qty, idx) => ({
      price_low: Math.floor(priceMin + idx * binWidth),
      price_high: idx === rangeCount - 1
        ? priceMax
        : Math.floor(priceMin + (idx + 1) * binWidth),
      qty,
    })),
  };
}
