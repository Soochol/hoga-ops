import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import type { ParquetStudySnapshot } from '../api/studyViews';
import type { LiveChartRoot } from '../live/LiveChartRoot';

const { useStudyViewSnapshotMock, liveChartRootMock, useLiveBundleMock, useRangeMock } = vi.hoisted(() => ({
  useStudyViewSnapshotMock: vi.fn(),
  liveChartRootMock: vi.fn(),
  useLiveBundleMock: vi.fn(),
  useRangeMock: vi.fn(),
}));

vi.mock('./useStudyViews', () => ({
  useStudyViewSnapshot: useStudyViewSnapshotMock,
}));

vi.mock('../live/LiveChartRoot', () => ({
  LiveChartRoot: (props: ComponentProps<typeof LiveChartRoot>) => {
    liveChartRootMock(props);
    return <div data-testid="live-chart-root-stub" />;
  },
}));

vi.mock('../live/useLiveBundle', () => ({
  useLiveBundle: useLiveBundleMock,
}));

vi.mock('../api/range', () => ({
  useRange: useRangeMock,
}));

import { StudyPage } from './StudyPage';
import { useLiveBundle } from '../live/useLiveBundle';
import { useRange } from '../api/range';
import { useLiveCursorStore } from '../live/useLiveCursorStore';

const snapshot: ParquetStudySnapshot = {
  schema_version: 1,
  source_policy: 'fixed',
  code: '005930',
  label: '삼성전자',
  timeframe: 'D',
  snapshot_from_ms: 1_000,
  snapshot_to_ms: 2_000,
  bucket_kind: 'D',
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  indicator_state: {
    volume_enabled: false,
    quote_totals_enabled: true,
    ratio_enabled: false,
    fill_strength_enabled: true,
    aggregation_basis: 'close',
    auction_window_mask: true,
    ratio_outlier_filter_enabled: true,
    ratio_outlier_threshold: 50,
  },
  provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
  bundle: {
    code: '005930',
    timeframe: 'D',
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 2_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [{ t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 }],
    quote_totals: [{ t: 1_000, bid_total: 100, ask_total: 120, visible: true }],
    ratio: [{ t: 1_000, value: -49, visible: true }],
    fill_strength: [{ t: 1_000, buy_qty: 30, sell_qty: 20, visible: true }],
    ask_peaks: [{
      date: '20260616',
      price: 70_500,
      qty: 5_000,
      t_ms: 1_000,
      max_price: 70_700,
      max_qty: 6_000,
      max_t_ms: 1_000,
    }],
    data_warnings: [],
  },
  captured_at_ms: 3_000,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StudyPage />
    </MemoryRouter>,
  );
}

