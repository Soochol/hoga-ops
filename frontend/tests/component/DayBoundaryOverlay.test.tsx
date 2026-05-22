import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';

import DayBoundaryOverlay from '../../src/chart/DayBoundaryOverlay';
import { buildSegments } from '../../src/util/time';

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
    const segs = buildSegments([
      { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
    ]);
    const { container } = render(
      <DayBoundaryOverlay chart={makeMockChart(() => 100)} segments={segs} />,
    );
    expect(container.querySelectorAll('[data-day-boundary]').length).toBe(0);
  });

  it('renders N-1 boundary divs for N segments', () => {
    const segs = buildSegments([
      { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
      { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
      { date: '20260514', sessionOpenMs: 5_000_000, sessionCloseMs: 6_000_000 },
    ]);
    render(<DayBoundaryOverlay chart={makeMockChart(() => 200)} segments={segs} />);
    // 3 segments → 2 boundaries
    expect(document.querySelectorAll('[data-day-boundary]').length).toBe(2);
  });

  it('renders MM/DD chip text matching segment date', () => {
    const segs = buildSegments([
      { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
      { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
    ]);
    render(<DayBoundaryOverlay chart={makeMockChart(() => 150)} segments={segs} />);
    expect(screen.getByText('5/13')).toBeInTheDocument();
  });
});
