import type { Candle, DayVolumeDistribution, RangeSegment } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';
import { isContinuousBook, type ObSnapshot } from './bucketHogaSeries';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

type VolumeDistributionBinIndex = {
  times: number[];
  prefixQtys: number[];
};

export type ContinuousTradeVolumeDistributionIndex = {
  profileAt(cutoffMs?: number | null): DayVolumeDistribution;
};

function profileForDate(
  profiles: readonly DayVolumeDistribution[],
  date: string | null,
): DayVolumeDistribution | null {
  if (!date) return null;
  return profiles.find((profile) => profile.date === date) ?? null;
}

export function mergeVolumeDistributionTail(
  profile: DayVolumeDistribution,
  trades: readonly ContinuousTradeLike[],
  cursorMs: number | null,
  continuousBeforeMs?: number | null,
): DayVolumeDistribution {
  if (profile.last_trade_ms == null || profile.bins.length === 0) return profile;
  const rangeCount = profile.bins.length;
  const rawBinWidth = (profile.price_max - profile.price_min) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const bins = profile.bins.map((bin) => ({ ...bin }));
  let lastTradeMs = profile.last_trade_ms;
  const upperBoundMs = continuousBeforeMs ?? profile.session_close_ms;

  for (const trade of trades) {
    if (trade.t_ms <= profile.last_trade_ms) continue;
    if (cursorMs != null && trade.t_ms > cursorMs) continue;
    if (trade.t_ms < profile.session_open_ms || trade.t_ms >= upperBoundMs) continue;
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
  continuousBeforeMs?: number | null;
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
    return isToday
      ? mergeVolumeDistributionTail(persistedProfile, args.liveTrades, null, args.continuousBeforeMs)
      : persistedProfile;
  }
  return isToday ? args.recomputedToday : null;
}

export function firstTrailingSinglePriceBookMs(
  snapshots: readonly ObSnapshot[],
  sessionCloseMs: number,
): number | null {
  let lastContinuous: number | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.t_ms <= sessionCloseMs && isContinuousBook(snapshot)) {
      lastContinuous =
        lastContinuous == null ? snapshot.t_ms : Math.max(lastContinuous, snapshot.t_ms);
    }
  }
  if (lastContinuous == null) return null;

  let firstSinglePrice: number | null = null;
  for (const snapshot of snapshots) {
    if (
      snapshot.t_ms > lastContinuous &&
      snapshot.t_ms <= sessionCloseMs &&
      !isContinuousBook(snapshot)
    ) {
      firstSinglePrice =
        firstSinglePrice == null ? snapshot.t_ms : Math.min(firstSinglePrice, snapshot.t_ms);
    }
  }
  return firstSinglePrice;
}

export function volumeDistributionClosePoints(args: {
  date: string | null;
  candles: readonly Candle[];
}): { t_ms: number; close: number }[] {
  if (!args.date) return [];
  return volumeDistributionClosePointsFromCandles(
    args.candles.filter((candle) => realMsToYyyymmdd(candle.ts_ms) === args.date),
  );
}

export function buildCandleDateIndex(
  candles: readonly Candle[],
): Map<string, Candle[]> {
  const byDate = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = realMsToYyyymmdd(candle.ts_ms);
    const bucket = byDate.get(date);
    if (bucket) {
      bucket.push(candle);
    } else {
      byDate.set(date, [candle]);
    }
  }
  return byDate;
}

export function volumeDistributionClosePointsFromCandles(
  candles: readonly Candle[],
): { t_ms: number; close: number }[] {
  return [...candles]
    .sort((a, b) => a.ts_ms - b.ts_ms)
    .map((candle) => ({ t_ms: candle.ts_ms, close: candle.close }));
}

