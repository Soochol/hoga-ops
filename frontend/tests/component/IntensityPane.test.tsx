import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import IntensityPane from '../../src/chart/IntensityPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

// jsdom doesn't implement canvas. Stub getContext so IntensityPane reaches the
// subscribe/cleanup paths we want to exercise. We don't validate pixel output
// here — the Phase 0 spike covers real-paint perf, and jsdom can't actually
// rasterize.
beforeAll(() => {
  // @ts-expect-error — stubbing jsdom's missing canvas implementation.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: vi.fn(),
  }));
  // jsdom doesn't ship ResizeObserver either; the pane uses it for layout.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  }
});

const makeMockChart = () => {
  const ts = {
    subscribeVisibleTimeRangeChange: vi.fn(),
    unsubscribeVisibleTimeRangeChange: vi.fn(),
    timeToCoordinate: vi.fn().mockImplementation((t: number) => t * 10),
  };
  return { chart: { timeScale: vi.fn().mockReturnValue(ts) } as any, ts };
};

describe('IntensityPane', () => {
  it('renders a canvas overlay', () => {
    const { chart } = makeMockChart();
    const bundle: any = {
      depth_intensity_by_day: [
        {
          bucket_ms: 5000,
          price_min: 70000,
          price_max: 71000,
          price_step: 100,
          times: [1, 2],
          bid_grid: [
            [0.5, 0],
            [0, 0.3],
          ],
          ask_grid: [
            [0, 0.4],
            [0.6, 0],
          ],
        },
      ],
    };
    const { container } = render(
      <IntensityPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs: 0,
            sessionCloseMs: 23400000,
          },
        ])}
      />,
    );
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('subscribes to chart visible range and cleans up on unmount', () => {
    const { chart, ts } = makeMockChart();
    const bundle: any = {
      depth_intensity_by_day: [
        {
          bucket_ms: 5000,
          price_min: 70000,
          price_max: 71000,
          price_step: 100,
          times: [1],
          bid_grid: [[0.1]],
          ask_grid: [[0.1]],
        },
      ],
    };
    const { unmount } = render(
      <IntensityPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs: 0,
            sessionCloseMs: 23400000,
          },
        ])}
      />,
    );
    expect(ts.subscribeVisibleTimeRangeChange).toHaveBeenCalled();
    const subscribedHandler = ts.subscribeVisibleTimeRangeChange.mock.calls[0][0];
    unmount();
    expect(ts.unsubscribeVisibleTimeRangeChange).toHaveBeenCalledWith(subscribedHandler);
  });
});
