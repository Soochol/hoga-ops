import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import BrokerTrajectoryTable, {
  netAtCursor,
  GAP_THRESHOLD_MS,
} from './BrokerTrajectoryTable';
import type { BrokerSeriesEntry } from '../api/types';

function entry(
  broker: string,
  points: { ts_ms: number; net: number }[],
  side: 'buy' | 'sell' = 'buy',
): BrokerSeriesEntry {
  const final_net = points.length ? points[points.length - 1].net : 0;
  return { broker, final_net, dominant_side: side, points };
}

describe('netAtCursor', () => {
  it('returns 0 when cursorMs is null', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, null)).toBe(0);
  });

  it('returns the latest net when cursor precedes broker first observation', () => {
    const e = entry('A', [{ ts_ms: 200, net: 5 }]);
    expect(netAtCursor(e, 100)).toBe(5);
  });

  it('returns the net of the last point at-or-before cursor', () => {
    const e = entry('A', [
      { ts_ms: 100, net: 5 },
      { ts_ms: 200, net: 10 },
      { ts_ms: 300, net: 15 },
    ]);
    expect(netAtCursor(e, 250)).toBe(10);
    expect(netAtCursor(e, 300)).toBe(15);
    expect(netAtCursor(e, 999)).toBe(15);
  });

  it('returns the exact point net when cursor lands on a ts', () => {
    const e = entry('A', [
      { ts_ms: 100, net: 5 },
      { ts_ms: 200, net: 10 },
    ]);
    expect(netAtCursor(e, 100)).toBe(5);
    expect(netAtCursor(e, 200)).toBe(10);
  });

  it('handles single-point series', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, 50)).toBe(5);
    expect(netAtCursor(e, 100)).toBe(5);
    expect(netAtCursor(e, 200)).toBe(5);
  });
});

describe('BrokerTrajectoryTable — render states', () => {
  it('shows loading text when series is undefined', () => {
    render(<BrokerTrajectoryTable series={undefined} cursorMs={null} />);
    expect(screen.getByText(/커서 위치 로딩 중/)).toBeInTheDocument();
  });

  it('shows empty text when series is null', () => {
    render(<BrokerTrajectoryTable series={null} cursorMs={null} />);
    expect(screen.getByText(/거래원 정보 없음/)).toBeInTheDocument();
  });

  it('shows empty text when series is []', () => {
    render(<BrokerTrajectoryTable series={[]} cursorMs={null} />);
    expect(screen.getByText(/거래원 정보 없음/)).toBeInTheDocument();
  });

  it('renders one row per broker (capped at 10)', () => {
    const series: BrokerSeriesEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry(`B${i}`, [{ ts_ms: 100 + i, net: 100 - i }]),
    );
    render(<BrokerTrajectoryTable series={series} cursorMs={null} />);
    expect(screen.getAllByTestId('broker-row')).toHaveLength(10);
  });

  it('renders the compact display label and exposes the canonical name as a tooltip', () => {
    const series: BrokerSeriesEntry[] = [
      entry('신한투자증권', [{ ts_ms: 100, net: -100 }]),
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={null} />);
    // Compact label visible in the row.
    expect(screen.getByText('신한투자')).toBeInTheDocument();
    // Canonical name accessible via title attribute for disambiguation.
    expect(screen.getByTitle('신한투자증권')).toBeInTheDocument();
  });
});

describe('BrokerTrajectoryTable — sparkline', () => {
  it('renders a dashed polyline when a gap exceeds GAP_THRESHOLD_MS', () => {
    const big_gap = GAP_THRESHOLD_MS + 1;
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 0, net: 10 },
        { ts_ms: big_gap, net: 50 },     // gap → dashed
        { ts_ms: big_gap + 1_000, net: 60 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={null} />,
    );
    const dashed = container.querySelectorAll('polyline[stroke-dasharray]');
    expect(dashed.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT render the cursor marker when cursorMs lies outside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={500} />,    // before tsFirst
    );
    const cursorLines = container.querySelectorAll('[data-testid="cursor-marker"]');
    expect(cursorLines.length).toBe(0);
  });

  it('renders the cursor marker when cursorMs is inside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} />,
    );
    const cursorLines = container.querySelectorAll('[data-testid="cursor-marker"]');
    expect(cursorLines.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores brokers beyond the rendered row cap when computing the visible day range', () => {
    const series: BrokerSeriesEntry[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        entry(`B${i}`, [
          { ts_ms: 1_000, net: 10 + i },
          { ts_ms: 2_000, net: 20 + i },
        ]),
      ),
      entry('hidden', [{ ts_ms: 100_000, net: 1 }]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={50_000} />,
    );

    expect(screen.getAllByTestId('broker-row')).toHaveLength(10);
    expect(container.querySelectorAll('[data-testid="cursor-marker"]')).toHaveLength(0);
  });

  it('cursor-only rerender moves the marker without changing sparkline geometry', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 30 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container, rerender } = render(
      <BrokerTrajectoryTable series={series} cursorMs={2_000} />,
    );
    const polyline = container.querySelector('polyline:not([stroke-dasharray])');
    const marker = container.querySelector('[data-testid="cursor-marker"]');
    expect(polyline).not.toBeNull();
    expect(marker).not.toBeNull();
    const pointsBefore = polyline!.getAttribute('points');
    const markerBefore = marker!.getAttribute('x1');

    rerender(<BrokerTrajectoryTable series={series} cursorMs={4_000} />);

    expect(polyline!.getAttribute('points')).toBe(pointsBefore);
    expect(marker!.getAttribute('x1')).not.toBe(markerBefore);
  });

  it('series rerender refreshes sparkline geometry while keeping cursor marker valid', () => {
    const series1: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 30 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const series2: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 80 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container, rerender } = render(
      <BrokerTrajectoryTable series={series1} cursorMs={2_000} />,
    );
    const polyline = container.querySelector('polyline:not([stroke-dasharray])');
    expect(polyline).not.toBeNull();
    const pointsBefore = polyline!.getAttribute('points');

    rerender(<BrokerTrajectoryTable series={series2} cursorMs={2_000} />);

    expect(polyline!.getAttribute('points')).not.toBe(pointsBefore);
    expect(container.querySelector('[data-testid="cursor-marker"]')).not.toBeNull();
  });
});
