import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { createVirtualAxis } from '../util/virtualAxis';
import { AskPeakSegmentsPrimitive } from '../chart/AskPeakSegmentsPrimitive';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import { useLivePageStore } from '../state/livePage';
import { readFlagLegendValues } from './indicators/flagLegendValueRegistry';
import LiveBidPeakSegments, { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';

describe('buildBidPeakOverlaySegments', () => {

  it('filters bid baseline candidates by visible-time cutoff', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 99,
      qty: 90,
      t_ms: open + 60_000,
      max_price: 99,
      max_qty: 90,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 99, qty: 90, t_ms: open + 60_000 },
        { price: 98, qty: 900, t_ms: open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 99, qty: 90, t_ms: open + 60_000 },
        { price: 98, qty: 900, t_ms: open + 180_000 },
      ],
    };

    const segments = buildBidPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayBidPeaks: [peak],
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [{ ts_ms: open, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      visibleTimeCutoff: { date: day, tMs: open + 120_000 },
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ price: 99, qty: 90 });
  });

  it('renders top-N bid baseline candidates through the visible-time cutoff', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 100,
      qty: 100,
      t_ms: open + 60_000,
      max_price: 100,
      max_qty: 100,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 100, qty: 100, t_ms: open + 60_000 },
        { price: 99, qty: 300, t_ms: open + 120_000 },
        { price: 98, qty: 200, t_ms: open + 180_000 },
        { price: 97, qty: 900, t_ms: open + 300_000 },
      ],
      traded_max_peaks: [
        { price: 100, qty: 100, t_ms: open + 60_000 },
        { price: 99, qty: 300, t_ms: open + 120_000 },
        { price: 98, qty: 200, t_ms: open + 180_000 },
        { price: 97, qty: 900, t_ms: open + 300_000 },
      ],
    };

    const segments = buildBidPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayBidPeaks: [peak],
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [
        { ts_ms: open + 60_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 120_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 180_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      ],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      visibleTimeCutoff: { date: day, tMs: open + 180_000 },
      allPriceRankLimit: 3,
    });

    expect(segments.map((segment) => segment.price)).toEqual([99, 98, 100]);
  });

  it('treats same-price bid candidates as one wall for top-N ranks', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 100400,
      qty: 22_300,
      t_ms: open + 60_000,
      max_price: 100400,
      max_qty: 22_300,
      max_t_ms: open + 60_000,
      traded_peaks: [
        { price: 100400, qty: 22_300, t_ms: open + 60_000 },
        { price: 100400, qty: 22_800, t_ms: open + 120_000 },
        { price: 100300, qty: 21_000, t_ms: open + 180_000 },
        { price: 100200, qty: 20_000, t_ms: open + 240_000 },
      ],
      traded_max_peaks: [
        { price: 100400, qty: 22_300, t_ms: open + 60_000 },
        { price: 100400, qty: 22_800, t_ms: open + 120_000 },
        { price: 100300, qty: 21_000, t_ms: open + 180_000 },
        { price: 100200, qty: 20_000, t_ms: open + 240_000 },
      ],
    };

    const segments = buildBidPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayBidPeaks: [peak],
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [
        { ts_ms: open + 60_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 120_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 180_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
        { ts_ms: open + 240_000, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 },
      ],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      allPriceRankLimit: 3,
    });

    expect(segments.map((segment) => [segment.price, segment.qty])).toEqual([
      [100400, 22_800],
      [100300, 21_000],
      [100200, 20_000],
    ]);
  });

  it('omits bid baseline when cutoff mode receives explicit empty ranked candidates', () => {
    const day = '20260613';
    const open = Date.UTC(2026, 5, 13, 0, 0);
    const peak = {
      date: day,
      price: 98,
      qty: 900,
      t_ms: open + 180_000,
      max_price: 98,
      max_qty: 900,
      max_t_ms: open + 180_000,
      traded_peaks: [],
      traded_max_peaks: [],
    };

    const segments = buildBidPeakOverlaySegments({
      maFilter: null,
      dailyMaFilter: null,
      dayBidPeaks: [peak],
      segments: [{ date: day, session_open_ms: open, session_close_ms: open + 3600_000 }],
      candles: [{ ts_ms: open, open: 2, high: 2, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
      axis: createVirtualAxis([{ date: day, sessionOpenMs: open, sessionCloseMs: open + 3600_000 }], open),
      todayKst: day,
      baselineStyle: { color: '#fff', lineWidth: 1 },
      intraMax: false,
      visibleTimeCutoff: { date: day, tMs: open + 120_000 },
    });

    expect(segments).toEqual([]);
  });







});

