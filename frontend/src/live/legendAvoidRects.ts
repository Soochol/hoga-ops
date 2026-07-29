import type { AvoidRect } from '../chart/highLowLabelLayout';

/** 레전드 오버레이는 lwc 컨테이너의 **형제가 아니라** 그 위 래퍼 아래에 산다
 *  (`live-chart-canvas` 를 한 겹 더 감싼 노드). 직계 부모만 보면 조용히 못 찾아
 *  회피가 통째로 죽으므로, 조상을 몇 겹 거슬러 올라가며 찾는다. */
export function findLegendRoot(chartEl: Element): Element | null {
  let node: Element | null = chartEl.parentElement;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    const found = node.querySelector('[data-testid="pane-legend-overlay"]');
    if (found) return found;
    node = node.parentElement;
  }
  return null;
}

/**
 * Pane Legend 행 rect 실측 → 캔들 pane 로컬 px(고저 극값 라벨의 회피 입력). 좌표 원점은
 * lwc 컨테이너 좌상단 — pane 0(캔들) 캔버스의 좌상단과 일치한다(좌측 가격축 없음).
 * 레전드는 별도 DOM 오버레이라 실측이 정본이고(행 수·폭이 데이터/토글/크로스헤어 호버
 * 따라 변함), 픽셀 위치는 팬으로 바뀌지 않으므로 primitive 의 draw 안이 아니라 host 의
 * 재측정 경로에서 부른다 — draw 에서 getBoundingClientRect 를 부르면 매 프레임 강제
 * 레이아웃을 유발한다.
 */
export function legendAvoidRects(chartEl: Element, paneHeight: number): AvoidRect[] {
  if (!(paneHeight > 0)) return [];
  const origin = chartEl.getBoundingClientRect?.();
  if (!origin) return [];
  const legendRoot = findLegendRoot(chartEl);
  if (!legendRoot) return [];
  const rects: AvoidRect[] = [];
  for (const stack of Array.from(legendRoot.children)) {
    for (const row of Array.from(stack.children)) {
      const r = row.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const top = r.top - origin.top;
      if (top >= paneHeight) continue; // 하위 pane(거래량 등)의 레전드 행은 무관.
      rects.push({
        top,
        bottom: r.bottom - origin.top,
        left: r.left - origin.left,
        right: r.right - origin.left,
      });
    }
  }
  return rects;
}
