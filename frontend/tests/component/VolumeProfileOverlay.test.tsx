import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import VolumeProfileOverlay from '../../src/chart/VolumeProfileOverlay';

beforeAll(() => {
  // jsdom canvas + ResizeObserver stubs.
  // @ts-expect-error — stubbing jsdom's missing canvas implementation.
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    set fillStyle(_v) {},
  });
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
    timeToCoordinate: vi.fn().mockReturnValue(100),
  };
  return { chart: { timeScale: vi.fn().mockReturnValue(ts) } as any, ts };
};

describe('VolumeProfileOverlay', () => {
  it('renders a canvas', () => {
    const { chart } = makeMockChart();
    const bundle: any = {
      volume_profile: {
        bin_count: 4,
        price_min: 70000,
        price_max: 70400,
        bin_width: 100,
        bins: [
          { price_low: 70000, qty: 10 },
          { price_low: 70100, qty: 50 },
          { price_low: 70200, qty: 30 },
          { price_low: 70300, qty: 20 },
        ],
      },
    };
    const { container } = render(
      <VolumeProfileOverlay
        chart={chart}
        bundle={bundle}
        segments={[
          { date: '20260518', sessionOpenMs: 0, sessionCloseMs: 100, virtualStart: 0 },
        ]}
        mode="per-day"
      />,
    );
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('subscribes and unsubscribes from chart visible range', () => {
    const { chart, ts } = makeMockChart();
    const bundle: any = {
      volume_profile: {
        bin_count: 1,
        price_min: 70000,
        price_max: 70100,
        bin_width: 100,
        bins: [{ price_low: 70000, qty: 10 }],
      },
    };
    const { unmount } = render(
      <VolumeProfileOverlay chart={chart} bundle={bundle} segments={[]} mode="composite" />,
    );
    expect(ts.subscribeVisibleTimeRangeChange).toHaveBeenCalled();
    unmount();
    expect(ts.unsubscribeVisibleTimeRangeChange).toHaveBeenCalled();
  });
});
