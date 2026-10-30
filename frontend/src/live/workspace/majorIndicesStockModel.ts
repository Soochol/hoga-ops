import type { LivePastCandle } from '../../api/livePastCandles';
import type { TradeSnapshot } from '../bucketHogaSeries';
import { regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';

export interface StockClosePoint { tMs: number; close: number }

/** One selected trading day, with live trades updating only the REST tail. */
export function buildStockClosePoints(date: string, now: number, candles: readonly LivePastCandle[], trades: readonly TradeSnapshot[]): StockClosePoint[] {
  const start = regularSessionOpenMs(date), end = Math.min(now, regularSessionCloseMs(date));
  const byTime = new Map<number, number>();
  for (const candle of candles) {
    if (Number.isFinite(candle.t_ms) && candle.t_ms >= start && candle.t_ms <= end && Number.isFinite(candle.close) && candle.close > 0) {
      byTime.set(Math.floor(candle.t_ms / 60_000) * 60_000, candle.close);
    }
  }
  const lastRest = Math.max(start, ...byTime.keys());
  const tail = new Map<number, { tMs: number; close: number }>();
  for (const snapshot of trades) for (const trade of snapshot.trades) {
    const time = trade.t_ms ?? snapshot.t_ms;
    if (!Number.isFinite(time) || time < start || time > end || typeof trade.price !== 'number' || !Number.isFinite(trade.price) || trade.price <= 0
      || !Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    const bucket = Math.floor(time / 60_000) * 60_000;
    if (bucket < lastRest || (tail.get(bucket)?.tMs ?? -Infinity) > time) continue;
    tail.set(bucket, { tMs: time, close: trade.price });
  }
  for (const [time, point] of tail) byTime.set(time, point.close);
  return [...byTime].sort((a, b) => a[0] - b[0]).map(([tMs, close]) => ({ tMs, close }));
}

/** The stock has its own hidden scale; its price never enters the index scale. */
export function stockCloseRange(points: readonly StockClosePoint[]): { min: number; max: number } | null {
  if (!points.length) return null;
  const values = points.map(point => point.close);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = high === low ? Math.max(1, Math.abs(high) * .001) : (high - low) * .05;
  return { min: low - padding, max: high + padding };
}
