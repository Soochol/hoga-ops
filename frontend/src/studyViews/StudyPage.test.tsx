import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import type { ComponentProps } from 'react';
import type { ParquetStudySnapshot } from '../api/studyViews';
import type { LiveChartRoot } from '../live/LiveChartRoot';
import { useStudyTabsStore } from '../state/studyTabs';

const { useStudyViewSnapshotMock, useStudyViewsMock, useStudyViewMutationsMock, liveChartRootMock, useLiveBundleMock, useRangeMock } = vi.hoisted(() => ({
  useStudyViewSnapshotMock: vi.fn(),
  useStudyViewsMock: vi.fn(),
  useStudyViewMutationsMock: vi.fn(),
  liveChartRootMock: vi.fn(),
  useLiveBundleMock: vi.fn(),
  useRangeMock: vi.fn(),
}));

vi.mock('./useStudyViews', () => ({
  useStudyViewSnapshot: useStudyViewSnapshotMock,
  useStudyViews: useStudyViewsMock,
  useStudyViewMutations: useStudyViewMutationsMock,
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
import { isPointOnStudy, useEntryDragStore } from '../state/entryDrag';

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
    daily_moving_average_enabled: true,
    daily_moving_average_hidden: false,
    daily_moving_averages: [
      { id: 'dma-20', enabled: true, period: 20, color: '#EAB308', line_width: 2, source: 'close' },
    ],
    trade_volume_poc_enabled: true,
    trade_volume_poc_band_pct: 0.0025,
    trade_volume_poc_color: '#22C55E',
    trade_volume_poc_opacity: 0.28,
    volume_distribution_enabled: false,
    volume_distribution_range_count: 24,
    volume_distribution_color: '#64748B',
    volume_distribution_max_color: '#EAB308',
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
    bid_peaks: [{
      date: '20260616',
      price: 69_900,
      qty: 4_800,
      t_ms: 1_000,
      max_price: 69_800,
      max_qty: 5_800,
      max_t_ms: 1_000,
    }],
    trade_volume_pocs: [{
      date: '20260616',
      center_price: 70_000,
      low_price: 69_500,
      high_price: 70_500,
      qty: 12_345,
      t_ms: 1_000,
      band_pct: 0.0025,
    }],
    volume_distributions: [{
      date: '20260616',
      range_count: 24,
      price_min: 69_000,
      price_max: 72_000,
      session_open_ms: 1_000,
      session_close_ms: 2_000,
      bins: [
        { price_low: 69_000, price_high: 70_500, qty: 40 },
        { price_low: 70_500, price_high: 72_000, qty: 60 },
      ],
    }],
    data_warnings: [],
  },
  captured_at_ms: 3_000,
};

function makeSave(id: string, name: string) {
  return {
    id,
    name,
    code: '005930',
    label: '삼성전자',
    timeframe: 'D' as const,
  };
}

function makeSnapshot(viewId: string): ParquetStudySnapshot {
  return {
    ...snapshot,
    label: `삼성전자 ${viewId}`,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

function RouteChangeButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      route:{to}
    </button>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StudyPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('StudyPage', () => {
  beforeEach(() => {
    useStudyViewSnapshotMock.mockReset();
    useStudyViewsMock.mockReset();
    useStudyViewMutationsMock.mockReset();
    liveChartRootMock.mockReset();
    useLiveBundleMock.mockReset();
    useRangeMock.mockReset();
    window.localStorage.clear();
    useStudyTabsStore.setState({ tabs: [], activeTabId: null });
    useStudyViewsMock.mockReturnValue({
      data: {
        schema_version: 1,
        saves: [
          { id: 'view1', name: '장초반', code: '005930', label: '삼성전자', timeframe: 'D', memo: 'old memo' },
          { id: 'view2', name: '마감', code: '005930', label: '삼성전자', timeframe: 'D', memo: 'second memo' },
        ],
      },
      isLoading: false,
      isError: false,
    });
    useStudyViewMutationsMock.mockReturnValue({
      updateMetadata: { mutate: vi.fn(), isPending: false, error: null },
    });
    useLiveCursorStore.getState().resetCursor();
    (useEntryDragStore.setState as unknown as (state: Record<string, unknown>) => void)({
      draggingCode: null,
      overChart: false,
      overStudy: false,
      hitTestChart: null,
      hitTestStudy: null,
      targets: {},
    });
  });

  it('seeds a study tab from the query and renders the study tab bar', () => {
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    renderAt('/study?view=view1');

    const state = useStudyTabsStore.getState();
    expect(screen.getByRole('tablist', { name: '열린 탭' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /삼성전자 · 장초반 · D/i })).toHaveAttribute('aria-selected', 'true');
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view1' });
    expect(state.activeTabId).toBe(state.tabs[0].id);
  });

  it('replaces the active study tab when the study route changes to a different saved view', async () => {
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    render(
      <MemoryRouter initialEntries={['/study?view=view1']}>
        <StudyPage />
        <RouteChangeButton to="/study?view=view2" />
        <LocationProbe />
      </MemoryRouter>,
    );

    const initialState = useStudyTabsStore.getState();
    const initialActiveTabId = initialState.activeTabId;

    await userEvent.click(screen.getByRole('button', { name: 'route:/study?view=view2' }));

    const state = useStudyTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(initialActiveTabId);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view2' });
    expect(screen.getByRole('tab', { name: /삼성전자 · 마감 · D/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('삼성전자 view2')).toBeTruthy();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study?view=view2');
  });

  it('does not let a persisted active tab overwrite the initial query route before saves resolve', async () => {
    useStudyTabsStore.getState().openSaveInActiveTab(makeSave('view2', '마감'));
    let savesResult: {
      data?: { schema_version: number; saves: Array<ReturnType<typeof makeSave> & { memo: string }> };
      isLoading: boolean;
      isError: boolean;
    } = {
      data: undefined,
      isLoading: true,
      isError: false,
    };
    useStudyViewsMock.mockImplementation(() => savesResult);
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: !savesResult.isLoading && viewId ? makeSnapshot(viewId) : undefined,
      isLoading: savesResult.isLoading,
      isError: false,
    }));

    const rendered = renderAt('/study?view=view1');

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study?view=view1');
    expect(useStudyTabsStore.getState().tabs.find((tab) => tab.id === useStudyTabsStore.getState().activeTabId)?.viewId).toBe('view2');

    savesResult = {
      data: {
        schema_version: 1,
        saves: [
          { ...makeSave('view1', '장초반'), memo: 'old memo' },
          { ...makeSave('view2', '마감'), memo: 'second memo' },
        ],
      },
      isLoading: false,
      isError: false,
    };

    rendered.rerender(
      <MemoryRouter initialEntries={['/study?view=view1']}>
        <StudyPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    const state = useStudyTabsStore.getState();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study?view=view1');
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId).toBe('view1');
  });

  it('pressing 2 focuses the second tab when two study tabs exist', async () => {
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view1', '장초반'));
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view2', '마감'));
    const firstTabId = useStudyTabsStore.getState().tabs[0].id;
    useStudyTabsStore.getState().focusTab(firstTabId);
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    renderAt('/study');
    await userEvent.keyboard('2');

    const state = useStudyTabsStore.getState();
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId).toBe('view2');
    expect(screen.getByRole('tab', { name: /삼성전자 · 마감 · D/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study?view=view2');
  });

  it('uses the newly focused tab snapshot before the URL catches up', () => {
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view1', '장초반'));
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view2', '마감'));
    const firstTabId = useStudyTabsStore.getState().tabs[0].id;
    useStudyTabsStore.getState().focusTab(firstTabId);
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    renderAt('/study?view=view1');
    useStudyViewSnapshotMock.mockClear();

    fireEvent.click(screen.getByRole('tab', { name: /삼성전자 · 마감 · D/i }));

    expect(useStudyViewSnapshotMock).toHaveBeenCalled();
    expect(useStudyViewSnapshotMock.mock.calls[0][0]).toBe('view2');
  });

  it('pressing 5 does nothing', async () => {
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view1', '장초반'));
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view2', '마감'));
    const firstTabId = useStudyTabsStore.getState().tabs[0].id;
    useStudyTabsStore.getState().focusTab(firstTabId);
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    renderAt('/study');
    await userEvent.keyboard('5');

    expect(useStudyTabsStore.getState().activeTabId).toBe(firstTabId);
    expect(screen.getByRole('tab', { name: /삼성전자 · 장초반 · D/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study?view=view1');
  });

  it('ignores digit shortcuts while an input is focused', async () => {
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view1', '장초반'));
    useStudyTabsStore.getState().openSaveInNewTab(makeSave('view2', '마감'));
    const firstTabId = useStudyTabsStore.getState().tabs[0].id;
    useStudyTabsStore.getState().focusTab(firstTabId);
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    renderAt('/study');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await userEvent.keyboard('2');

    expect(useStudyTabsStore.getState().activeTabId).toBe(firstTabId);
    expect(screen.getByRole('tab', { name: /삼성전자 · 장초반 · D/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study?view=view1');

    input.remove();
  });

  it('returns to the empty study route when the last tab is closed', async () => {
    useStudyViewSnapshotMock.mockImplementation((viewId: string | null) => ({
      data: viewId ? makeSnapshot(viewId) : undefined,
      isLoading: false,
      isError: false,
    }));

    renderAt('/study?view=view1');
    await userEvent.click(screen.getByRole('button', { name: '005930 닫기' }));

    expect(useStudyTabsStore.getState().tabs).toHaveLength(0);
    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/study');
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
      dayBidPeaks: [{
        date: '20260616',
        price: 69_900,
        qty: 4_800,
        t_ms: 1_000,
        max_price: 69_800,
        max_qty: 5_800,
        max_t_ms: 1_000,
      }],
      tradeVolumePocs: [{
        date: '20260616',
        centerPrice: 70_000,
        lowPrice: 69_500,
        highPrice: 70_500,
        qty: 12_345,
        t_ms: 1_000,
        bandPct: 0.0025,
      }],
      todayKst: '20260616',
      forceHogaPanes: true,
      paneTogglesOverride: {
        volumeEnabled: false,
        quoteTotalsEnabled: true,
        ratioEnabled: false,
        fillStrengthEnabled: true,
      },
      dailyMovingAverageOverride: {
        configs: [{ id: 'dma-20', enabled: true, period: 20, color: '#EAB308', lineWidth: 2, source: 'close' }],
        masterEnabled: true,
        hidden: false,
      },
      tradeVolumePocOverride: {
        enabled: true,
        color: '#22C55E',
        opacity: 0.28,
      },
      volumeDistributionOverride: {
        enabled: false,
        rangeCount: 24,
        color: '#64748B',
        maxColor: '#EAB308',
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

  it('reconstructs trade-volume POC bands from saved candles when older snapshots have no POC rows', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: {
        ...snapshot,
        bundle: {
          ...snapshot.bundle,
          trade_volume_pocs: [],
          candles: [
            { t: 1_000, open: 70_000, high: 70_100, low: 69_900, close: 70_000, volume: 100 },
            { t: 1_600, open: 70_000, high: 70_100, low: 69_900, close: 70_000, volume: 200 },
          ],
        },
      },
      isLoading: false,
      isError: false,
    });

    renderAt('/study?view=view1');

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    expect(props.tradeVolumePocs).toEqual([{
      date: '20260616',
      centerPrice: 70_000,
      lowPrice: 69_800,
      highPrice: 70_200,
      qty: 300,
      t_ms: 1_000,
      bandPct: 0.0025,
    }]);
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

    const chartWrapper = screen.getByTestId('live-chart-root-stub').parentElement;
    expect(chartWrapper).toHaveClass('overflow-hidden');
    expect(chartWrapper?.parentElement).toHaveClass(
      'grid-cols-[minmax(0,1fr)_var(--sidebar-w)]',
    );
    expect(screen.getByTestId('study-detail-panel')).toBeTruthy();
    expect(screen.getByTestId('card-orderbook')).toBeTruthy();
    expect(screen.getByTestId('card-brokers')).toBeTruthy();
    expect(screen.getByText('10호가')).toBeTruthy();
    expect(screen.getByRole('group', { name: '총잔량' })).toBeTruthy();
    expect(screen.getByLabelText('매도총잔량 145')).toBeInTheDocument();
    expect(screen.getByLabelText('매수총잔량 245')).toBeInTheDocument();
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
        segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 61_999 }],
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

  it('registers the study drop target on the empty study shell and clears it on unmount', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });

    const rendered = renderAt('/study');
    const target = screen.getByTestId('study-drop-target');

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 120,
      left: 100,
      top: 120,
      right: 700,
      bottom: 620,
      width: 600,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(isPointOnStudy({ x: 300, y: 300 })).toBe(true);
    expect(isPointOnStudy({ x: 80, y: 300 })).toBe(false);

    rendered.unmount();

    expect(isPointOnStudy({ x: 300, y: 300 })).toBe(false);
  });

  it('registers the study drop target while a saved study view is mounted', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: snapshot,
      isLoading: false,
      isError: false,
    });

    renderAt('/study?view=view1');
    const target = screen.getByTestId('study-drop-target');

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 120,
      left: 100,
      top: 120,
      right: 700,
      bottom: 620,
      width: 600,
      height: 500,
      toJSON: () => ({}),
    } as DOMRect);

    expect(isPointOnStudy({ x: 300, y: 300 })).toBe(true);
    expect(isPointOnStudy({ x: 80, y: 300 })).toBe(false);

    expect(screen.getByTestId('study-page')).toBeTruthy();
  });

  it('shows the study drop overlay when an entry drag is over the study target', () => {
    useStudyViewSnapshotMock.mockReturnValue({
      data: snapshot,
      isLoading: false,
      isError: false,
    });
    useEntryDragStore.setState({ draggingCode: '005930', overStudy: true });

    renderAt('/study?view=view1');

    const overlay = screen.getByText('여기에 놓아 학습뷰 열기').closest('[aria-hidden="true"]');
    const aside = screen.getByTestId('study-page').querySelector('aside');

    expect(overlay).toBeTruthy();
    expect(aside).toBeTruthy();
    expect(overlay!).toHaveClass('z-20');
    expect(aside!).toHaveClass('z-10');
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

  it('keeps broker rows visible before their first saved bucket in the active session', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 121_999 }],
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
          { t: 61_000, open: 71_000, high: 73_000, low: 70_000, close: 72_000, volume: 120 },
          { t: 121_000, open: 72_000, high: 74_000, low: 71_000, close: 73_000, volume: 130 },
        ],
        orderbook_buckets: [
          { t: 1_000, available: false, snapshot: null },
          { t: 61_000, available: false, snapshot: null },
          { t: 121_000, available: false, snapshot: null },
        ],
        broker_buckets: [
          {
            t: 1_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
          },
          {
            t: 121_000,
            available: true,
            brokers: [{ broker: '미래에셋증권', net: 300, dominant_side: 'buy' }],
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

    const { container } = renderAt('/study?view=view1');

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    act(() => {
      props.onCursorActiveChange?.(true);
      useLiveCursorStore.getState().setCursor(1_500);
    });

    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('미래에셋')).toBeTruthy();
    expect(screen.getByText('+100')).toBeTruthy();
    expect(screen.queryByText('+300')).toBeNull();
    expect(container.querySelectorAll('[data-testid="broker-row"]')).toHaveLength(2);
  });

  it('keeps current-bucket brokers inside the rendered row cap', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 121_999 }],
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
          { t: 121_000, open: 72_000, high: 74_000, low: 71_000, close: 73_000, volume: 130 },
        ],
        orderbook_buckets: [
          { t: 1_000, available: false, snapshot: null },
          { t: 121_000, available: false, snapshot: null },
        ],
        broker_buckets: [
          {
            t: 1_000,
            available: true,
            brokers: [{ broker: '현재증권', net: 1, dominant_side: 'buy' }],
          },
          {
            t: 121_000,
            available: true,
            brokers: Array.from({ length: 10 }, (_, i) => ({
              broker: `미래${i}증권`,
              net: 1_000 - i,
              dominant_side: 'buy' as const,
            })),
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

    const { container } = renderAt('/study?view=view1');

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    act(() => {
      props.onCursorActiveChange?.(true);
      useLiveCursorStore.getState().setCursor(1_500);
    });

    expect(container.querySelectorAll('[data-testid="broker-row"]')).toHaveLength(10);
    expect(container.querySelector('[title="현재증권"]')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('does not show all saved brokers when the cursor bucket has no matching segment', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        segments: [{ date: '20260616', session_open_ms: 99_000, session_close_ms: 100_000 }],
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
        ],
        orderbook_buckets: [
          { t: 1_000, available: false, snapshot: null },
        ],
        broker_buckets: [
          {
            t: 1_000,
            available: true,
            brokers: [{ broker: '키움증권', net: 100, dominant_side: 'buy' }],
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

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    act(() => {
      props.onCursorActiveChange?.(true);
      useLiveCursorStore.getState().setCursor(1_500);
    });

    expect(screen.getByText('거래원 정보 없음')).toBeTruthy();
    expect(screen.queryByText('키움')).toBeNull();
  });

  it('does not show all saved brokers when the cursor is outside saved candle buckets', () => {
    const enriched: ParquetStudySnapshot = {
      ...snapshot,
      timeframe: '1m',
      bucket_kind: '1m',
      bundle: {
        ...snapshot.bundle,
        timeframe: '1m',
        segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 61_999 }],
        candles: [
          { t: 1_000, open: 70_000, high: 72_000, low: 69_000, close: 71_000, volume: 100 },
          { t: 61_000, open: 71_000, high: 73_000, low: 70_000, close: 72_000, volume: 120 },
        ],
        orderbook_buckets: [
          { t: 1_000, available: false, snapshot: null },
          { t: 61_000, available: false, snapshot: null },
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
            brokers: [{ broker: '미래에셋증권', net: 300, dominant_side: 'buy' }],
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
      useLiveCursorStore.getState().setCursor(999_000);
    });

    renderAt('/study?view=view1');

    const props = liveChartRootMock.mock.calls[0][0] as ComponentProps<typeof LiveChartRoot>;
    act(() => {
      props.onCursorActiveChange?.(true);
      useLiveCursorStore.getState().setCursor(999_000);
    });

    expect(screen.getByText('거래원 정보 없음')).toBeTruthy();
    expect(screen.queryByText('키움')).toBeNull();
    expect(screen.queryByText('미래에셋')).toBeNull();
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
    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+100')).toBeTruthy();
    expect(screen.getByText('미래에셋')).toBeTruthy();
    expect(screen.getByText('+200')).toBeTruthy();
    expect(screen.getAllByTestId('broker-row')).toHaveLength(2);
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
    expect(screen.getByText('미래에셋')).toBeTruthy();
    expect(screen.queryByText('+200')).toBeNull();
    expect(screen.getAllByTestId('broker-row')).toHaveLength(2);

    act(() => {
      props.onCursorActiveChange?.(false);
    });

    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+100')).toBeTruthy();
    expect(screen.getByText('미래에셋')).toBeTruthy();
    expect(screen.getByText('+200')).toBeTruthy();
    expect(screen.getAllByTestId('broker-row')).toHaveLength(2);
    expect(useLiveBundle).not.toHaveBeenCalled();
    expect(useRange).not.toHaveBeenCalled();
  });

  it('opens a docked memo panel and commits memo edits', async () => {
    const updateMetadataMutate = vi.fn((_vars, opts) => opts.onSuccess?.());
    useStudyViewMutationsMock.mockReturnValue({
      updateMetadata: { mutate: updateMetadataMutate, isPending: false, error: null },
    });
    useStudyViewSnapshotMock.mockReturnValue({ data: snapshot, isLoading: false, isError: false });
    const { container } = renderAt('/study?view=view1');

    const memoToggle = screen.getByRole('button', { name: '메모' });
    expect(memoToggle.className).toContain('bg-bg-input');
    expect(memoToggle.className).toContain('border-border');
    expect(memoToggle.className).toContain('hover:bg-bg-input-hover');

    await userEvent.click(memoToggle);
    const panel = screen.getByTestId('study-memo-panel');
    const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
    await userEvent.clear(memo);
    await userEvent.type(memo, '새 메모');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));

    const aside = panel.closest('aside');
    expect(aside).toBeTruthy();
    expect(aside).toContainElement(panel);
    expect(container.querySelector('[data-testid="study-page"] > div > aside')).toBe(aside);
    expect(container.querySelector('[data-testid="study-page"] > div > div > [data-testid="live-chart-root-stub"]')).toBeTruthy();
    expect(updateMetadataMutate).toHaveBeenCalledWith(
      { id: 'view1', body: { memo: '새 메모' } },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('keeps the memo panel open when memo blur commits after chart click', async () => {
    const updateMetadataMutate = vi.fn();
    useStudyViewMutationsMock.mockReturnValue({
      updateMetadata: { mutate: updateMetadataMutate, isPending: false, error: null },
    });
    useStudyViewSnapshotMock.mockReturnValue({ data: snapshot, isLoading: false, isError: false });
    renderAt('/study?view=view1');

    await userEvent.click(screen.getByRole('button', { name: '메모' }));
    const memo = screen.getByLabelText('저장뷰 메모') as HTMLTextAreaElement;
    await userEvent.clear(memo);
    await userEvent.type(memo, '차트 보면서 메모');
    fireEvent.blur(memo);
    fireEvent.click(screen.getByTestId('live-chart-root-stub'));

    expect(updateMetadataMutate).toHaveBeenCalledWith(
      { id: 'view1', body: { memo: '차트 보면서 메모' } },
      expect.any(Object),
    );
    expect(screen.getByTestId('study-memo-panel')).toBeTruthy();
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
