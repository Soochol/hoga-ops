import type { DepthHeatmapPoint } from './depthHeatmapWire';

const GAMMA = 0.65;

/** 한 호가 레벨의 불투명도. qty/visibleMax를 감마 보정 후 maxOpacity 스케일. */
export function levelAlpha(qty: number, visibleMax: number, maxOpacity: number): number {
  if (visibleMax <= 0 || qty <= 0) return 0;
  const ratio = Math.min(1, qty / visibleMax);
  return maxOpacity * Math.pow(ratio, GAMMA);
}

/** 보이는 unix-ms 범위 [fromMs, toMs] 내 모든 매수·매도 레벨 잔량의 최댓값. */
export function visibleMaxQty(
  points: readonly DepthHeatmapPoint[],
  fromMs: number,
  toMs: number,
): number {
  let max = 0;
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    for (const lvl of pt.asks) if (lvl.qty > max) max = lvl.qty;
    for (const lvl of pt.bids) if (lvl.qty > max) max = lvl.qty;
  }
  return max;
}
