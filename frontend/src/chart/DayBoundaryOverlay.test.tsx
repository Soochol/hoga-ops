import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { VirtualAxis } from '../util/virtualAxis';

function makeChart() {
  const subscribers = new Set<() => void>();
  const timeScale = {
    timeToCoordinate: vi.fn(() => 120),
    subscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.add(cb)),
    unsubscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.delete(cb)),
  };

  return {
    timeScale: () => timeScale,
  };
}

const axis = {
  segments: [
    { date: '20260615' },
    { date: '20260616' },
  ],
  dayBoundaries: [
    { date: '20260616', virtualStart: 1_800_000 },
  ],
} as unknown as VirtualAxis;

describe('DayBoundaryOverlay', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  afterEach(cleanup);

  it('renders no boundary when disabled', () => {
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    render(<DayBoundaryOverlay chart={makeChart() as never} axis={axis} />);

    expect(screen.queryByTestId('day-boundary-20260616')).toBeNull();
  });

  it('applies configured color and line width', () => {
    useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#EF4444', lineWidth: 3 });
    render(<DayBoundaryOverlay chart={makeChart() as never} axis={axis} />);

    const boundary = screen.getByTestId('day-boundary-20260616');
    expect(boundary.style.width).toBe('3px');
    expect(boundary.style.backgroundImage).toContain('rgb(239, 68, 68)');
  });

  it('attaches the resize observer after enabling from a disabled start', async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const ResizeObserverMock = vi.fn(function ResizeObserverMock() {
      return { observe, disconnect };
    });
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ResizeObserverMock as never;
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);

    try {
      render(
        <div data-testid="chart-host">
          <DayBoundaryOverlay chart={makeChart() as never} axis={axis} />
        </div>,
      );

      expect(observe).not.toHaveBeenCalled();

      act(() => {
        useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', true);
      });

      await waitFor(() => {
        expect(observe).toHaveBeenCalledWith(screen.getByTestId('chart-host'));
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
