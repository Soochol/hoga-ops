import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartDrawingShell } from './ChartDrawingShell';

describe('ChartDrawingShell', () => {
  it('renders the drawing rail beside the chart body in the shared 44px layout', () => {
    render(
      <ChartDrawingShell>
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    expect(screen.getByTestId('chart-drawing-shell')).toHaveClass('grid-cols-[44px_minmax(0,1fr)]');
    expect(screen.getByTestId('live-drawing-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chart-body')).toBeInTheDocument();
  });
});
