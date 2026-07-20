import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartDrawingShell } from './ChartDrawingShell';

describe('ChartDrawingShell', () => {
  it('renders the chart body', () => {
    render(
      <ChartDrawingShell>
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    expect(screen.getByTestId('chart-body')).toBeInTheDocument();
  });

  // 44px 레일 컬럼은 #760 으로 폐기됐다 — 그리기는 헤더의 DrawingMenu 가 연다.
  // 셸이 남은 유일한 이유가 아래 트랙 규율이므로, 레일이 되살아나지 않는 것도
  // 함께 잠근다(되살아나면 차트가 다시 44px 을 상시로 잃는다).
  it('no longer reserves a rail column', () => {
    render(
      <ChartDrawingShell>
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    expect(screen.getByTestId('chart-drawing-shell')).not.toHaveClass('grid-cols-[44px_minmax(0,1fr)]');
    expect(screen.queryByTestId('live-drawing-rail')).not.toBeInTheDocument();
  });

  // 행 트랙을 잃으면 grid-auto-rows:auto 로 되돌아가고, auto 트랙의 자동 최소값(콘텐츠
  // min-content)이 차트 높이를 바닥으로 잡는다. lightweight-charts autoSize 가 그 셀을
  // 되재는 순환과 맞물려 차트가 축소 불가 상태로 고착되고 overflow-hidden 에 잘린다.
  // jsdom 은 그리드 레이아웃을 계산하지 않으므로 클래스 불변식으로 잠근다.
  it('constrains both grid axes to minmax(0,1fr) so the chart can shrink, not just grow', () => {
    render(
      <ChartDrawingShell>
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    const shell = screen.getByTestId('chart-drawing-shell');
    expect(shell).toHaveClass('grid-rows-[minmax(0,1fr)]');
    expect(shell).toHaveClass('grid-cols-[minmax(0,1fr)]');
  });
});