export function computeContinuousTradeVolumeDistribution(args: {
  date: string;
  candles: readonly Candle[];
  trades: readonly ContinuousTradeLike[];
  rangeCount: number;
  segment: RangeSegment;
  cutoffMs?: number | null;
  continuousBeforeMs?: number | null;
}): DayVolumeDistribution | null {
  const { date, candles, trades, rangeCount, segment, cutoffMs } = args;
  if (!Number.isInteger(rangeCount) || rangeCount <= 0) return null;

  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const candle of candles) {
    if (Number.isFinite(candle.low)) priceMin = Math.min(priceMin, candle.low);
    if (Number.isFinite(candle.high)) priceMax = Math.max(priceMax, candle.high);
  }
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return null;

  const rawBinWidth = (priceMax - priceMin) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const qtyByBin = Array.from({ length: rangeCount }, () => 0);
  let lastTradeMs: number | null = null;
  const upperBoundMs = args.continuousBeforeMs ?? segment.session_close_ms;

  for (const trade of trades) {
    if (cutoffMs != null && trade.t_ms > cutoffMs) continue;
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.t_ms < segment.session_open_ms || trade.t_ms >= upperBoundMs) continue;
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

function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (values[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function buildContinuousTradeVolumeDistributionIndex(args: {
  date: string;
  candles: readonly Candle[];
  trades: readonly ContinuousTradeLike[];
  rangeCount: number;
  segment: RangeSegment;
  continuousBeforeMs?: number | null;
}): ContinuousTradeVolumeDistributionIndex | null {
  const { date, candles, trades, rangeCount, segment } = args;
  if (!Number.isInteger(rangeCount) || rangeCount <= 0) return null;

  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const candle of candles) {
    if (Number.isFinite(candle.low)) priceMin = Math.min(priceMin, candle.low);
    if (Number.isFinite(candle.high)) priceMax = Math.max(priceMax, candle.high);
  }
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) return null;

  const rawBinWidth = (priceMax - priceMin) / rangeCount;
  const binWidth = rawBinWidth > 0 ? rawBinWidth : 1;
  const upperBoundMs = args.continuousBeforeMs ?? segment.session_close_ms;
  const pointsByBin = Array.from({ length: rangeCount }, () => [] as { t_ms: number; qty: number }[]);
  const includedTimes: number[] = [];

  for (const trade of trades) {
    if (trade.side !== 1 && trade.side !== -1) continue;
    if (!Number.isFinite(trade.price) || trade.price <= 0) continue;
    if (!Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    if (trade.t_ms < segment.session_open_ms || trade.t_ms >= upperBoundMs) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;

    const idx = Math.floor((trade.price - priceMin) / binWidth);
    const binIdx = Math.max(0, Math.min(rangeCount - 1, idx));
    pointsByBin[binIdx].push({ t_ms: trade.t_ms, qty: trade.qty });
    includedTimes.push(trade.t_ms);
  }

  includedTimes.sort((a, b) => a - b);
  const indexedBins: VolumeDistributionBinIndex[] = pointsByBin.map((points) => {
    points.sort((a, b) => a.t_ms - b.t_ms);
    const times: number[] = [];
    const prefixQtys: number[] = [];
    let totalQty = 0;
    for (const point of points) {
      totalQty += point.qty;
      times.push(point.t_ms);
      prefixQtys.push(totalQty);
    }
    return { times, prefixQtys };
  });
  const binRanges = Array.from({ length: rangeCount }, (_, idx) => ({
    price_low: Math.floor(priceMin + idx * binWidth),
    price_high: idx === rangeCount - 1
      ? priceMax
      : Math.floor(priceMin + (idx + 1) * binWidth),
  }));

  return {
    profileAt(cutoffMs?: number | null): DayVolumeDistribution {
      const lastTradeIndex = cutoffMs == null
        ? includedTimes.length
        : upperBound(includedTimes, cutoffMs);

      return {
        date,
        range_count: rangeCount,
        price_min: priceMin,
        price_max: priceMax,
        session_open_ms: segment.session_open_ms,
        session_close_ms: segment.session_close_ms,
        last_trade_ms: lastTradeIndex > 0 ? includedTimes[lastTradeIndex - 1] : null,
        bins: indexedBins.map((bin, idx) => {
          const qtyIndex = cutoffMs == null
            ? bin.prefixQtys.length
            : upperBound(bin.times, cutoffMs);
          return {
            ...binRanges[idx],
            qty: qtyIndex > 0 ? bin.prefixQtys[qtyIndex - 1] : 0,
          };
        }),
      };
    },
  };
}
