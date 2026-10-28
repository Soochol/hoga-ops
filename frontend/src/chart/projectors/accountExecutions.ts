import type { Time } from 'lightweight-charts';
import type { AccountExecution } from '../../api/accountExecutions';
import type { Candle } from '../../api/types';
import type { LiveTimeframe } from '../../state/livePage';
import type { VirtualAxis } from '../../util/virtualAxis';
import { realMsToYyyymmdd } from '../../live/liveDateTime';
import { candlePosition } from '../candlePosition';
import { lowerBoundCandle } from './candle';

export type ExecutionMarker = {
  time: Time;
  price: number;
  side: 'BUY' | 'SELL';
  executions: AccountExecution[];
  barExecutions: AccountExecution[];
};

/** Keep real fill prices/times intact; only display coordinates use the candle's price basis. */
export function projectAccountExecutions(
  rows: readonly AccountExecution[], candles: readonly Candle[], axis: VirtualAxis, timeframe: LiveTimeframe,
  factors: Readonly<Record<string, number>> | undefined, rawCloses: Readonly<Record<string, number>>, today: string,
) {
  const daily = timeframe === 'D';
  const bucket = /^\d+m$/.test(timeframe) ? Number.parseInt(timeframe, 10) * 60_000 : 0;
  const byDate = new Map(candles.map(c => [realMsToYyyymmdd(c.ts_ms), c]));
  const markers = new Map<string, ExecutionMarker>();
  const byBar = new Map<number, AccountExecution[]>();
  const unmatched: AccountExecution[] = [], unscaled: AccountExecution[] = [];
  for (const row of rows) {
    let candle: Candle | undefined;
    if (daily) candle = byDate.get(row.trading_date);
    else if (bucket > 0 && axis.contains(row.t_ms)) {
      const after = lowerBoundCandle(candles, row.t_ms + 1);
      const candidate = candles[after - 1];
      if (candidate && candidate.ts_ms <= row.t_ms && row.t_ms < candidate.ts_ms + bucket
        && realMsToYyyymmdd(candidate.ts_ms) === row.trading_date) candle = candidate;
    }
    if (!candle || !candlePosition(candle, axis).contained) { unmatched.push(row); continue; }
    const rawPrice = Number(row.price);
    const factor = daily
      ? row.trading_date === today ? 1 : rawCloses[row.trading_date] > 0 ? candle.close / rawCloses[row.trading_date] : undefined
      : factors?.[row.trading_date] ?? (factors === undefined || row.trading_date === today ? 1 : undefined);
    if (factor === undefined || !Number.isFinite(factor) || factor <= 0 || !Number.isFinite(rawPrice) || rawPrice <= 0) {
      unscaled.push(row); continue;
    }
    const barRows = byBar.get(candle.ts_ms) ?? [];
    barRows.push(row); byBar.set(candle.ts_ms, barRows);
    const price = row.basis === 'order_average' ? rawPrice * factor : Math.round(rawPrice * factor);
    const key = `${candle.ts_ms}:${price}:${row.side}`;
    const marker = markers.get(key);
    if (marker) marker.executions.push(row);
    else markers.set(key, { time: (candlePosition(candle, axis).virtual / 1000) as Time, price,
      side: row.side, executions: [row], barExecutions: barRows });
  }
  return { markers: [...markers.values()], unmatched, unscaled };
}

export type PlottedExecution = { marker: ExecutionMarker; x: number; y: number };

/** Change horizontal label position only. Its y always denotes the exact execution price. */
export function layoutExecutionMarkers(points: readonly PlottedExecution[], width: number, height: number): PlottedExecution[] {
  const placed: PlottedExecution[] = [];
  for (const point of points) {
    if (point.x < 0 || point.x > width || point.y < 7 || point.y > height - 7) continue;
    const shared = points.some(p => p !== point && p.x === point.x && Math.abs(p.y - point.y) < 12 && p.marker.side !== point.marker.side);
    const side = point.marker.side === 'BUY' ? -1 : 1;
    const offsets = shared ? [side * 8, side * 20] : [0, side * 14, -side * 14];
    for (const offset of offsets) {
      const x = point.x + offset;
      if (x < 7 || x > width - 7 || placed.some(p => Math.abs(p.x - x) < 12 && Math.abs(p.y - point.y) < 13)) continue;
      placed.push({ ...point, x });
      break;
    }
  }
  return placed;
}
