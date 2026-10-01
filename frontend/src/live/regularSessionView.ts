import { isRegularSessionMs } from './aggregateCandles';

/** Restrict timestamped series while preserving identities of unchanged slices.
 * RangeBundle point times (t, t_ms, ts_ms) all use Unix milliseconds. */
export function filterRegularSession<T>(value: T): T {
  function visit(node: unknown): unknown {
    if (Array.isArray(node)) {
      const filtered = node.filter(item => {
        if (!item || typeof item !== 'object') return true;
        const point = item as Record<string, unknown>;
        const time = point.t_ms ?? point.ts_ms ?? point.t;
        return typeof time !== 'number' || isRegularSessionMs(time);
      }).map(visit);
      return filtered.length === node.length && filtered.every((item, i) => item === node[i]) ? node : filtered;
    }
    if (!node || typeof node !== 'object') return node;
    const entries = Object.entries(node);
    const mapped = entries.map(([key, item]) => [key, visit(item)] as const);
    return mapped.every((entry, i) => entry[1] === entries[i][1]) ? node : Object.fromEntries(mapped);
  }
  return visit(value) as T;
}
