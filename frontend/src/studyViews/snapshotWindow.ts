export function chooseSnapshotWindow<T>(
  bars: readonly T[],
  visibleFromIndex: number,
  visibleToIndex: number,
  minBars = 200,
): { fromIndex: number; toIndex: number } {
  if (bars.length === 0) return { fromIndex: 0, toIndex: -1 };

  const lo = Math.max(0, Math.min(visibleFromIndex, visibleToIndex));
  const hi = Math.min(bars.length - 1, Math.max(visibleFromIndex, visibleToIndex));
  const visibleCount = hi - lo + 1;
  if (visibleCount >= minBars) return { fromIndex: lo, toIndex: hi };

  const need = Math.min(minBars, bars.length) - visibleCount;
  const leftWant = Math.floor(need / 2);
  const rightWant = need - leftWant;
  let from = Math.max(0, lo - leftWant);
  let to = Math.min(bars.length - 1, hi + rightWant);

  const missingLeft = leftWant - (lo - from);
  const missingRight = rightWant - (to - hi);
  if (missingLeft > 0) to = Math.min(bars.length - 1, to + missingLeft);
  if (missingRight > 0) from = Math.max(0, from - missingRight);

  return { fromIndex: from, toIndex: to };
}
