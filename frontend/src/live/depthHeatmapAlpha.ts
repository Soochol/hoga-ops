import { depthLevelsOf, type DepthHeatmapPoint, type DepthHeatmapSource } from './depthHeatmapWire';

const GAMMA = 0.65;

/** 정렬된 시계열에서 양끝을 포함하는 가시 구간만 선택한다. O(log N + V). */
export function sliceDepthHeatmapRange(
  points: readonly DepthHeatmapPoint[],
  fromMs: number,
  toMs: number,
): readonly DepthHeatmapPoint[] {
  if (fromMs > toMs) return [];
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].tMs < fromMs) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].tMs <= toMs) lo = mid + 1;
    else hi = mid;
  }
  return start === 0 && lo === points.length ? points : points.slice(start, lo);
}

/** 한 호가 레벨의 불투명도. qty/visibleMax를 감마 보정 후 maxOpacity 스케일. */
export function levelAlpha(qty: number, visibleMax: number, maxOpacity: number): number {
  if (visibleMax <= 0 || qty <= 0) return 0;
  const ratio = Math.min(1, qty / visibleMax);
  return maxOpacity * Math.pow(ratio, GAMMA);
}

/** 보이는 unix-ms 범위 [fromMs, toMs] 내 모든 매수·매도 레벨 잔량의 최댓값.
 *  소스는 `depthLevelsOf` 가 고른다 — **셀 빌드가 쓰는 소스와 반드시 일치해야**
 *  정규화 스케일이 맞는다. 그래서 소스 선택을 여기서 삼항식으로 다시 적지 않는다
 *  (종전엔 `intraMax ? asksMax : asks` 가 이 파일에도 따로 있었다). */
export function visibleMaxQty(
  points: readonly DepthHeatmapPoint[],
  fromMs: number,
  toMs: number,
  source: DepthHeatmapSource = 'close',
): number {
  let max = 0;
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    for (const lvl of depthLevelsOf(pt, 'ask', source)) if (lvl.qty > max) max = lvl.qty;
    for (const lvl of depthLevelsOf(pt, 'bid', source)) if (lvl.qty > max) max = lvl.qty;
  }
  return max;
}
