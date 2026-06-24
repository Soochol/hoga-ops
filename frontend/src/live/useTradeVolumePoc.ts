import { useMemo } from 'react';
import type { TradeVolumePocWire } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import type { TradeSnapshot } from './bucketHogaSeries';
import { computeTradeVolumePoc, type TradeVolumePoc } from './tradeVolumePoc';

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
): TradeVolumePoc[] {
  const bandPct = useLivePageStore((s) => s.tradeVolumePocBandPct);
  return useMemo(() => {
    const matchingSeeds = seeds.filter((p) => matchesBandPct(p.band_pct, bandPct));
    const out = matchingSeeds.filter((p) => p.date !== todayKst).map(fromWire);
    const todayLive = computeTradeVolumePoc(trades, { date: todayKst, bandPct });
    const todaySeed = matchingSeeds.find((p) => p.date === todayKst);
    if (todayLive) out.push(todayLive);
    else if (todaySeed) out.push(fromWire(todaySeed));
    return out;
  }, [trades, seeds, todayKst, code, bandPct]);
}
