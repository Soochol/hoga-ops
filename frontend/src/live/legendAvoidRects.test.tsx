import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { findLegendRoot, legendAvoidRects } from './legendAvoidRects';

/**
 * 레전드 회피 rect 실측만 따로 검증한다. 라벨 배치·좌표 산출은 캔버스 쪽
 * (HighLowLabelsPrimitive.test.ts)이 담당하고, 여기 남는 위험은 **DOM 탐색**이다:
 * 레전드 오버레이는 lwc 컨테이너의 형제가 아니라 한 겹 위 래퍼 아래에 있어서,
 * 직계 부모만 뒤지면 조용히 못 찾고 회피가 통째로 죽는다(도그푸딩에서 실제 발생).
 */
function renderChartTree() {
  return render(
    <div data-testid="wrapper">
      {/* 실제 DOM: lwc 컨테이너는 한 겹 더 감싸여 있고 레전드는 그 바깥 형제다. */}
      <div className="live-chart-canvas">
        <div data-testid="chart-el" />
      </div>
      <div data-testid="pane-legend-overlay">
        <div>
          <div data-legend-row="" />
        </div>
      </div>
    </div>,
  );
}

function stubRects() {
  return vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function measure(this: HTMLElement) {
      if (this.hasAttribute('data-legend-row')) {
        return { width: 640, height: 26, top: 104, left: 20, right: 660, bottom: 130, x: 20, y: 104, toJSON: () => ({}) } as DOMRect;
      }
      // 차트 컨테이너는 뷰포트 (20,100) 에 있다 → 레전드 행의 pane 로컬 좌표는 (0,4).
      return { width: 760, height: 300, top: 100, left: 20, right: 780, bottom: 400, x: 20, y: 100, toJSON: () => ({}) } as DOMRect;
    });
}

describe('legendAvoidRects', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('finds the legend overlay through an ancestor, not just the chart container parent', () => {
    renderChartTree();
    const chartEl = screen.getByTestId('chart-el');

    expect(chartEl.parentElement?.querySelector('[data-testid="pane-legend-overlay"]')).toBeNull();
    expect(findLegendRoot(chartEl)).toBe(screen.getByTestId('pane-legend-overlay'));
  });

  it('converts legend rows to candle-pane local coordinates', () => {
    renderChartTree();
    const spy = stubRects();
    try {
      expect(legendAvoidRects(screen.getByTestId('chart-el'), 300)).toEqual([
        { top: 4, bottom: 30, left: 0, right: 640 },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('drops rows that sit below the candle pane (하위 pane 레전드는 무관)', () => {
    renderChartTree();
    const spy = stubRects();
    try {
      // 캔들 pane 이 3px 뿐이면 top=4 인 행은 이미 아래 pane 소속이다.
      expect(legendAvoidRects(screen.getByTestId('chart-el'), 3)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns nothing before the pane height is known', () => {
    renderChartTree();
    expect(legendAvoidRects(screen.getByTestId('chart-el'), 0)).toEqual([]);
  });
});
