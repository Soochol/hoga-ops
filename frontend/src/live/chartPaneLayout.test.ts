import { describe, expect, it } from 'vitest';
import {
  CHART_TIME_AXIS_PX,
  MIN_AUX_PANE_PX,
  MIN_CANDLE_PANE_PX,
  chartPaneContentMinHeight,
} from './chartPaneLayout';

describe('chartPaneContentMinHeight', () => {
  it('캔들 하나에도 캔들 최소 높이와 시간축을 보장한다', () => {
    expect(chartPaneContentMinHeight(1)).toBe(MIN_CANDLE_PANE_PX + CHART_TIME_AXIS_PX);
  });

  it('활성 보조 pane 마다 최소 높이와 구분선 예산을 더한다', () => {
    expect(chartPaneContentMinHeight(6)).toBe(
      MIN_CANDLE_PANE_PX + 5 * MIN_AUX_PANE_PX + 5 + CHART_TIME_AXIS_PX,
    );
  });

  it('잘못된 pane 수는 캔들 하나로 조인다', () => {
    expect(chartPaneContentMinHeight(0)).toBe(chartPaneContentMinHeight(1));
  });
});
