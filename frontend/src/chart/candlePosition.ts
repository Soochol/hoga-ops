import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';

type Position = ReturnType<VirtualAxis['classifyAndProject']>;
const positions = new WeakMap<VirtualAxis, WeakMap<Candle, Position>>();

/** Candle, volume, MA and cursor indexing use the same immutable candle/axis.
 * Classify that pair once after a prepend rather than searching sessions four
 * times. Weak keys release old axes and corrected candle objects naturally. */
export function candlePosition(candle: Candle, axis: VirtualAxis): Position {
  let cache = positions.get(axis);
  if (!cache) { cache = new WeakMap(); positions.set(axis, cache); }
  let position = cache.get(candle);
  if (!position) {
    position = axis.classifyAndProject(candle.ts_ms);
    cache.set(candle, position);
  }
  return position;
}
