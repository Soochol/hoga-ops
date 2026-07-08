import type { DepthHeatmapPoint } from './depthHeatmapWire';

const GAMMA = 0.65;

/** 한 호가 레벨의 불투명도. qty/visibleMax를 감마 보정 후 maxOpacity 스케일. */
export function levelAlpha(qty: number, visibleMax: number, maxOpacity: number): number {
  if (visibleMax <= 0 || qty <= 0) return 0;
  const ratio = Math.min(1, qty / visibleMax);
  return maxOpacity * Math.pow(ratio, GAMMA);
}

/** 보이는 unix-ms 범위 [fromMs, toMs] 내 모든 매수·매도 레벨 잔량의 최댓값.
 *  intraMax=true면 종가 스냅샷 대신 분봉 내 최대 총잔량 스냅샷(asksMax/bidsMax)을
 *  스캔한다 — 셀 빌드가 쓰는 소스와 반드시 일치해야 정규화 스케일이 맞는다. */
export function visibleMaxQty(
  points: readonly DepthHeatmapPoint[],
  fromMs: number,
  toMs: number,
  intraMax = false,
): number {
  let max = 0;
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    const asks = intraMax ? pt.asksMax : pt.asks;
    const bids = intraMax ? pt.bidsMax : pt.bids;
    for (const lvl of asks) if (lvl.qty > max) max = lvl.qty;
    for (const lvl of bids) if (lvl.qty > max) max = lvl.qty;
  }
  return max;
}
