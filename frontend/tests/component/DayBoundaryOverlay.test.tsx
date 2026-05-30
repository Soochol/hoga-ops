import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';

import DayBoundaryOverlay from '../../src/chart/DayBoundaryOverlay';
import { createVirtualAxis } from '../../src/util/virtualAxis';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  }
});

function makeMockChart(timeToCoordReturns: (sec: number) => number | null): IChartApi {
  const handlers: Array<(r: unknown) => void> = [];
  return {
    timeScale: () => ({
      timeToCoordinate: (sec: number) => timeToCoordReturns(sec),
      subscribeVisibleLogicalRangeChange: (h: (r: unknown) => void) => handlers.push(h),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
    chartElement: () => document.createElement('div'),
  } as unknown as IChartApi;
}

describe('DayBoundaryOverlay', () => {
  it('renders nothing for N=1 segments (no boundaries)', () => {
    const axis = createVirtualAxis([
      { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
    ]);
    const { container } = render(
      <DayBoundaryOverlay chart={makeMockChart(() => 100)} axis={axis} />,
    );
    expect(container.querySelectorAll('[data-day-boundary]').length).toBe(0);
  });

  it('renders N-1 boundary divs for N segments', () => {
    const axis = createVirtualAxis([
      { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
      { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
      { date: '20260514', sessionOpenMs: 5_000_000, sessionCloseMs: 6_000_000 },
    ]);
    render(<DayBoundaryOverlay chart={makeMockChart(() => 200)} axis={axis} />);
    // 3 segments → 2 boundaries
    expect(document.querySelectorAll('[data-day-boundary]').length).toBe(2);
  });

  it('renders the divider only — no date chip (the adaptive x-axis owns dates)', () => {
    const axis = createVirtualAxis([
      { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
      { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
    ]);
    const { container } = render(
      <DayBoundaryOverlay chart={makeMockChart(() => 150)} axis={axis} />,
    );
    // The MM/DD chip was removed (commit b6cd06f) — date/month labels are now
    // rendered by the x-axis (util/kstHorzScaleBehavior). The boundary div is a
    // bare divider with no text content.
    expect(screen.queryByText('5/13')).not.toBeInTheDocument();
    const boundary = container.querySelector('[data-day-boundary]');
    expect(boundary).not.toBeNull();
    expect(boundary?.textContent).toBe('');
  });
});
