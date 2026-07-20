import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartDrawingShell } from './ChartDrawingShell';

describe('ChartDrawingShell', () => {
  it('renders the drawing rail beside the chart body in the shared 44px layout', () => {
    render(
      <ChartDrawingShell code="005930" timeframe="1m">
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    expect(screen.getByTestId('chart-drawing-shell')).toHaveClass('grid-cols-[44px_minmax(0,1fr)]');
    expect(screen.getByTestId('live-drawing-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chart-body')).toBeInTheDocument();
  });

  // 행 트랙을 잃으면 grid-auto-rows:auto 로 되돌아가고, auto 트랙의 자동 최소값(콘텐츠
  // min-content)이 차트 높이를 바닥으로 잡는다. lightweight-charts autoSize 가 그 셀을
  // 되재는 순환과 맞물려 차트가 축소 불가 상태로 고착되고 overflow-hidden 에 잘린다.
  // jsdom 은 그리드 레이아웃을 계산하지 않으므로 클래스 불변식으로 잠근다.
  it('constrains both grid axes to minmax(0,1fr) so the chart can shrink, not just grow', () => {
    render(
      <ChartDrawingShell code="005930" timeframe="1m">
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    const shell = screen.getByTestId('chart-drawing-shell');
    expect(shell).toHaveClass('grid-rows-[minmax(0,1fr)]');
    expect(shell).toHaveClass('grid-cols-[44px_minmax(0,1fr)]');
  });
});
