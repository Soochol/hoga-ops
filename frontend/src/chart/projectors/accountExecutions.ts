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

type ExecutionPosition = PlottedExecution & { candleX: number; halfBarWidth: number };
export type ExecutionTick = ExecutionPosition & { endX: number };
export type ExecutionLabel = ExecutionPosition & { maxWidth: number };
export type ExecutionLayout = { ticks: ExecutionTick[]; labels: ExecutionLabel[] };

/** Price ticks never move or disappear when labels are grouped. All geometry stays in its bar column. */
export function layoutExecutionMarkers(
  points: readonly PlottedExecution[], width: number, height: number, barPitch: number,
): ExecutionLayout {
  const ticks: ExecutionTick[] = [], labels: ExecutionLabel[] = [];
  if (!Number.isFinite(barPitch) || barPitch <= 0) return { ticks, labels };
  // A conservative interior of the candle body; reserve the gaps for neighboring candles.
  const halfBody = barPitch * .35, halfBarWidth = barPitch / 2;
  const groups = new Map<Time, Map<ExecutionMarker['side'], PlottedExecution[]>>();
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > width || point.y < 0 || point.y > height) continue;
    const side = point.marker.side === 'BUY' ? -1 : 1;
    ticks.push({ ...point, candleX: point.x, halfBarWidth, endX: point.x + side * Math.min(6, halfBody * .3) });
    let bar = groups.get(point.marker.time);
    if (!bar) { bar = new Map(); groups.set(point.marker.time, bar); }
    const peers = bar.get(point.marker.side) ?? [];
    peers.push(point); bar.set(point.marker.side, peers);
  }
  for (const bar of groups.values()) {
    for (const [side, peers] of bar) {
      peers.sort((a, b) => a.y - b.y);
      let previousY = -Infinity;
      for (let start = 0; start < peers.length;) {
        let end = start + 1, sumY = peers[start].y;
        // Bound the whole group, rather than merging a chain spanning many different prices.
        while (end < peers.length && peers[end].y - peers[start].y < 14) sumY += peers[end++].y;
        const point = peers[start], direction = side === 'BUY' ? -1 : 1;
        const y = sumY / (end - start);
        // A sparse cluster next to a dense one can still collide; keep its ticks instead.
        if (y - previousY >= 14) {
          labels.push({ ...point, candleX: point.x, halfBarWidth,
            x: point.x + direction * Math.min(16, halfBody * .65), y,
            maxWidth: Math.min(10, halfBody * .7) });
          previousY = y;
        }
        start = end;
      }
    }
  }
  return { ticks, labels };
}
