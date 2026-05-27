import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LiveIndicatorPane } from './LiveIndicatorPane';

// jsdom does not implement ResizeObserver — provide a no-op stub.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// lightweight-charts v5 uses addSeries(SeriesDefinition, options) not
// addLineSeries / addHistogramSeries.
const mockChart = {
  addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
  remove: vi.fn(),
  applyOptions: vi.fn(),
  timeScale: vi.fn(() => ({
    applyOptions: vi.fn(),
    subscribeVisibleTimeRangeChange: vi.fn(),
  })),
  resize: vi.fn(),
};

vi.mock('lightweight-charts', async () => {
  const actual = await vi.importActual<any>('lightweight-charts');
  return {
    ...actual,
    createChart: vi.fn(() => mockChart),
  };
});

describe('LiveIndicatorPane', () => {
  beforeEach(() => {
    cleanup();
    mockChart.addSeries.mockClear();
    mockChart.remove.mockClear();
  });

  it('mounts with the right number of series for 1m timeframe', async () => {
    const { LineSeries, HistogramSeries } = await import('lightweight-charts');
    render(<LiveIndicatorPane timeframe="1m" />);
    await Promise.resolve();
    // Quote Totals = 2 lines, 호가비 = 1 line, FillStrength = 2 histograms
    // Total addSeries calls: 5
    expect(mockChart.addSeries).toHaveBeenCalledTimes(5);
    // 3 LineSeries calls
    const calls = mockChart.addSeries.mock.calls as unknown[][];
    const lineCalls = calls.filter((args) => args[0] === LineSeries);
    expect(lineCalls).toHaveLength(3);
    // 2 HistogramSeries calls
    const histCalls = calls.filter((args) => args[0] === HistogramSeries);
    expect(histCalls).toHaveLength(2);
  });

  it('shows D/W disabled note when timeframe is D', () => {
    render(<LiveIndicatorPane timeframe="D" />);
    expect(screen.getByTestId('indicator-disabled-note')).toBeInTheDocument();
    expect(screen.getByText(/분봉에서 표시/)).toBeInTheDocument();
  });

  it('shows D/W disabled note when timeframe is W', () => {
    render(<LiveIndicatorPane timeframe="W" />);
    expect(screen.getByTestId('indicator-disabled-note')).toBeInTheDocument();
  });

  it('does not show D/W note for minute timeframes', () => {
    render(<LiveIndicatorPane timeframe="5m" />);
    expect(screen.queryByTestId('indicator-disabled-note')).toBeNull();
  });

  it('still mounts the chart on D timeframe (pane is always mounted)', async () => {
    const { LineSeries } = await import('lightweight-charts');
    render(<LiveIndicatorPane timeframe="D" />);
    await Promise.resolve();
    // Per Addendum 9.4: pane mounts even for D/W; series exist but data empty.
    expect(mockChart.addSeries).toHaveBeenCalledWith(LineSeries, expect.any(Object));
  });

  it('calls remove on unmount', async () => {
    const { unmount } = render(<LiveIndicatorPane timeframe="1m" />);
    await Promise.resolve();
    unmount();
    expect(mockChart.remove).toHaveBeenCalled();
  });
});
