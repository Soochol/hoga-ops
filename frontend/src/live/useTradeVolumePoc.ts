import { useMemo } from 'react';
import type { Candle, RangeSegment, TradeVolumePocWire } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import type { TradeSnapshot } from './bucketHogaSeries';
import { computeCandleVolumePocs, computeTradeVolumePoc, type TradeVolumePoc } from './tradeVolumePoc';

function matchesBandPct(value: number, target: number): boolean {
  return Math.abs(value - target) < 1e-9;
}

function fromWire(poc: TradeVolumePocWire): TradeVolumePoc {
  return {
    date: poc.date,
    centerPrice: poc.center_price,
    lowPrice: poc.low_price,
    highPrice: poc.high_price,
    qty: poc.qty,
    t_ms: poc.t_ms,
    bandPct: poc.band_pct,
  };
}

export function useTradeVolumePocs(
  trades: readonly TradeSnapshot[],
  seeds: readonly TradeVolumePocWire[],
  todayKst: string,
  code: string | null,
  candles: readonly Candle[] = [],
  segments: readonly RangeSegment[] = [],
): TradeVolumePoc[] {
  const bandPct = useLivePageStore((s) => s.tradeVolumePocBandPct);
  return useMemo(() => {
    const matchingSeeds = seeds.filter((p) => matchesBandPct(p.band_pct, bandPct));
    const out = matchingSeeds.filter((p) => p.date !== todayKst).map(fromWire);
    const seenDates = new Set(out.map((p) => p.date));
    const todayLive = computeTradeVolumePoc(trades, { date: todayKst, bandPct });
    const todaySeed = matchingSeeds.find((p) => p.date === todayKst);
    if (todayLive) out.push(todayLive);
    else if (todaySeed) out.push(fromWire(todaySeed));
    if (todayLive || todaySeed) seenDates.add(todayKst);
    const candleFallbacks = computeCandleVolumePocs(candles, segments, { bandPct });
    for (const poc of candleFallbacks) {
      if (seenDates.has(poc.date)) continue;
      out.push(poc);
      seenDates.add(poc.date);
    }
    return out;
  }, [trades, seeds, todayKst, code, candles, segments, bandPct]);
}
