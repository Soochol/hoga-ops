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

  it('returns 0 when cursor precedes broker first observation', () => {
    const e = entry('A', [{ ts_ms: 200, net: 5 }]);
    expect(netAtCursor(e, 100)).toBe(0);
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
    expect(netAtCursor(e, 50)).toBe(0);
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
});
