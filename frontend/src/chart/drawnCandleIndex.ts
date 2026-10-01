import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { candlePosition } from './candlePosition';

type DrawnCandleIndex = {
  drawn: Candle[];
  virtualSeconds: readonly number[];
  vsecToIndex: ReadonlyMap<number, number>;
  tsMsToIndex: ReadonlyMap<number, number>;
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
  drawn: [], virtualSeconds: [], vsecToIndex: new Map(), tsMsToIndex: new Map(),
};

/** Strictly sorted unique keys need no hash table. Cursor reads search only
 * log(n) retained candles; iterators preserve the ReadonlyMap contract without
 * materializing two full-history maps on every axis rebase. */
function sortedLookup(length: number, keyAt: (index: number) => number): ReadonlyMap<number, number> {
  const lookup: ReadonlyMap<number, number> = {
    size: length,
    get(key) {
      let lo = 0, hi = length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (keyAt(mid) < key) lo = mid + 1;
        else hi = mid;
      }
      return lo < length && keyAt(lo) === key ? lo : undefined;
    },
    has(key) { return lookup.get(key) !== undefined; },
    *entries() { for (let i = 0; i < length; i++) yield [keyAt(i), i] as [number, number]; },
    *keys() { for (let i = 0; i < length; i++) yield keyAt(i); },
    *values() { for (let i = 0; i < length; i++) yield i; },
    [Symbol.iterator]() { return lookup.entries(); },
    forEach(callback, thisArg) {
      for (let i = 0; i < length; i++) callback.call(thisArg, i, keyAt(i), lookup);
    },
  };
  return lookup;
}

/** Tooltip and legend share projection work. Price corrections refresh objects,
 * but an unchanged time grid reuses both lookups without reclassifying sessions.
 * Timestamp corrections, prepends and axis changes rebuild the grid safely.
 * Duplicate or unsorted keys retain Map's last-write and insertion-order rules.
 */
export function drawnCandleIndex(candles: readonly Candle[], axis: VirtualAxis): DrawnCandleIndex {
  const prior = latest.get(axis);
  if (prior?.source === candles) return prior.index;
  const samePrefix = prior && candles.length >= prior.times.length
    && prior.times.every((t, i) => candles[i].ts_ms === t);
  const positions = samePrefix ? [...prior.positions] : [];
  const from = samePrefix ? prior.times.length : 0;
  const drawn = samePrefix ? positions.map(i => candles[i]) : [];
  const virtualSeconds = samePrefix ? [...prior.index.virtualSeconds] : [];
  let realSorted = true, virtualSorted = true;
  let previousReal = -Infinity, previousVirtual = -Infinity;
  if (samePrefix && from < candles.length) {
    for (let i = 0; i < drawn.length; i++) {
      const candle = drawn[i];
      const virtual = virtualSeconds[i];
      if (!Number.isFinite(candle.ts_ms) || candle.ts_ms <= previousReal) realSorted = false;
      if (!Number.isFinite(virtual) || virtual <= previousVirtual) virtualSorted = false;
      previousReal = candle.ts_ms;
      previousVirtual = virtual;
    }
  }
  for (let i = from; i < candles.length; i++) {
    const candle = candles[i];
    const projected = candlePosition(candle, axis);
    if (!projected.contained) continue;
    const virtual = projected.virtual / 1000;
    if (!Number.isFinite(candle.ts_ms) || candle.ts_ms <= previousReal) realSorted = false;
    if (!Number.isFinite(virtual) || virtual <= previousVirtual) virtualSorted = false;
    previousReal = candle.ts_ms;
    previousVirtual = virtual;
    positions.push(i);
    drawn.push(candle);
    virtualSeconds.push(virtual);
  }
  const unchanged = samePrefix && candles.length === from;
  // Lookups retain numeric keys only; price corrections must not keep an old
  // full candle-object revision alive through a key-reader closure.
  const times = unchanged ? prior.times : candles.map(c => c.ts_ms);
  const vsecToIndex = unchanged ? prior.index.vsecToIndex : virtualSorted
    ? sortedLookup(drawn.length, i => virtualSeconds[i])
    : new Map(virtualSeconds.map((time, i) => [time, i]));
  const tsMsToIndex = unchanged ? prior.index.tsMsToIndex : realSorted
    ? sortedLookup(drawn.length, i => times[positions[i]])
    : new Map(drawn.map((c, i) => [c.ts_ms, i]));
  const index = { drawn, virtualSeconds, vsecToIndex, tsMsToIndex };
  latest.set(axis, { source: candles, times, positions, index });
  return index;
}
