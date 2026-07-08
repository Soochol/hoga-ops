import type { DepthHeatmapPointWire } from '../api/types';

export type DepthHeatmapLevel = { price: number; qty: number };
export type DepthHeatmapPoint = {
  tMs: number;
  asks: DepthHeatmapLevel[];
  bids: DepthHeatmapLevel[];
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
  }));
}
