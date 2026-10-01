import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { candlePosition } from './candlePosition';

type DrawnCandleIndex = {
  drawn: Candle[];
  vsecToIndex: Map<number, number>;
  tsMsToIndex: Map<number, number>;
};
type Entry = {
  source: readonly Candle[];
  times: number[];
  positions: number[];
  index: DrawnCandleIndex;
};
// Each axis owns only its latest revision. No chain of historical arrays is retained.
const latest = new WeakMap<VirtualAxis, Entry>();
export const EMPTY_DRAWN_CANDLE_INDEX: DrawnCandleIndex = {
  drawn: [], vsecToIndex: new Map(), tsMsToIndex: new Map(),
};

/** Tooltip and legend share projection work. Price corrections refresh objects,
 * but an unchanged time grid reuses both maps without reclassifying sessions.
 * Timestamp corrections, prepends and axis changes rebuild the grid safely.
 */
export function drawnCandleIndex(candles: readonly Candle[], axis: VirtualAxis): DrawnCandleIndex {
  const prior = latest.get(axis);
  if (prior?.source === candles) return prior.index;
  const samePrefix = prior && candles.length >= prior.times.length
    && prior.times.every((t, i) => candles[i].ts_ms === t);
  const positions = samePrefix ? [...prior.positions] : [];
  let vsecToIndex = samePrefix ? prior.index.vsecToIndex : new Map<number, number>();
  let tsMsToIndex = samePrefix ? prior.index.tsMsToIndex : new Map<number, number>();
  const from = samePrefix ? prior.times.length : 0;
  if (samePrefix && candles.length > from) {
    vsecToIndex = new Map(vsecToIndex);
    tsMsToIndex = new Map(tsMsToIndex);
  }
  for (let i = from; i < candles.length; i++) {
    const t = candles[i].ts_ms;
    const projected = candlePosition(candles[i], axis);
    if (!projected.contained) continue;
    const index = positions.length;
    positions.push(i);
    vsecToIndex.set(projected.virtual / 1000, index);
    tsMsToIndex.set(t, index);
  }
  const index = { drawn: positions.map(i => candles[i]), vsecToIndex, tsMsToIndex };
  latest.set(axis, { source: candles, times: candles.map(c => c.ts_ms), positions, index });
  return index;
}
