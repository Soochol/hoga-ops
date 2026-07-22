import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import type { VirtualAxis } from '../util/virtualAxis';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import LivePeakWallDockedLabels from './LivePeakWallDockedLabels';

const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;

function candle(ts_ms: number): Candle {
  return { ts_ms, open: 100, high: 100, low: 99, close: 100, vol_a: 1, vol_b: 0 };
}

describe('LivePeakWallDockedLabels', () => {
  beforeEach(() => {
    act(() => {
      useChartPrefsStore.setState({ ...DEFAULT_PREFS });
      useLivePageStore.setState({
        askPeakEnabled: true,
        bidPeakEnabled: false,
        askPeakColor: '#1D4ED8',
        askPeakLineWidth: 2,
        askPeakAllPriceColor: '#F97316',
        askPeakAllPriceLineWidth: 1,
        askPeakVisibleMaxColor: '#EAB308',
        askPeakVisibleMaxLineWidth: 3,
      });
    });
  });

  it('keeps labels for every rendered ask wall, not only the visible-max highlighted wall', async () => {
    const day = '20260613';
    const open = 60_000;
    const attached: PeakWallDockedLabelsPrimitive[] = [];
    const chart = {
      timeScale: () => ({
        getVisibleRange: () => ({ from: 60 as never, to: 120 as never }),
        options: () => ({ barSpacing: 12 }),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
    } as unknown as IChartApi;
    const series = {
      attachPrimitive: vi.fn((primitive: PeakWallDockedLabelsPrimitive) => {
        attached.push(primitive);
        primitive.attached({
          chart,
          series: series as unknown as ISeriesApi<SeriesType>,
          requestUpdate: vi.fn(),
        } as unknown as Parameters<PeakWallDockedLabelsPrimitive['attached']>[0]);
      }),
      detachPrimitive: vi.fn(),
    } as unknown as ISeriesApi<SeriesType>;
    const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
    const askPeak: AskPeak = {
      date: day,
      price: 100,
      qty: 100,
      t_ms: open,
      max_price: 100,
      max_qty: 100,
      max_t_ms: open,
      untraded_price: 105,
      untraded_qty: 300,
      untraded_t_ms: open + 60_000,
      untraded_max_price: 105,
      untraded_max_qty: 300,
      untraded_max_t_ms: open + 60_000,
    };
    const segments: RangeSegment[] = [{
      date: day,
      session_open_ms: open,
      session_close_ms: open + 180_000,
    }];

    render(
      <LivePeakWallDockedLabels
        paneSeries={paneSeries}
        axis={axis}
        dayAskPeaks={[askPeak]}
        todayAllPriceAskPeak={null}
        dayBidPeaks={[]}
        todayAllPriceBidPeak={null}
        segments={segments}
        candles={[candle(open), candle(open + 60_000)]}
        todayKst={day}
      />,
    );

    await waitFor(() => {
      expect(attached).toHaveLength(1);
      expect(attached[0].labelsData().map((label) => label.price).sort((a, b) => a - b)).toEqual([100, 105]);
    });
  });

  it('hides ask wall labels when the ask label toggle is off', async () => {
    act(() => {
      useChartPrefsStore.setState({ askPeakLabelEnabled: false });
    });
    const day = '20260613';
    const open = 60_000;
    const attached: PeakWallDockedLabelsPrimitive[] = [];
    const chart = {
      timeScale: () => ({
        getVisibleRange: () => ({ from: 60 as never, to: 120 as never }),
        options: () => ({ barSpacing: 12 }),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
    } as unknown as IChartApi;
    const series = {
      attachPrimitive: vi.fn((primitive: PeakWallDockedLabelsPrimitive) => {
        attached.push(primitive);
        primitive.attached({
          chart,
          series: series as unknown as ISeriesApi<SeriesType>,
          requestUpdate: vi.fn(),
        } as unknown as Parameters<PeakWallDockedLabelsPrimitive['attached']>[0]);
      }),
      detachPrimitive: vi.fn(),
    } as unknown as ISeriesApi<SeriesType>;
    const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
    const askPeak: AskPeak = {
      date: day,
      price: 100,
      qty: 100,
      t_ms: open,
      max_price: 100,
      max_qty: 100,
      max_t_ms: open,
      untraded_price: 105,
      untraded_qty: 300,
      untraded_t_ms: open + 60_000,
      untraded_max_price: 105,
      untraded_max_qty: 300,
      untraded_max_t_ms: open + 60_000,
    };
    const segments: RangeSegment[] = [{
      date: day,
      session_open_ms: open,
      session_close_ms: open + 180_000,
    }];

    render(
      <LivePeakWallDockedLabels
        paneSeries={paneSeries}
        axis={axis}
        dayAskPeaks={[askPeak]}
        todayAllPriceAskPeak={null}
        dayBidPeaks={[]}
        todayAllPriceBidPeak={null}
        segments={segments}
        candles={[candle(open), candle(open + 60_000)]}
        todayKst={day}
      />,
    );

    await waitFor(() => {
      expect(attached).toHaveLength(1);
      expect(attached[0].labelsData()).toEqual([]);
    });
  });

  it('hides bid wall labels when the bid label toggle is off', async () => {
    act(() => {
      useChartPrefsStore.setState({ bidPeakLabelEnabled: false });
      useLivePageStore.setState({ askPeakEnabled: false, bidPeakEnabled: true });
    });
    const day = '20260613';
    const open = 60_000;
    const attached: PeakWallDockedLabelsPrimitive[] = [];
    const chart = {
      timeScale: () => ({
        getVisibleRange: () => ({ from: 60 as never, to: 120 as never }),
        options: () => ({ barSpacing: 12 }),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
    } as unknown as IChartApi;
    const series = {
      attachPrimitive: vi.fn((primitive: PeakWallDockedLabelsPrimitive) => {
        attached.push(primitive);
        primitive.attached({
          chart,
          series: series as unknown as ISeriesApi<SeriesType>,
          requestUpdate: vi.fn(),
        } as unknown as Parameters<PeakWallDockedLabelsPrimitive['attached']>[0]);
      }),
      detachPrimitive: vi.fn(),
    } as unknown as ISeriesApi<SeriesType>;
    const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
    const bidPeak: BidPeak = {
      date: day,
      price: 99,
      qty: 200,
      t_ms: open,
      max_price: 99,
      max_qty: 200,
      max_t_ms: open,
    };
    const segments: RangeSegment[] = [{
      date: day,
      session_open_ms: open,
      session_close_ms: open + 180_000,
    }];

    render(
      <LivePeakWallDockedLabels
        paneSeries={paneSeries}
        axis={axis}
        dayAskPeaks={[]}
        todayAllPriceAskPeak={null}
        dayBidPeaks={[bidPeak]}
        todayAllPriceBidPeak={null}
        segments={segments}
        candles={[candle(open), candle(open + 60_000)]}
        todayKst={day}
      />,
    );

    await waitFor(() => {
      expect(attached).toHaveLength(1);
      expect(attached[0].labelsData()).toEqual([]);
    });
  });
});