/**
 * **레전드 값 provider — 매도쪽 거울**(2026-08-22).
 *
 * 따로 두는 이유: 매수 오버레이는 코드 모양이 다르다 — `useCallback` 없는 인라인 effect
 * 이고 **보이는 범위 구독이 없다**(매수는 「보이는 영역 최대벽」 강조 색이 없어 다시 그릴
 * 이유가 없었다). 그래도 레전드가 팬을 따라가는 이유는 provider 가 **호출 시점에** 범위를
 * 읽기 때문이다 — 세그먼트 집합 자체는 팬으로 안 바뀐다.
 *
 * **막는 방향**: 매수쪽만 옛 배선(커서 거래일 1개)으로 남거나, 눈이 값을 지우는 것.
 */
describe('LiveBidPeakSegments — 레전드 값 provider', () => {
  const day = '20260613';
  const open = 60_000;
  const axis = { toVirtual: (ms: number) => ms, contains: () => true } as unknown as VirtualAxis;

  function candle(ts_ms: number): Candle {
    return { ts_ms, open: 100, high: 100, low: 99, close: 100, vol_a: 1, vol_b: 0 };
  }

  const candidates = [
    { price: 100, qty: 1000, t_ms: open },
    { price: 95, qty: 3000, t_ms: open + 60_000 },
    { price: 90, qty: 2000, t_ms: open + 120_000 },
  ];
  const bidPeak: BidPeak = {
    date: day,
    price: 100,
    qty: 1000,
    t_ms: open,
    max_price: 100,
    max_qty: 1000,
    max_t_ms: open,
    traded_peaks: candidates,
    traded_max_peaks: candidates,
  };
  const rangeSegments: RangeSegment[] = [
    { date: day, session_open_ms: open, session_close_ms: open + 180_000 },
  ];

  function renderOverlay() {
    const attached: AskPeakSegmentsPrimitive[] = [];
    const chart = {
      timeScale: () => ({
        getVisibleRange: () => ({ from: 60 as never, to: 240 as never }),
        options: () => ({ barSpacing: 12 }),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
    } as unknown as IChartApi;
    const series = {
      attachPrimitive: vi.fn((primitive: AskPeakSegmentsPrimitive) => {
        attached.push(primitive);
        primitive.attached({
          chart,
          series: series as unknown as ISeriesApi<SeriesType>,
          requestUpdate: vi.fn(),
        } as unknown as Parameters<AskPeakSegmentsPrimitive['attached']>[0]);
      }),
      detachPrimitive: vi.fn(),
    } as unknown as ISeriesApi<SeriesType>;
    const paneSeries = new Map([[('candle' as PaneId), series]]) as PaneSeriesMap;
    render(
      <LiveBidPeakSegments
        paneSeries={paneSeries}
        axis={axis}
        dayBidPeaks={[bidPeak]}
        segments={rangeSegments}
        candles={[candle(open), candle(open + 60_000), candle(open + 120_000)]}
        todayKst={day}
      />,
    );
    return attached;
  }

  beforeEach(() => {
    act(() => {
      useChartPrefsStore.setState({ ...DEFAULT_PREFS, bidPeakAllPriceRankLimit: 3 });
      useLivePageStore.setState({ bidPeakEnabled: true, bidPeakHidden: false });
    });
  });

  it('보이는 영역 잔량 상위 3개를 순위 순으로 올린다', async () => {
    const attached = renderOverlay();
    await waitFor(() => expect(attached).toHaveLength(1));
    await waitFor(() => {
      expect(readFlagLegendValues(null, 'bid-peak', null)).toEqual([
        { key: 'bid-peak-1', label: '1', value: '95, 3k' },
        { key: 'bid-peak-2', label: '2', value: '90, 2k' },
        { key: 'bid-peak-3', label: '3', value: '100, 1k' },
      ]);
    });
  });

  it('눈(hidden)은 선만 지우고 레전드 값은 살린다', async () => {
    act(() => {
      useLivePageStore.setState({ bidPeakHidden: true });
    });
    const attached = renderOverlay();
    await waitFor(() => expect(attached).toHaveLength(1));
    await waitFor(() => {
      expect(attached[0].segmentsData()).toEqual([]);
      expect(readFlagLegendValues(null, 'bid-peak', null)).toHaveLength(3);
    });
  });
});
