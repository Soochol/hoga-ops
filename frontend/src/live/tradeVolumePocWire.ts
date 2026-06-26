import type { TradeVolumePocWire } from '../api/types';
import type { TradeVolumePoc } from './tradeVolumePoc';

export function tradeVolumePocFromWire(poc: TradeVolumePocWire): TradeVolumePoc {
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

export function tradeVolumePocsFromWire(pocs: readonly TradeVolumePocWire[] | null | undefined): TradeVolumePoc[] {
  return (pocs ?? []).map(tradeVolumePocFromWire);
}
