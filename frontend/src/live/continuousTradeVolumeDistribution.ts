import type { Candle, DayVolumeDistribution, RangeSegment } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

function profileForDate(
  profiles: readonly DayVolumeDistribution[],
  date: string | null,
): DayVolumeDistribution | null {
  if (!date) return null;
  return profiles.find((profile) => profile.date === date) ?? null;
}

function mergeVolumeDistributionDelta(
  profile: DayVolumeDistribution,
  trades: readonly ContinuousTradeLike[],
): DayVolumeDistribution {
  if (profile.last_trade_ms == null || profile.bins.length === 0) return profile;
  const rangeCount = profile.bins.length;
  const rawBinWidth = (profile.price_max - profile.price_min) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const bins = profile.bins.map((bin) => ({ ...bin }));
  let lastTradeMs = profile.last_trade_ms;

  for (const trade of trades) {
    if (trade.t_ms <= profile.last_trade_ms) continue;
    if (trade.t_ms < profile.session_open_ms || trade.t_ms >= profile.session_close_ms) continue;
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.price < profile.price_min || trade.price > profile.price_max) continue;

    const idx = Math.max(
      0,
      Math.min(rangeCount - 1, Math.floor((trade.price - profile.price_min) / binWidth)),
    );
    bins[idx] = { ...bins[idx], qty: bins[idx].qty + trade.qty };
    lastTradeMs = Math.max(lastTradeMs, trade.t_ms);
  }

  return lastTradeMs === profile.last_trade_ms
    ? profile
    : { ...profile, bins, last_trade_ms: lastTradeMs };
}

function isEmptyVolumeDistribution(profile: DayVolumeDistribution): boolean {
  return profile.last_trade_ms == null && profile.bins.every((bin) => bin.qty === 0);
}

export function selectVolumeDistributionProfile(args: {
  enabled: boolean;
  date: string | null;
  todayKst: string | null;
  rangeCount: number;
  persistedProfiles: readonly DayVolumeDistribution[];
  recomputedToday: DayVolumeDistribution | null;
  liveTrades: readonly ContinuousTradeLike[];
}): DayVolumeDistribution | null | undefined {
  if (!args.enabled) return undefined;
  const persistedProfile = profileForDate(args.persistedProfiles, args.date);
  const isToday = args.date === args.todayKst;
  if (persistedProfile) {
    if (isToday && isEmptyVolumeDistribution(persistedProfile) && args.recomputedToday) {
      return args.recomputedToday;
    }
    if (isToday && persistedProfile.bins.length !== args.rangeCount && args.recomputedToday) {
      return args.recomputedToday;
    }
    return isToday ? mergeVolumeDistributionDelta(persistedProfile, args.liveTrades) : persistedProfile;
  }
  return isToday ? args.recomputedToday : null;
}

export function volumeDistributionClosePoints(args: {
  date: string | null;
  candles: readonly Candle[];
}): { t_ms: number; close: number }[] {
  if (!args.date) return [];
  return args.candles
    .filter((candle) => realMsToYyyymmdd(candle.ts_ms) === args.date)
    .sort((a, b) => a.ts_ms - b.ts_ms)
    .map((candle) => ({ t_ms: candle.ts_ms, close: candle.close }));
}

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
  let lastTradeMs: number | null = null;

  for (const trade of trades) {
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.t_ms < segment.session_open_ms || trade.t_ms >= segment.session_close_ms) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;

    const idx = Math.floor((trade.price - priceMin) / binWidth);
    qtyByBin[Math.max(0, Math.min(rangeCount - 1, idx))] += trade.qty;
    lastTradeMs = lastTradeMs == null ? trade.t_ms : Math.max(lastTradeMs, trade.t_ms);
  }

  return {
    date,
    range_count: rangeCount,
    price_min: priceMin,
    price_max: priceMax,
    session_open_ms: segment.session_open_ms,
    session_close_ms: segment.session_close_ms,
    last_trade_ms: lastTradeMs,
    bins: qtyByBin.map((qty, idx) => ({
      price_low: Math.floor(priceMin + idx * binWidth),
      price_high: idx === rangeCount - 1
        ? priceMax
        : Math.floor(priceMin + (idx + 1) * binWidth),
      qty,
    })),
  };
}
