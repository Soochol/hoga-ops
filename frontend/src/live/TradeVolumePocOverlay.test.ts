import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import type { PaneId } from '../chart/drawing/types';
import TradeVolumePocOverlay, { buildTradeVolumePocSegments } from './TradeVolumePocOverlay';

const primitiveMocks = vi.hoisted(() => ({
  instances: [] as Array<{ setSegments: ReturnType<typeof vi.fn>; options: unknown }>,
}));

vi.mock('../chart/TradeVolumePocPrimitive', () => ({
  TradeVolumePocPrimitive: class {
    setSegments = vi.fn();
    options: unknown;

    constructor(options: unknown) {
      this.options = options;
      primitiveMocks.instances.push(this);
    }
  },
}));

describe('buildTradeVolumePocSegments', () => {
  it('clips restored study-view POC bands to candle times present in the snapshot', () => {
    const sessionOpenMs = 1_000;
    const sessionCloseMs = 10_000;
    const firstSnapshotCandleMs = 4_000;
    const lastSnapshotCandleMs = 7_000;
    const axis = createVirtualAxis([{
      date: '20260616',
      sessionOpenMs,
      sessionCloseMs,
    }]);

    const segments = buildTradeVolumePocSegments(
      [{
        date: '20260616',
        centerPrice: 70_000,
        lowPrice: 69_500,
        highPrice: 70_500,
        qty: 12_345,
        t_ms: 5_000,
        bandPct: 0.005,
      }],
      [{ date: '20260616', session_open_ms: sessionOpenMs, session_close_ms: sessionCloseMs }],
      [
        { ts_ms: firstSnapshotCandleMs, open: 70_000, high: 70_300, low: 69_800, close: 70_100, vol_a: 10, vol_b: 0 },
        { ts_ms: lastSnapshotCandleMs, open: 70_100, high: 70_400, low: 69_900, close: 70_200, vol_a: 20, vol_b: 0 },
      ],
      axis,
      '20260616',
      'rgba(168, 85, 247, 0.12)',
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].time0).toBe(axis.toVirtual(firstSnapshotCandleMs) / 1000);
    expect(segments[0].time1).toBe(axis.toVirtual(lastSnapshotCandleMs) / 1000);
  });
});

describe('TradeVolumePocOverlay', () => {
  it('applies already-computed segments when the candle series registers after the first render', () => {
    primitiveMocks.instances.length = 0;
    const axis = createVirtualAxis([{
      date: '20260616',
      sessionOpenMs: 1_000,
      sessionCloseMs: 2_000,
    }]);
    const props = {
      axis,
      pocs: [{
        date: '20260616',
        centerPrice: 70_000,
        lowPrice: 69_500,
        highPrice: 70_500,
        qty: 12_345,
        t_ms: 1_000,
        bandPct: 0.005,
      }],
      segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
      candles: [{ ts_ms: 1_000, open: 70_000, high: 70_500, low: 69_500, close: 70_000, vol_a: 100, vol_b: 0 }],
      todayKst: '20260616',
      override: { enabled: true, color: '#A855F7', opacity: 0.12 },
    };
    const emptyPaneSeries = new Map();
    const series = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
    };
    const { rerender } = render(createElement(TradeVolumePocOverlay, {
      ...props,
      paneSeries: emptyPaneSeries as never,
    }));

    rerender(createElement(TradeVolumePocOverlay, {
      ...props,
      paneSeries: new Map([['candle' as PaneId, series as never]]) as never,
    }));

    expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(primitiveMocks.instances[0].setSegments).toHaveBeenCalledWith([
      expect.objectContaining({
        lowPrice: 69_500,
        highPrice: 70_500,
        fillColor: 'rgba(168, 85, 247, 0.12)',
      }),
    ]);
  });

  it('can place the band behind the candle series', () => {
    primitiveMocks.instances.length = 0;
    const axis = createVirtualAxis([{
      date: '20260616',
      sessionOpenMs: 1_000,
      sessionCloseMs: 2_000,
    }]);
    const series = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
    };

    render(createElement(TradeVolumePocOverlay, {
      paneSeries: new Map([['candle' as PaneId, series as never]]) as never,
      axis,
      pocs: [],
      segments: [],
      candles: [],
      todayKst: '20260616',
      override: { enabled: true, color: '#A855F7', opacity: 0.12 },
      behindSeries: true,
    }));

    expect(primitiveMocks.instances[0].options).toEqual({ zOrder: 'bottom' });
  });
});
