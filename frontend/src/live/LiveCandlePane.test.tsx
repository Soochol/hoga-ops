import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LiveCandlePane } from './LiveCandlePane';

// jsdom does not implement ResizeObserver — provide a no-op stub before the
// component module is loaded so the useEffect doesn't throw.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

vi.mock('../api/liveCandles', () => ({
  useLiveCandles: () => ({ data: undefined, isLoading: false, candles: [] }),
}));

// lightweight-charts v5 uses addSeries(SeriesDefinition, options) instead of
// addCandlestickSeries / addHistogramSeries. Mock the minimal surface our
// component uses; we're not testing chart internals here, only that the
// component mounts the right structure.
const mockChart = {
  addSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
  remove: vi.fn(),
  applyOptions: vi.fn(),
  timeScale: vi.fn(() => ({
    applyOptions: vi.fn(),
    subscribeVisibleTimeRangeChange: vi.fn(),
    fitContent: vi.fn(),
    scrollToRealTime: vi.fn(),
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

describe('LiveCandlePane', () => {
  beforeEach(() => {
    cleanup();
    Object.values(mockChart).forEach((fn) => {
      if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear();
    });
    mockChart.addSeries.mockClear();
  });

  it('mounts a chart container', () => {
    render(<LiveCandlePane code={null} timeframe="1m" />);
    expect(screen.getByTestId('live-candle-pane')).toBeInTheDocument();
  });

  it('creates exactly one candlestick series on mount', async () => {
    const { CandlestickSeries } = await import('lightweight-charts');
    render(<LiveCandlePane code={null} timeframe="1m" />);
    // useEffect runs after render — flush microtasks
    await Promise.resolve();
    // Volume moved to LiveVolumePane (2026-05-27 split). Candle pane now
    // creates a single CandlestickSeries.
    expect(mockChart.addSeries).toHaveBeenCalledTimes(1);
    expect(mockChart.addSeries).toHaveBeenCalledWith(CandlestickSeries, expect.any(Object));
  });

  it('calls remove on unmount', async () => {
    const { unmount } = render(<LiveCandlePane code={null} timeframe="1m" />);
    await Promise.resolve();
    unmount();
    expect(mockChart.remove).toHaveBeenCalled();
  });
});
