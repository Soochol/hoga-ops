import { cleanup, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLivePageStore } from '../state/livePage';
import LiveAskPeakSegments from './LiveAskPeakSegments';

const axis = {
  toReal: (virtualMs: number) => virtualMs,
} as VirtualAxis;

const segment = (open: number, close: number): RangeSegment => ({
  date: '20260613',
  session_open_ms: open,
  session_close_ms: close,
  source: 'hogaplay',
});

function makeSeriesMock() {
  const priceLine = { applyOptions: vi.fn() };
  return {
    priceLine,
    createPriceLine: vi.fn(() => priceLine),
    removePriceLine: vi.fn(),
  };
}

describe('LiveAskPeakSegments', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({
      askPeakEnabled: true,
      askPeakColor: '#1D4ED8',
      askPeakLineWidth: 2,
    });
  });

  it('creates one visible price line at the viewport-selected ask peak', () => {
    const s = makeSeriesMock();
    render(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[
          { t: 1000, price: 25000, qty: 100 },
          { t: 2000, price: 25100, qty: 5000 },
        ]}
        visibleRange={{ from: 0, to: 2.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );

    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    expect(s.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({
      price: 25100,
      color: '#1D4ED8',
      lineWidth: 2,
      lineVisible: true,
      axisLabelVisible: true,
      title: '5k',
    }));
  });

  it('updates the existing price line when viewport or style changes', () => {
    const s = makeSeriesMock();
    const { rerender } = render(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[
          { t: 1000, price: 25000, qty: 100 },
          { t: 2000, price: 25100, qty: 5000 },
        ]}
        visibleRange={{ from: 0, to: 1.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );

    useLivePageStore.setState({ askPeakColor: '#EF4444', askPeakLineWidth: 4 });
    rerender(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[
          { t: 1000, price: 25000, qty: 100 },
          { t: 2000, price: 25100, qty: 5000 },
        ]}
        visibleRange={{ from: 0, to: 2.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );

    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      price: 25100,
      color: '#EF4444',
      lineWidth: 4,
      title: '5k',
    }));
  });

  it('hides the line when disabled or no viewport peak is available', () => {
    const s = makeSeriesMock();
    const { rerender } = render(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[{ t: 1000, price: 25000, qty: 100 }]}
        visibleRange={{ from: 0, to: 1.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );

    useLivePageStore.setState({ askPeakEnabled: false });
    rerender(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[{ t: 1000, price: 25000, qty: 100 }]}
        visibleRange={{ from: 0, to: 1.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith({
      lineVisible: false,
      axisLabelVisible: false,
      title: '',
    });

    useLivePageStore.setState({ askPeakEnabled: true });
    rerender(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[]}
        visibleRange={{ from: 0, to: 1.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith({
      lineVisible: false,
      axisLabelVisible: false,
      title: '',
    });
  });

  it('does nothing when the candle series is absent', () => {
    expect(() =>
      render(
        <LiveAskPeakSegments
          paneSeries={new Map() as never}
          axis={axis}
          askPeakPoints={[{ t: 1000, price: 25000, qty: 100 }]}
          visibleRange={{ from: 0, to: 1.5 }}
          segments={[segment(0, 10_000)]}
        />,
      ),
    ).not.toThrow();
  });

  it('removes the price line on unmount', () => {
    const s = makeSeriesMock();
    const { unmount } = render(
      <LiveAskPeakSegments
        paneSeries={new Map([['candle', s]]) as never}
        axis={axis}
        askPeakPoints={[{ t: 1000, price: 25000, qty: 100 }]}
        visibleRange={{ from: 0, to: 1.5 }}
        segments={[segment(0, 10_000)]}
      />,
    );

    unmount();
    expect(s.removePriceLine).toHaveBeenCalledWith(s.priceLine);
  });
});
