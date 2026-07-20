import { netDeltaQty, type DepthDeltaPoint } from './depthDelta';

/** 보이는 unix-ms 범위 [fromMs, toMs] 내 **순증감 절댓값**의 최댓값 — 셀 강도 정규화 천장.
 *
 *  히트맵의 `visibleMaxQty` 와 같은 역할이지만 소스가 부호 있는 값이라 별도 함수가 필요하다.
 *  ⚠️ 정규화 천장은 셀 빌더가 실제로 그리는 값(=|net|)과 **같은 소스**여야 한다 —
 *  gross(in+out)로 천장을 잡고 net 으로 칠하면 모든 셀이 흐려진다. */
export function visibleMaxAbsDelta(
  points: readonly DepthDeltaPoint[],
  fromMs: number,
  toMs: number,
): number {
  let max = 0;
  for (const pt of points) {
    if (pt.tMs < fromMs || pt.tMs > toMs) continue;
    for (const lvl of pt.askDelta) {
      const v = Math.abs(netDeltaQty(lvl));
      if (v > max) max = v;
    }
    for (const lvl of pt.bidDelta) {
      const v = Math.abs(netDeltaQty(lvl));
      if (v > max) max = v;
    }
  }
  return max;
}
