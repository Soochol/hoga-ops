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

// contains: 이동평균 필터가 MovingAverageOverlay 와 같은 「세션 안 캔들」 배열 위에서
// SMA 를 재므로 스텁도 그 축을 갖는다 — 픽스처 캔들은 전부 세션 안이다.
const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;

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
    // 벽 2개를 그리게 한다(체결된 벽 표시 개수 = 2) — 이 테스트의 주제는 "그려진 벽마다
    // 라벨이 붙는가" 이므로 벽이 둘 이상이어야 의미가 있다.
    act(() => {
      useChartPrefsStore.setState({ askPeakAllPriceRankLimit: 2 });
    });
    const candidates = [
      { price: 100, qty: 100, t_ms: open },
      { price: 105, qty: 300, t_ms: open + 60_000 },
    ];
    const askPeak: AskPeak = {
      date: day,
      price: 100,
      qty: 100,
      t_ms: open,
      max_price: 100,
      max_qty: 100,
      max_t_ms: open,
      traded_peaks: candidates,
      traded_max_peaks: candidates,
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
        dayBidPeaks={[]}
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
        dayBidPeaks={[]}
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
        dayBidPeaks={[bidPeak]}
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
