/** Apply an immutable query response once. Publishing a merged result changes
 * the hook's previous-data dependency; merging that same response again would
 * allocate identical history on every parent render (including live ticks).
 * A different previous snapshot or response still runs the normal merge. */
export function createDeltaResponseMerger<T>(merge: (previous: T, response: T) => T) {
  let applied: { previous: T; response: T; result: T } | undefined;
  return (previous: T, response: T): T => {
    if (previous === response) return previous;
    if (applied?.response === response) {
      if (applied.result === previous) return previous;
      if (applied.previous === previous) return applied.result;
    }
    const result = merge(previous, response);
    applied = { previous, response, result };
    return result;
  };
}
