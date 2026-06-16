import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { VirtualAxis } from '../util/virtualAxis';

function makeChart() {
  const subscribers = new Set<() => void>();
  return {
    timeScale: () => ({
      timeToCoordinate: vi.fn(() => 120),
      subscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.add(cb)),
      unsubscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.delete(cb)),
    }),
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
});
