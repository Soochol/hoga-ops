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
  it('returns null when cursorMs is null', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, null)).toBeNull();
  });

  it('returns null when cursor precedes broker first observation (아직 등장 전)', () => {
    const e = entry('A', [{ ts_ms: 200, net: 5 }]);
    expect(netAtCursor(e, 100)).toBeNull();
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
    expect(netAtCursor(e, 50)).toBeNull();
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

  it('renders more than ten broker rows', () => {
    const series: BrokerSeriesEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry(`B${i}`, [{ ts_ms: 100 + i, net: 100 - i }]),
    );
    render(<BrokerTrajectoryTable series={series} cursorMs={null} />);
    expect(screen.getAllByTestId('broker-row')).toHaveLength(12);
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
  it('clips after-close broker points to the regular-session x domain', () => {
    // 2026-06-25 09:00~15:30 KST.
    const open = Date.UTC(2026, 5, 25, 0, 0, 0);
    const close = open + 6.5 * 3600_000;
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: open, net: 10 },
        { ts_ms: close, net: 20 },
        { ts_ms: close + 60 * 60_000, net: 999 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={close + 60 * 60_000} />,
    );

    const points = Array.from(container.querySelectorAll('polyline')).map((line) =>
      line.getAttribute('points'),
    );
    expect(points).toContain('0,8 60,0');
    expect(screen.getByText('+20')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="cursor-marker"]')).toBeNull();
  });

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

  it('keeps dashed gap segments as vivid as solid broker trajectory segments', () => {
    const big_gap = GAP_THRESHOLD_MS + 1;
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 0, net: 10 },
        { ts_ms: big_gap, net: 50 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={null} />,
    );

    const dashed = container.querySelector('polyline[stroke-dasharray]');
    expect(dashed).not.toBeNull();
    expect(dashed).toHaveAttribute('stroke', 'var(--price-up)');
    expect(dashed).not.toHaveAttribute('opacity');
  });

  it('does NOT render the cursor marker when cursorMs lies outside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={-500} />,    // before regular-session open
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

  it('uses all rendered brokers when computing the visible day range', () => {
    const series: BrokerSeriesEntry[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        entry(`B${i}`, [
          { ts_ms: 1_000, net: 10 + i },
          { ts_ms: 2_000, net: 20 + i },
        ]),
      ),
      entry('hidden', [{ ts_ms: 100_000, net: 1 }]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={30_000_000} />,
    );

    expect(screen.getAllByTestId('broker-row')).toHaveLength(13);
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

describe('BrokerTrajectoryTable — 0선·커서 도트·규모 바·관측 전 표기', () => {
  const series: BrokerSeriesEntry[] = [
    entry('A', [
      { ts_ms: 1_000, net: 100 },
      { ts_ms: 5_000, net: 120 },
    ]),
    entry('B', [
      { ts_ms: 1_000, net: -50 },
      { ts_ms: 5_000, net: -80 },
    ], 'sell'),
    entry('C', [{ ts_ms: 4_000, net: 30 }]),   // 커서(3_000) 시점엔 아직 등장 전
  ];

  it('renders a zero baseline in every sparkline', () => {
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} />,
    );
    expect(container.querySelectorAll('[data-testid="zero-baseline"]')).toHaveLength(3);
  });

  it('renders a cursor value dot only where the trajectory exists at the cursor', () => {
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} />,
    );
    // A·B는 궤적 범위 안(1s~5s), C는 첫 관측(4s) 이전이라 도트 없음.
    expect(container.querySelectorAll('[data-testid="cursor-value-dot"]')).toHaveLength(2);
  });

  it('renders magnitude bars proportional to |net| across rows', () => {
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} />,
    );
    const bars = container.querySelectorAll<HTMLElement>('[data-testid="broker-net-bar"]');
    expect(bars).toHaveLength(2);   // C는 관측 전이라 바 없음
    expect(bars[0].style.width).toBe('100%');   // A: |100| / max(100)
    expect(bars[1].style.width).toBe('50%');    // B: |-50| / max(100)
    expect(bars[0].style.background).toContain('--tint-price-up');
    expect(bars[1].style.background).toContain('--tint-price-down');
  });

  it('shows an em-dash (not 0) when the cursor precedes the first observation', () => {
    render(<BrokerTrajectoryTable series={series} cursorMs={3_000} />);
    const preobs = screen.getAllByTestId('broker-net-preobs');
    expect(preobs).toHaveLength(1);
    expect(preobs[0]).toHaveTextContent('—');
  });
});
