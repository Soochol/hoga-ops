import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ChartErrorBoundary from '../../src/chart/ChartErrorBoundary';

function Boom({ msg }: { msg: string }) {
  throw new Error(msg);
}

describe('ChartErrorBoundary', () => {
  // Suppress React's error log noise from intentional throws.
  const origErr = console.error;
  afterEach(() => {
    console.error = origErr;
  });

  it('renders children when no error', () => {
    render(
      <ChartErrorBoundary>
        <div>chart content</div>
      </ChartErrorBoundary>,
    );
    expect(screen.getByText('chart content')).toBeInTheDocument();
  });

  it('renders fallback UI and preserves sibling layout when a child throws', () => {
    console.error = vi.fn();
    render(
      <ChartErrorBoundary>
        <Boom msg="lightweight-charts assert" />
      </ChartErrorBoundary>,
    );
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    // The error message itself should be surfaced so users can copy-paste it.
    expect(screen.getByText(/lightweight-charts assert/)).toBeInTheDocument();
  });

  it('exposes a reset button that re-renders children after fix', () => {
    console.error = vi.fn();
    let shouldThrow = true;
    function Toggling() {
      if (shouldThrow) throw new Error('boom');
      return <div>recovered</div>;
    }
    const { getByRole, rerender } = render(
      <ChartErrorBoundary>
        <Toggling />
      </ChartErrorBoundary>,
    );
    // Fallback shown
    expect(screen.getByText(/차트 렌더링에 실패했습니다/)).toBeInTheDocument();
    // Simulate fix
    shouldThrow = false;
    getByRole('button', { name: /다시 시도/ }).click();
    rerender(
      <ChartErrorBoundary>
        <Toggling />
      </ChartErrorBoundary>,
    );
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
