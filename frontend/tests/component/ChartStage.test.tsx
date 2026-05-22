import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Capture the options passed to createChart so we can probe tickMarkFormatter
// (17c) and expose the timeScale mock so 17b can assert fitContent /
// subscribeVisibleLogicalRangeChange wiring. The mock is hoisted by vi.mock,
// so we keep state on module-scoped `lastCreated`.
const lastCreated: {
  ts: any;
  options: any;
  chart: any;
} = { ts: null, options: null, chart: null };

vi.mock('lightweight-charts', async () => {
  // Re-export the real TickMarkType enum so the formatter switch arms match
  // production at runtime; only `createChart` is stubbed.
  const real = await vi.importActual<any>('lightweight-charts');
  return {
    ...real,
    createChart: vi.fn((_el: HTMLElement, options: any) => {
      const ts = {
        fitContent: vi.fn(),
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        applyOptions: vi.fn(),
        options: vi.fn().mockReturnValue({ barSpacing: 6 }),
      };
      const chart = {
        timeScale: vi.fn().mockReturnValue(ts),
        panes: vi.fn().mockReturnValue([]),
        addSeries: vi.fn().mockReturnValue({
          setData: vi.fn(),
          createPriceLine: vi.fn(),
        }),
        removeSeries: vi.fn(),
        remove: vi.fn(),
      };
      lastCreated.ts = ts;
      lastCreated.options = options;
      lastCreated.chart = chart;
      return chart;
    }),
  };
});

// Pane children depend on bundle field reads; stub them out so the test
// focuses on ChartStage's own effects (fitContent, clamps, formatter).
vi.mock('../../src/chart/CandlePane', () => ({ default: () => null }));
vi.mock('../../src/chart/VolumePane', () => ({ default: () => null }));
vi.mock('../../src/chart/RatioPane', () => ({ default: () => null }));
vi.mock('../../src/chart/IntensityPane', () => ({ default: () => null }));
vi.mock('../../src/chart/FillStrengthPane', () => ({ default: () => null }));
vi.mock('../../src/chart/VolumeProfileOverlay', () => ({ default: () => null }));

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  }
});

import ChartStage from '../../src/chart/ChartStage';

function makeBundle(barCount: number): any {
  // Minimal RangeBundle shape; only `candles.length` is read by the clamp
  // effect, the rest exists to satisfy the truthy `bundle` guard.
  return {
    code: '003490',
    from_date: '20260518',
    to_date: '20260518',
    bucket_ms: 60_000,
    segments: [{ date: '20260518', session_open_ms: 0, session_close_ms: 23_400_000 }],
    candles: Array.from({ length: barCount }, (_, i) => ({
      ts_ms: i * 60_000,
      open: 1,
      close: 1,
      high: 1,
      low: 1,
      vol_a: 0,
      vol_b: 0,
    })),
    quote_ratio: { points: [] },
    depth_intensity_by_day: [],
    fill_strength: { points: [] },
    volume_profile_range: { bins: [] },
    volume_profile_by_day: [],
  };
}

describe('ChartStage — fitContent + zoom clamps (17b)', () => {
  it('calls fitContent on the timeScale when a bundle becomes available', () => {
    render(
      <ChartStage
        bundle={makeBundle(100)}
        segments={[
          { date: '20260518', sessionOpenMs: 0, sessionCloseMs: 23_400_000, virtualStart: 0 },
        ]}
      />,
    );
    expect(lastCreated.ts.fitContent).toHaveBeenCalled();
    expect(lastCreated.ts.subscribeVisibleLogicalRangeChange).toHaveBeenCalled();
  });

  it('clamps logical range when len > totalBars (zoom-out cap)', () => {
    const totalBars = 50;
    render(
      <ChartStage
        bundle={makeBundle(totalBars)}
        segments={[
          { date: '20260518', sessionOpenMs: 0, sessionCloseMs: 23_400_000, virtualStart: 0 },
        ]}
      />,
    );
    const handler = lastCreated.ts.subscribeVisibleLogicalRangeChange.mock.calls[0][0];
    handler({ from: -10, to: 100 }); // len = 110 > 50
    expect(lastCreated.ts.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 0, to: totalBars });
  });

  it('clamps barSpacing to 50 when above the cap (zoom-in cap)', () => {
    lastCreated.ts = null;
    render(
      <ChartStage
        bundle={makeBundle(100)}
        segments={[
          { date: '20260518', sessionOpenMs: 0, sessionCloseMs: 23_400_000, virtualStart: 0 },
        ]}
      />,
    );
    // Override the options mock so barSpacing reports >50 for this assertion.
    lastCreated.ts.options.mockReturnValue({ barSpacing: 80 });
    const handler = lastCreated.ts.subscribeVisibleLogicalRangeChange.mock.calls[0][0];
    handler({ from: 10, to: 20 }); // len = 10 ≤ 100, falls through to bs check
    expect(lastCreated.ts.applyOptions).toHaveBeenCalledWith({ barSpacing: 50 });
  });
});