describe('StudyPage', () => {
  beforeEach(() => {
    useStudyViewSnapshotMock.mockReset();
    liveChartRootMock.mockReset();
    useLiveBundleMock.mockReset();
    useRangeMock.mockReset();
    useLiveCursorStore.getState().resetCursor();
  });

  it('renders a saved snapshot from /study?view=view1 without live or range hooks', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: snapshot,
      isLoading: false,
      isError: false,
    });

    renderAt('/study?view=view1');

    expect(screen.getByTestId('study-page')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
    expect(useStudyViewSnapshotMock).toHaveBeenCalledWith('view1');
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    expect(props).toMatchObject({
      code: '005930',
      timeframe: 'D',
      viewIdentity: 'view1',
      clampEngaged: false,
      isPastCandlesLoading: false,
      isExtending: false,
      pastDataWarnings: [],
      restoreViewport: { rightEdgeMs: 2_000, barSpan: 120, atLiveEdge: false },
      dayAskPeaks: [{
        date: '20260616',
        price: 70_500,
        qty: 5_000,
        t_ms: 1_000,
        max_price: 70_700,
        max_qty: 6_000,
        max_t_ms: 1_000,
      }],
      forceHogaPanes: true,
      paneTogglesOverride: {
        volumeEnabled: false,
        quoteTotalsEnabled: true,
        ratioEnabled: false,
        fillStrengthEnabled: true,
      },
      persistLiveViewport: false,
    });
    expect(props.bundle).toBe(props.chartBundle);
    expect(props.bundle).toMatchObject({
      code: '005930',
      from_date: '20260616',
      to_date: '20260616',
      study_ratio: { points: [{ t: 1_000, value: -49 }] },
    });
    expect(props.ratioBundle?.quote_ratio.points).toEqual([{
      t: 1_000,
      bid_total: 50,
      ask_total: 1,
      bid_max: 50,
      ask_max: 1,
      imb_max_bid: 50,
      imb_max_ask: 1,
    }]);
    expect('study_ratio' in props.ratioBundle!).toBe(false);
  });

  it('renders saved orderbook and broker detail from snapshot without cursor fetch hooks', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        orderbook_buckets: [{
          t: 1_000,
          available: true,
          snapshot: {
            ts_ms: 1_999,
            seq: 7,
            ask: Array.from({ length: 10 }, (_, i) => ({ price: 71_000 + i, qty: 10 + i })),
            bid: Array.from({ length: 10 }, (_, i) => ({ price: 70_900 - i, qty: 20 + i })),
            tot_ask: 145,
            tot_bid: 245,
          },
        }],
        broker_buckets: [{
          t: 1_000,
          available: true,
          brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
        }],
        detail_warnings: [],
      },
    };
    useStudyViewSnapshotMock.mockReturnValue({
      data: enriched,
      isLoading: false,
      isError: false,
    });

    renderAt('/study?view=view1');

    expect(screen.getByTestId('study-detail-panel')).toBeTruthy();
    expect(screen.getByText('10호가')).toBeTruthy();
    expect(screen.getByText('거래원')).toBeTruthy();
    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+100')).toBeTruthy();
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();
  });

  it('renders saved broker bucket history as a trajectory graph', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
          { t: 61_000, open: 71_000, high: 73_000, low: 70_000, close: 72_000, volume: 120 },
        ],
        orderbook_buckets: [
          {
            t: 1_000,
            available: false,
            snapshot: null,
          },
          {
            t: 61_000,
            available: false,
            snapshot: null,
          },
        ],
        broker_buckets: [
          {
            t: 1_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
          },
          {
            t: 61_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 250, dominant_side: 'buy' }],
          },
        ],
        detail_warnings: [],
      },
    };
    useStudyViewSnapshotMock.mockReturnValue({
      data: enriched,
      isLoading: false,
      isError: false,
    });

    const { container } = renderAt('/study?view=view1');

    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+250')).toBeTruthy();
    expect(container.querySelector('[data-testid="study-detail-panel"] svg')).toBeTruthy();
    expect(container.querySelector('[data-testid="study-detail-panel"] polyline')).toBeTruthy();
  });

  it('limits saved broker graph and values to the hovered date session', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        segments: [
          { date: '20260615', session_open_ms: 1_000, session_close_ms: 2_000 },
          { date: '20260616', session_open_ms: 100_000, session_close_ms: 101_999 },
        ],
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
          { t: 100_000, open: 71_000, high: 73_000, low: 70_000, close: 72_000, volume: 120 },
          { t: 101_000, open: 72_000, high: 74_000, low: 71_000, close: 73_000, volume: 130 },
        ],
        orderbook_buckets: [
          { t: 1_000, available: false, snapshot: null },
          { t: 100_000, available: false, snapshot: null },
          { t: 101_000, available: false, snapshot: null },
        ],
        broker_buckets: [
          {
            t: 1_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 999, dominant_side: 'buy' }],
          },
          {
            t: 100_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
          },
          {
            t: 101_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 200, dominant_side: 'buy' }],
          },
        ],
        detail_warnings: [],
      },
    };
    useStudyViewSnapshotMock.mockReturnValue({
      data: enriched,
      isLoading: false,
      isError: false,
    });

    const { container } = renderAt('/study?view=view1');

    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+200')).toBeTruthy();
    expect(screen.queryByText('+999')).toBeNull();
    expect(container.querySelector('[data-testid="study-detail-panel"] polyline[stroke-dasharray]')).toBeNull();
  });

  it('falls back to the latest saved candle when sticky cursor remains after hover ends', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
          { t: 2_000, open: 71_000, high: 73_000, low: 70_000, close: 72_000, volume: 120 },
        ],
        orderbook_buckets: [
          {
            t: 1_000,
            available: true,
            snapshot: {
              ts_ms: 1_999,
              seq: 7,
              ask: Array.from({ length: 10 }, (_, i) => ({ price: 71_000 + i, qty: 10 + i })),
              bid: Array.from({ length: 10 }, (_, i) => ({ price: 70_900 - i, qty: 20 + i })),
              tot_ask: 145,
              tot_bid: 245,
            },
          },
          {
            t: 2_000,
            available: true,
            snapshot: {
              ts_ms: 2_999,
              seq: 8,
              ask: Array.from({ length: 10 }, (_, i) => ({ price: 72_000 + i, qty: 110 + i })),
              bid: Array.from({ length: 10 }, (_, i) => ({ price: 71_900 - i, qty: 210 + i })),
              tot_ask: 1_145,
              tot_bid: 2_145,
            },
          },
        ],
        broker_buckets: [
          {
            t: 1_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
          },
          {
            t: 2_000,
            available: true,
            brokers: [{ broker: '미래에셋증권', net: 200, dominant_side: 'buy' }],
          },
        ],
        detail_warnings: [],
      },
    };
    useStudyViewSnapshotMock.mockReturnValue({
      data: enriched,
      isLoading: false,
      isError: false,
    });

    act(() => {
      useLiveCursorStore.getState().setCursor(1_500);
    });

    renderAt('/study?view=view1');

    expect(screen.getByTestId('study-detail-panel')).toBeTruthy();
    expect(screen.getByText('미래에셋')).toBeTruthy();
    expect(screen.getByText('+200')).toBeTruthy();
    expect(screen.queryByText('키움')).toBeNull();
    expect(screen.queryByText('+100')).toBeNull();
    expect(useLiveCursorStore.getState().cursorMs).toBe(1_500);
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1_500);

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    expect(props.onCursorActiveChange).toBeTypeOf('function');

    act(() => {
      props.onCursorActiveChange?.(true);
      useLiveCursorStore.getState().setCursor(1_500);
    });

    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+100')).toBeTruthy();
    expect(screen.queryByText('미래에셋')).toBeNull();
    expect(screen.queryByText('+200')).toBeNull();

    act(() => {
      props.onCursorActiveChange?.(false);
    });

    expect(screen.getByText('미래에셋')).toBeTruthy();
    expect(screen.getByText('+200')).toBeTruthy();
    expect(screen.queryByText('키움')).toBeNull();
    expect(screen.queryByText('+100')).toBeNull();
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();
  });

  it('renders an empty state without a view param', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    renderAt('/study');

    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(screen.getByText('저장된 학습뷰를 선택하세요.')).toBeTruthy();
    expect(useStudyViewSnapshotMock).toHaveBeenCalledWith(null);
    expect(liveChartRootMock).not.toHaveBeenCalled();
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();
  });
});
