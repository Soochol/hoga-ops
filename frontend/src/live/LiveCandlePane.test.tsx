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

// lightweight-charts pollutes jsdom (canvas, ResizeObserver). Mock the
// minimal surface our component uses; we're not testing chart internals
// here, only that the component mounts the right structure.
const mockChart = {
  addCandlestickSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
  addHistogramSeries: vi.fn(() => ({ setData: vi.fn(), applyOptions: vi.fn() })),
  remove: vi.fn(),
  applyOptions: vi.fn(),
  timeScale: vi.fn(() => ({
    applyOptions: vi.fn(),
    subscribeVisibleTimeRangeChange: vi.fn(),
    fitContent: vi.fn(),
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
    mockChart.addCandlestickSeries.mockClear();
    mockChart.addHistogramSeries.mockClear();
  });

  it('mounts a chart container', () => {
    render(<LiveCandlePane candles={[]} timeframe="1m" />);
    expect(screen.getByTestId('live-candle-pane')).toBeInTheDocument();
  });

  it('creates exactly one candlestick and one histogram series on mount', async () => {
    render(<LiveCandlePane candles={[]} timeframe="1m" />);
    // useEffect runs after render — flush microtasks
    await Promise.resolve();
    expect(mockChart.addCandlestickSeries).toHaveBeenCalledTimes(1);
    expect(mockChart.addHistogramSeries).toHaveBeenCalledTimes(1);
  });

  it('calls remove on unmount', async () => {
    const { unmount } = render(<LiveCandlePane candles={[]} timeframe="1m" />);
    await Promise.resolve();
    unmount();
    expect(mockChart.remove).toHaveBeenCalled();
  });
});
