import { useMemo } from 'react';
import type { Candle, RangeSegment, TradeVolumePocWire } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import { firstTrailingSinglePriceBookMs } from './continuousTradeVolumeDistribution';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import { computeCandleVolumePocs, computeTradeVolumePoc, type TradeVolumePoc } from './tradeVolumePoc';
import { tradeVolumePocFromWire } from './tradeVolumePocWire';

const LEGACY_TRADE_VOLUME_POC_BAND_PCT = 0.005;

function matchesBandPct(value: number, target: number): boolean {
  return Math.abs(value - target) < 1e-9;
}

function seedByDate(
  seeds: readonly TradeVolumePocWire[],
): Map<string, TradeVolumePocWire> {
  const out = new Map<string, TradeVolumePocWire>();
  for (const seed of seeds) {
    const current = out.get(seed.date);
    if (
      !current ||
      (
        !matchesBandPct(current.band_pct, LEGACY_TRADE_VOLUME_POC_BAND_PCT) &&
        matchesBandPct(seed.band_pct, LEGACY_TRADE_VOLUME_POC_BAND_PCT)
      )
    ) {
      out.set(seed.date, seed);
    }
  }
  return out;
}

export function useTradeVolumePocs(
  trades: readonly TradeSnapshot[],
  seeds: readonly TradeVolumePocWire[],
  todayKst: string,
  code: string | null,
  candles: readonly Candle[] = [],
  segments: readonly RangeSegment[] = [],
  orderbooks: readonly ObSnapshot[] = [],
): TradeVolumePoc[] {
  const rangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const candleFallbacks = useMemo(
    () => computeCandleVolumePocs(
      candles,
      segments,
      { bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT, rangeCount },
    ),
    [candles, segments, rangeCount],
  );
  return useMemo(() => {
    const seedsByDate = seedByDate(seeds);
    const out = Array.from(seedsByDate.values()).filter((p) => p.date !== todayKst).map(tradeVolumePocFromWire);
    const seenDates = new Set(out.map((p) => p.date));
    const todaySegment = segments.find((segment) => segment.date === todayKst);
    const todayContinuousBeforeMs = todaySegment
      ? firstTrailingSinglePriceBookMs(orderbooks, todaySegment.session_close_ms)
      : null;
    const todayCandles = todaySegment
      ? candles.filter((candle) => candle.ts_ms >= todaySegment.session_open_ms && candle.ts_ms < todaySegment.session_close_ms)
      : [];
    const todayLive = todaySegment
      ? computeTradeVolumePoc(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        candles: todayCandles,
        rangeCount,
        segment: todaySegment,
        continuousBeforeMs: todayContinuousBeforeMs,
      })
      : computeTradeVolumePoc(trades, {
        date: todayKst,
        bandPct: LEGACY_TRADE_VOLUME_POC_BAND_PCT,
        continuousBeforeMs: todayContinuousBeforeMs,
      });
    const todaySeed = seedsByDate.get(todayKst);
    if (todayLive) out.push(todayLive);
    else if (todaySeed) out.push(tradeVolumePocFromWire(todaySeed));
    if (todayLive || todaySeed) seenDates.add(todayKst);
    for (const poc of candleFallbacks) {
      if (seenDates.has(poc.date)) continue;
      out.push(poc);
      seenDates.add(poc.date);
    }
    return out;
  }, [trades, seeds, todayKst, code, candles, segments, rangeCount, candleFallbacks, orderbooks]);
}
