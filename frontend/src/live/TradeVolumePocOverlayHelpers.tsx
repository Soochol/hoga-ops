import type { Time } from 'lightweight-charts';
import type { Candle, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { type TradeVolumePocSegment } from '../chart/TradeVolumePocPrimitive';
import type { TradeVolumePoc } from './tradeVolumePoc';


export function buildTradeVolumePocSegments(
  pocs: readonly TradeVolumePoc[],
  segments: readonly RangeSegment[],
  candles: readonly Candle[],
  axis: VirtualAxis,
  todayKst: string,
  fillColor: string,
): TradeVolumePocSegment[] {
  if (pocs.length === 0 || candles.length === 0) return [];
  const byDate = new Map(segments.map((s) => [s.date, s]));
  const sorted = candles.every((c, i) => i === 0 || candles[i - 1].ts_ms <= c.ts_ms);
  const bound = (ms: number, inclusive: boolean) => {
    let lo = 0;
    let hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (candles[mid].ts_ms < ms || (inclusive && candles[mid].ts_ms === ms)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const lastCandle = candles[candles.length - 1];
  const out: TradeVolumePocSegment[] = [];
  for (const poc of pocs) {
    const segment = byDate.get(poc.date);
    if (!segment) continue;
    const rawEndMs = poc.date === todayKst ? lastCandle.ts_ms : segment.session_close_ms;
    // Only endpoints are used; avoid scanning/allocating all history for every
    // daily POC. Retain the old ordering semantics for defensive unsorted input.
    const first = sorted ? bound(segment.session_open_ms, false) : 0;
    const end = sorted ? bound(Math.min(segment.session_close_ms, rawEndMs), true) : 0;
    const segmentCandles = sorted ? candles.slice(first, end) : candles.filter(
      (candle) =>
        candle.ts_ms >= segment.session_open_ms
        && candle.ts_ms <= segment.session_close_ms
        && candle.ts_ms <= rawEndMs,
    );
    if (segmentCandles.length === 0) continue;
    const startMs = Math.max(segment.session_open_ms, segmentCandles[0].ts_ms);
    const endMs = Math.min(rawEndMs, segmentCandles[segmentCandles.length - 1].ts_ms);
    if (endMs < startMs) continue;
    out.push({
      time0: (axis.toVirtual(startMs) / 1000) as Time,
      time1: (axis.toVirtual(endMs) / 1000) as Time,
      lowPrice: poc.lowPrice,
      highPrice: poc.highPrice,
      fillColor,
    });
  }
  return out;
}
