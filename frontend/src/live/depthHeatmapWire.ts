import type { DepthHeatmapPointWire } from '../api/types';

export type DepthHeatmapLevel = { price: number; qty: number };
export type DepthHeatmapPoint = {
  tMs: number;
  asks: DepthHeatmapLevel[];
  bids: DepthHeatmapLevel[];
  asksMax: DepthHeatmapLevel[];
  bidsMax: DepthHeatmapLevel[];
};

function levels(pairs: readonly [number, number][]): DepthHeatmapLevel[] {
  return pairs.map(([price, qty]) => ({ price, qty }));
}

export function depthHeatmapFromWire(
  points: readonly DepthHeatmapPointWire[] | null | undefined,
): DepthHeatmapPoint[] {
  return (points ?? []).map((p) => ({
    tMs: p.t_ms,
    asks: levels(p.asks),
    bids: levels(p.bids),
    asksMax: levels(p.asks_max ?? []),
    bidsMax: levels(p.bids_max ?? []),
  }));
}

function pairs(ls: readonly DepthHeatmapLevel[]): [number, number][] {
  return ls.map((l) => [l.price, l.qty]);
}

/** Live domain depth-heatmap point → wire (camelCase levels → [price, qty]). */
export function depthPointToWire(p: DepthHeatmapPoint): DepthHeatmapPointWire {
  return {
    t_ms: p.tMs,
    asks: pairs(p.asks),
    bids: pairs(p.bids),
    asks_max: pairs(p.asksMax),
    bids_max: pairs(p.bidsMax),
  };
}

/** Overlay today's live-ratcheted depth buckets on top of the sidecar's
 * PAST+today-so-far wire array. Dedup by `t_ms`, ascending; today (live) wins
 * per overlapping bucket — mirrors `api/range.ts`'s depth_heatmap uniqueBy
 * latest-wins and the `mergePriceLevelHits` overlay. Past wire points pass
 * through untouched (same reference); today domain points convert to wire. */
export function mergeDepthHeatmapToday(
  past: readonly DepthHeatmapPointWire[] | undefined,
  today: readonly DepthHeatmapPoint[],
): DepthHeatmapPointWire[] {
  const byT = new Map<number, DepthHeatmapPointWire>();
  for (const p of past ?? []) byT.set(p.t_ms, p);
  for (const p of today) byT.set(p.tMs, depthPointToWire(p)); // today wins
  return [...byT.values()].sort((a, b) => a.t_ms - b.t_ms);
}
