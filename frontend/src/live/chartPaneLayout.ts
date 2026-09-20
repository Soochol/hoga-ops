/**
 * 활성 pane 은 창 크기와 무관하게 항상 렌더한다. 공간이 모자라면 pane 을 제거하지
 * 않고 차트 surface 를 키워 바깥 viewport 가 세로 스크롤을 제공한다.
 *
 * 이 값은 lightweight-charts 의 stretch 배분을 대체하지 않는다. 단지 라이브러리가
 * 모든 pane 을 지나치게 얇은 몇 px 로 압축하지 않도록 전체 높이 예산의 하한만 준다.
 */
export const MIN_CANDLE_PANE_PX = 140;
export const MIN_AUX_PANE_PX = 40;
export const CHART_TIME_AXIS_PX = 28;
export const CHART_PANE_SEPARATOR_PX = 1;

export function chartPaneContentMinHeight(paneCount: number): number {
  const count = Math.max(1, Math.floor(paneCount));
  const auxCount = count - 1;
  return MIN_CANDLE_PANE_PX
    + auxCount * MIN_AUX_PANE_PX
    + auxCount * CHART_PANE_SEPARATOR_PX
    + CHART_TIME_AXIS_PX;
}
