import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { ComponentProps } from 'react';
import type { StudyViewReference } from '../api/studyViews';
import type { DayVolumeDistribution, RangeBundle, SymbolHit } from '../api/types';
import type { LiveChartRoot } from '../live/LiveChartRoot';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { useStudyTabsStore } from '../state/studyTabs';
import { useEntryDragStore } from '../state/entryDrag';
import { useLivePageStore } from '../state/livePage';
import { useLiveTabsStore } from '../state/liveTabs';

const {
  useStudyViewsMock,
  useStudyViewMutationsMock,
  useStudyReferenceBundleMock,
  useWarmStudyReferenceTabQueriesMock,
  useLiveOrderbookAtCursorMock,
  useLiveBrokersAtCursorMock,
  useVolumeDistributionCutoffProfileMock,
  useSymbolSearchMock,
  useLiveIndicesMock,
  indicatorPanelMockProps,
  liveChartRootMock,
} = vi.hoisted(() => ({
  useStudyViewsMock: vi.fn(),
  useStudyViewMutationsMock: vi.fn(),
  useStudyReferenceBundleMock: vi.fn(),
  useWarmStudyReferenceTabQueriesMock: vi.fn(),
  useLiveOrderbookAtCursorMock: vi.fn(),
  useLiveBrokersAtCursorMock: vi.fn(),
  useVolumeDistributionCutoffProfileMock: vi.fn((args: { finalProfile: DayVolumeDistribution | null | undefined }) => args.finalProfile),
  useSymbolSearchMock: vi.fn(),
  useLiveIndicesMock: vi.fn(),
  indicatorPanelMockProps: [] as Array<{ timeframe: string }>,
  liveChartRootMock: vi.fn(),
}));

vi.mock('./useStudyViews', () => ({
  useStudyViews: useStudyViewsMock,
  useStudyViewMutations: useStudyViewMutationsMock,
}));

vi.mock('./useStudyReferenceBundle', () => ({
  useStudyReferenceBundle: useStudyReferenceBundleMock,
}));

vi.mock('./useWarmStudyReferenceTabQueries', () => ({
  useWarmStudyReferenceTabQueries: useWarmStudyReferenceTabQueriesMock,
}));

vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: useLiveOrderbookAtCursorMock,
  useLiveBrokersAtCursor: useLiveBrokersAtCursorMock,
}));

vi.mock('../live/useVolumeDistributionCutoffProfile', () => ({
  useVolumeDistributionCutoffProfile: useVolumeDistributionCutoffProfileMock,
}));

// 10호가 전일 종가 baseline 조회 훅만 목킹(순수 prevCloseBeforeDate 는 실제 유지). 기본은
// data 없음 → baselinePrice null → OrderbookTable 매도/매수 폴백(색 단언 없는 기존 테스트 무영향).
vi.mock('../api/screenerDailyCandles', async (orig) => ({
  ...(await orig<typeof import('../api/screenerDailyCandles')>()),
  useScreenerDailyCandles: vi.fn(() => ({ data: undefined })),
}));

vi.mock('../capture/useSymbols', () => ({
  useSymbolSearch: useSymbolSearchMock,
}));

vi.mock('../api/liveIndices', () => ({
  useLiveIndices: useLiveIndicesMock,
}));

vi.mock('../live/LiveChartRoot', () => ({
  LiveChartRoot: (props: ComponentProps<typeof LiveChartRoot>) => {
    liveChartRootMock(props);
    return <div data-testid="live-chart-root-stub" />;
  },
}));

vi.mock('../live/indicators/IndicatorPanel', () => ({
  default: ({ onClose, timeframe }: { onClose: () => void; timeframe: string }) => {
    indicatorPanelMockProps.push({ timeframe });
    return (
      <div role="dialog" aria-label="보조지표">
        <button type="button" onClick={onClose}>닫기</button>
      </div>
    );
  },
}));

vi.mock('../live/LiveSettingsModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog" aria-label="설정">
      <button type="button" onClick={onClose}>닫기</button>
    </div>
  ),
}));

import { StudyPage } from './StudyPage';

const HOVER_MS = Date.UTC(2026, 5, 16, 1, 0, 0);

const cutoffDistribution: DayVolumeDistribution = {
  date: '20260616',
  range_count: 2,
  price_min: 1,
  price_max: 4,
  session_open_ms: 1_000,
  session_close_ms: 2_000,
  last_trade_ms: HOVER_MS,
  bins: [
    { price_low: 1, price_high: 2, qty: 30 },
    { price_low: 2, price_high: 3, qty: 20 },
    { price_low: 3, price_high: 4, qty: 10 },
  ],
};

const referenceSave: StudyViewReference = {
  schema_version: 2,
  id: 'view-ref',
  name: '돌파 복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260616', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false, right_padding_bars: 21 },
  memo: 'memo',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

const secondReferenceSave: StudyViewReference = {
  ...referenceSave,
  id: 'view-second',
  name: '눌림 복기',
  code: '000660',
  label: 'SK하이닉스',
  viewport: { right_edge_ms: 5_000, bar_span: 80, at_live_edge: false },
};

const searchHit: SymbolHit = {
  code: '005930',
  name: '삼성전자',
  market: 'KOSPI',
  captured_count: 1,
  captured_breakdown: { complete: 1, source_partial: 0, client_incomplete: 0, invalid: 0 },
};

function bundle(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [{
      date: '20260616',
      range_count: 2,
      price_min: 1,
      price_max: 3,
      session_open_ms: 1_000,
      session_close_ms: 2_000,
      last_trade_ms: 2_000,
      bins: [
        { price_low: 1, price_high: 2, qty: 10 },
        { price_low: 2, price_high: 3, qty: 20 },
      ],
    }],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    program_trade: {
      points: [{ t: 1_000, net_qty: 10, net_amount: 100_000_000, delta_qty: 10, delta_amount: 100_000_000, gap_risk: false }],
      source: 'kis_program_trade',
    },
    trade_volume_pocs: [{
      date: '20260616',
      center_price: 70_000,
      low_price: 69_500,
      high_price: 70_500,
      qty: 12_345,
      t_ms: 1_000,
      band_pct: 0.0025,
    }],
  };
}

function renderPage(initialEntry = '/study') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StudyPage />
    </MemoryRouter>,
  );
}

function getStudyTab(label: string) {
  return screen.getByRole('tab', { name: label });
}

beforeEach(() => {
  indicatorPanelMockProps.length = 0;
  liveChartRootMock.mockClear();
  useStudyViewsMock.mockReturnValue({
    data: { schema_version: 1, saves: [referenceSave, secondReferenceSave] },
    isLoading: false,
    isError: false,
  });
  useStudyViewMutationsMock.mockReturnValue({
    updateMetadata: { mutate: vi.fn(), isPending: false },
  });
  useStudyReferenceBundleMock.mockReturnValue({
    bundle: bundle(),
    chartBundle: bundle(),
    isLoading: false,
    isExtending: false,
    error: null,
    pastDataWarnings: [],
    venue: 'KRX',
  });
  useWarmStudyReferenceTabQueriesMock.mockClear();
  useWarmStudyReferenceTabQueriesMock.mockReturnValue({});
  useLiveOrderbookAtCursorMock.mockReturnValue(undefined);
  useLiveBrokersAtCursorMock.mockReturnValue(undefined);
  useSymbolSearchMock.mockReturnValue([searchHit]);
  useLiveIndicesMock.mockReturnValue({ data: [] });
  useVolumeDistributionCutoffProfileMock.mockClear();
  useVolumeDistributionCutoffProfileMock.mockImplementation(
    (args: { finalProfile: DayVolumeDistribution | null | undefined }) => args.finalProfile,
  );
  useLiveCursorStore.getState().resetCursor();
  useLiveTabsStore.setState({ tabs: [], activeTabId: null });
  useLivePageStore.setState({
    volumeDistributionEnabled: true,
    volumeDistributionHoverCutoffEnabled: false,
    volumeDistributionRangeCount: 2,
  });
  useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  useEntryDragStore.setState({ draggingCode: null, overStudy: false });
});

describe('StudyPage', () => {
  it('renders an empty state without a selected view', () => {
    renderPage();

    expect(screen.getByTestId('study-page-empty')).toHaveClass('bg-bg');
    expect(screen.getByTestId('study-page-empty')).toHaveClass('text-fg');
    expect(screen.getByText('저장된 학습뷰를 선택하세요.')).toBeTruthy();
  });

  it('does not open the symbol search dialog from the empty study page when "/" is pressed', () => {
    renderPage();

    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();

    fireEvent.keyDown(window, { key: '/' });

    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();
    expect(screen.queryByPlaceholderText('검색어를 입력해주세요')).toBeNull();
  });

  it('renders the shared drop overlay while dragging over the study workspace', () => {
    useEntryDragStore.setState({ draggingCode: '005930', overStudy: true });

    renderPage();

    expect(screen.getByText('여기에 놓아 학습뷰 열기')).toHaveClass('font-semibold');
  });

  it('renders a v2 reference view from raw range data without snapshot overrides', () => {
    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('study-page-primary')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('study-page-primary')).toHaveClass('border');
    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
    expect(screen.getByTestId('live-drawing-rail')).toBeInTheDocument();
    expect(useStudyReferenceBundleMock).toHaveBeenCalledWith(expect.objectContaining(referenceSave));
    const props = liveChartRootMock.mock.calls[0][0];
    expect(props.code).toBe('005930');
    expect(props.timeframe).toBe('5m');
    expect(props.venue).toBe('KRX');
    expect(props.restoreViewport).toEqual({
      rightEdgeMs: 2_000,
      barSpan: 120,
      atLiveEdge: false,
      rightPaddingBars: 21,
    });
    expect(props.todayKst).toBe('20260616');
    expect(props.tradeVolumePocs).toHaveLength(1);
    expect(props.paneTogglesOverride).toBeUndefined();
    expect(props.dailyMovingAverageOverride).toBeUndefined();
    expect(props.tradeVolumePocOverride).toBeUndefined();
  });

  it('passes the reference bundle venue into LiveChartRoot', () => {
    useStudyReferenceBundleMock.mockReturnValue({
      bundle: bundle(),
      chartBundle: bundle(),
      isLoading: false,
      error: null,
      pastDataWarnings: [],
      venue: 'NXT',
    });

    renderPage('/study?view=view-ref');

    expect(liveChartRootMock.mock.calls[0][0].venue).toBe('NXT');
  });

  it('uses the active saved-view tab timeframe over the saved reference timeframe', () => {
    useStudyTabsStore.setState({
      tabs: [{
        id: 'tab-ref',
        viewId: 'view-ref',
        code: '005930',
        label: '삼성전자 · 돌파 복기 · 3m',
        name: '돌파 복기',
        timeframe: '3m',
      }],
      activeTabId: 'tab-ref',
    });

    renderPage('/study?view=view-ref');

    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('3m');
    expect(screen.getByText('005930 · 3m · 복기뷰')).toBeTruthy();
  });

  it('switches the study reference timeframe with the live timeframe controls', () => {
    renderPage('/study?view=view-ref');

    fireEvent.click(screen.getByRole('button', { name: '일' }));

    expect(screen.getByText('005930 · D · 복기뷰')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'view-ref',
      timeframe: 'D',
    }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('D');

    fireEvent.click(screen.getByRole('button', { name: '분봉으로 전환: 5분' }));

    expect(screen.getByText('005930 · 5m · 복기뷰')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'view-ref',
      timeframe: '5m',
    }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('5m');

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 5분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '15분' }));

    expect(screen.getByText('005930 · 15m · 복기뷰')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'view-ref',
      timeframe: '15m',
    }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('15m');
  });

  it('keeps a study tab on the selected minute after switching from calendar timeframe', () => {
    useStudyTabsStore.setState({
      tabs: [{
        id: 'tab-ref',
        viewId: 'view-ref',
        code: '005930',
        label: '삼성전자 · 돌파 복기 · D',
        name: '돌파 복기',
        timeframe: 'D',
      }],
      activeTabId: 'tab-ref',
    });

    renderPage('/study?view=view-ref');

    fireEvent.click(screen.getByRole('button', { name: '분봉으로 전환: 5분' }));

    expect(screen.getByText('005930 · 5m · 복기뷰')).toBeTruthy();
    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '5m',
      label: '삼성전자 · 돌파 복기 · 5m',
    });
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('5m');
  });

  it('does not reuse a saved minute viewport after switching the study chart to D/W/M', () => {
    renderPage('/study?view=view-ref');

    fireEvent.click(screen.getByRole('button', { name: '일' }));

    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: 'D',
      restoreViewport: null,
    });

    fireEvent.click(screen.getByRole('button', { name: '주' }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: 'W',
      restoreViewport: null,
    });

    fireEvent.click(screen.getByRole('button', { name: '월' }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: 'M',
      restoreViewport: null,
    });

    fireEvent.click(screen.getByRole('button', { name: '분봉으로 전환: 5분' }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: '5m',
      restoreViewport: { rightEdgeMs: 2_000, barSpan: 120, atLiveEdge: false, rightPaddingBars: 21 },
    });
  });

  it('renders live chart action controls in the study header', () => {
    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('live-indicators-button')).toBeTruthy();
    expect(screen.getByTestId('live-settings-button')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '그리기' })).toBeNull();

    fireEvent.click(screen.getByTestId('live-indicators-button'));
    expect(screen.getByRole('dialog', { name: '보조지표' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    fireEvent.click(screen.getByTestId('live-settings-button'));
    expect(screen.getByRole('dialog', { name: '설정' })).toBeTruthy();
  });

  it('passes the active study timeframe into IndicatorPanel', () => {
    renderPage('/study?view=view-ref');

    fireEvent.click(screen.getByRole('button', { name: '일' }));
    fireEvent.click(screen.getByTestId('live-indicators-button'));

    expect(indicatorPanelMockProps.at(-1)?.timeframe).toBe('D');
    expect(screen.getByRole('dialog', { name: '보조지표' })).toBeTruthy();
  });

  it('passes the active study timeframe into IndicatorPanel while the reference bundle is loading', () => {
    useStudyTabsStore.setState({
      tabs: [{
        id: 'tab-ref',
        viewId: 'view-ref',
        code: '005930',
        label: '삼성전자 · 돌파 복기 · D',
        name: '돌파 복기',
        timeframe: 'D',
      }],
      activeTabId: 'tab-ref',
    });
    useStudyReferenceBundleMock.mockReturnValue({
      bundle: null,
      chartBundle: null,
      isLoading: true,
      error: null,
      pastDataWarnings: [],
    });

    renderPage('/study?view=view-ref');

    fireEvent.click(screen.getByTestId('live-indicators-button'));

    expect(indicatorPanelMockProps.at(-1)?.timeframe).toBe('D');
    expect(screen.getByRole('dialog', { name: '보조지표' })).toBeTruthy();
  });

  it('captures the active study tab viewport before switching tabs and restores it on return', () => {
    useStudyTabsStore.setState({
      tabs: [
        {
          id: 'tab-a',
          viewId: 'view-ref',
          code: '005930',
          label: '삼성전자 · 돌파 복기 · 5m',
          name: '돌파 복기',
          timeframe: '5m',
        },
        {
          id: 'tab-b',
          viewId: 'view-second',
          code: '000660',
          label: 'SK하이닉스 · 눌림 복기 · 5m',
          name: '눌림 복기',
          timeframe: '5m',
        },
      ],
      activeTabId: 'tab-a',
    });
    const capturedViewport = { rightEdgeMs: 9_000, barSpan: 42, atLiveEdge: false, rightPaddingBars: 17 };

    renderPage('/study?view=view-ref');
    act(() => {
      liveChartRootMock.mock.calls.at(-1)?.[0].onViewportCaptureReady?.(() => capturedViewport);
    });

    fireEvent.click(getStudyTab('SK하이닉스 · 눌림 복기 · 5m'));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].restoreViewport).toEqual({
      rightEdgeMs: 5_000,
      barSpan: 80,
      atLiveEdge: false,
    });

    fireEvent.click(getStudyTab('삼성전자 · 돌파 복기 · 5m'));

    expect(liveChartRootMock.mock.calls.at(-1)?.[0].restoreViewport).toEqual(capturedViewport);
  });

  it('restores a study tab viewport after the tab timeframe differs from the saved view timeframe', () => {
    useStudyTabsStore.setState({
      tabs: [
        {
          id: 'tab-a',
          viewId: 'view-ref',
          code: '005930',
          label: '삼성전자 · 돌파 복기 · 15m',
          name: '돌파 복기',
          timeframe: '15m',
        },
        {
          id: 'tab-b',
          viewId: 'view-second',
          code: '000660',
          label: 'SK하이닉스 · 눌림 복기 · 5m',
          name: '눌림 복기',
          timeframe: '5m',
        },
      ],
      activeTabId: 'tab-a',
    });
    const capturedViewport = { rightEdgeMs: 12_000, barSpan: 64, atLiveEdge: false };

    renderPage('/study?view=view-ref');
    act(() => {
      liveChartRootMock.mock.calls.at(-1)?.[0].onViewportCaptureReady?.(() => capturedViewport);
    });

    fireEvent.click(getStudyTab('SK하이닉스 · 눌림 복기 · 5m'));
    fireEvent.click(getStudyTab('삼성전자 · 돌파 복기 · 15m'));

    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: '15m',
      restoreViewport: capturedViewport,
    });
  });

  it('restores a captured calendar timeframe viewport without reusing the saved minute viewport', () => {
    useStudyTabsStore.setState({
      tabs: [
        {
          id: 'tab-a',
          viewId: 'view-ref',
          code: '005930',
          label: '삼성전자 · 돌파 복기 · D',
          name: '돌파 복기',
          timeframe: 'D',
        },
        {
          id: 'tab-b',
          viewId: 'view-second',
          code: '000660',
          label: 'SK하이닉스 · 눌림 복기 · 5m',
          name: '눌림 복기',
          timeframe: '5m',
        },
      ],
      activeTabId: 'tab-a',
    });
    const capturedDailyViewport = { rightEdgeMs: 22_000, barSpan: 33, atLiveEdge: false };

    renderPage('/study?view=view-ref');

    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: 'D',
      restoreViewport: null,
    });

    act(() => {
      liveChartRootMock.mock.calls.at(-1)?.[0].onViewportCaptureReady?.(() => capturedDailyViewport);
    });

    fireEvent.click(getStudyTab('SK하이닉스 · 눌림 복기 · 5m'));
    fireEvent.click(getStudyTab('삼성전자 · 돌파 복기 · D'));

    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: 'D',
      restoreViewport: capturedDailyViewport,
    });
  });

  it('hydrates reference detail indicators from cursor spot data on hover', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue({
      snapshot: {
        ts_ms: HOVER_MS,
        seq: 1,
        ask: Array.from({ length: 10 }, (_, index) => ({ price: 70_100 + index, qty: 10 + index })),
        bid: Array.from({ length: 10 }, (_, index) => ({ price: 70_000 - index, qty: 20 + index })),
        tot_ask: 145,
        tot_bid: 245,
      },
      available_from: null,
      source: 'hogaplay',
    });
    useLiveBrokersAtCursorMock.mockReturnValue([
      {
        broker: '키움증권',
        final_net: 1_200,
        dominant_side: 'buy',
        points: [{ ts_ms: HOVER_MS, net: 1_200 }],
      },
    ]);
    useLiveCursorStore.getState().setSidebarCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    expect(useLiveOrderbookAtCursorMock).toHaveBeenCalledWith({ code: '005930', timeframe: '5m' });
    expect(useLiveBrokersAtCursorMock).toHaveBeenCalledWith({ code: '005930', timeframe: '5m' });
    expect(screen.getByTestId('study-reference-detail-panel')).toBeTruthy();
    const orderbookCard = screen.getByTestId('study-detail-card-orderbook');
    const brokersCard = screen.getByTestId('study-detail-card-brokers');
    const volumeDistributionCard = screen.getByTestId('study-detail-card-volume-distribution');
    expect(
      orderbookCard.compareDocumentPosition(brokersCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      brokersCard.compareDocumentPosition(volumeDistributionCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('70,100')).toBeTruthy();
    expect(screen.getByLabelText('매도총잔량 145')).toBeTruthy();
    expect(screen.getByText('키움')).toBeTruthy();
    expect(screen.getByText('+1,200')).toBeTruthy();
    expect(screen.getByTestId('volume-distribution-card')).toBeTruthy();
    expect(screen.getByText('+1억')).toBeTruthy();
  });

  it('waits for the debounced sidebar cursor before activating reference spot details', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue({
      snapshot: {
        ts_ms: HOVER_MS,
        seq: 1,
        ask: Array.from({ length: 10 }, (_, index) => ({ price: 70_100 + index, qty: 10 + index })),
        bid: Array.from({ length: 10 }, (_, index) => ({ price: 70_000 - index, qty: 20 + index })),
        tot_ask: 145,
        tot_bid: 245,
      },
      available_from: null,
      source: 'hogaplay',
    });
    useLiveBrokersAtCursorMock.mockReturnValue([
      {
        broker: '키움증권',
        final_net: 1_200,
        dominant_side: 'buy',
        points: [{ ts_ms: HOVER_MS, net: 1_200 }],
      },
    ]);
    useLiveCursorStore.getState().setCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    const orderbookCard = screen.getByTestId('study-detail-card-orderbook');
    const brokersCard = screen.getByTestId('study-detail-card-brokers');
    expect(within(orderbookCard).queryByText('70,100')).toBeNull();
    expect(within(brokersCard).queryByText('키움')).toBeNull();
    expect(useVolumeDistributionCutoffProfileMock).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: false,
      cursorMs: null,
    }));
  });

  it('does not wire transient cursor active callbacks into study detail state', () => {
    renderPage('/study?view=view-ref');

    expect(liveChartRootMock.mock.calls[0][0].onCursorActiveChange).toBeUndefined();
  });

  it('shows orderbook loading instead of no-data while study cursor spot orderbook is fetching', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue(undefined);
    useLiveBrokersAtCursorMock.mockReturnValue([]);
    useLiveCursorStore.getState().setSidebarCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    const orderbookCard = screen.getByTestId('study-detail-card-orderbook');
    expect(within(orderbookCard).getByText('커서 위치 로딩 중…')).toBeTruthy();
    expect(within(orderbookCard).queryByText('호가 데이터 없음')).toBeNull();
  });

  it('keeps study cursor indicators visible while cursor remains set without relying on active callbacks', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue(undefined);
    useLiveBrokersAtCursorMock.mockReturnValue(undefined);
    useLiveCursorStore.getState().setSidebarCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    const orderbookCard = screen.getByTestId('study-detail-card-orderbook');
    const brokersCard = screen.getByTestId('study-detail-card-brokers');
    expect(within(orderbookCard).getByText('커서 위치 로딩 중…')).toBeTruthy();
    expect(within(orderbookCard).queryByText('호가 데이터 없음')).toBeNull();
    expect(within(brokersCard).getByText('커서 위치 로딩 중…')).toBeTruthy();
    expect(within(brokersCard).queryByText('거래원 정보 없음')).toBeNull();
  });

  it('renders study detail sections as separated cards inside the outer detail rail', () => {
    renderPage('/study?view=view-ref');

    const stack = screen.getByTestId('study-reference-detail-cards');
    expect(stack).toHaveClass('bg-bg-subtle/40');
    expect(stack).toHaveClass('gap-2');
    expect(stack).toHaveClass('p-2');

    for (const key of ['orderbook', 'brokers', 'volume-distribution', 'program'] as const) {
      const section = screen.getByTestId(`study-detail-card-${key}`);
      expect(section).toHaveClass('rounded-md');
      expect(section).toHaveClass('border');
      expect(section).toHaveClass('bg-bg-card');
    }
  });

  it('does not open the symbol search dialog from the study header when "/" is pressed', () => {
    renderPage('/study?view=view-ref');

    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();

    fireEvent.keyDown(window, { key: '/' });

    expect(screen.queryByRole('dialog', { name: '종목 검색' })).toBeNull();
    expect(screen.queryByPlaceholderText('검색어를 입력해주세요')).toBeNull();
  });

  it('uses hover-cutoff volume distribution for reference study views when enabled', () => {
    useLivePageStore.setState({
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: true,
      volumeDistributionRangeCount: 2,
    });
    const previousDateCandle = {
      ts_ms: Date.UTC(2026, 5, 15, 1, 0, 0),
      open: 1,
      high: 2,
      low: 1,
      close: 2,
      vol_a: 10,
      vol_b: 0,
    };
    const selectedDateCandle = {
      ts_ms: HOVER_MS,
      open: 2,
      high: 3,
      low: 2,
      close: 3,
      vol_a: 11,
      vol_b: 0,
    };
    const referenceBundle = {
      ...bundle(),
      from_date: '20260615',
      segments: [
        { date: '20260615', session_open_ms: Date.UTC(2026, 5, 15, 0, 0, 0), session_close_ms: Date.UTC(2026, 5, 15, 6, 30, 0) },
        { date: '20260616', session_open_ms: Date.UTC(2026, 5, 16, 0, 0, 0), session_close_ms: Date.UTC(2026, 5, 16, 6, 30, 0) },
      ],
      candles: [previousDateCandle, selectedDateCandle],
    };
    useStudyReferenceBundleMock.mockReturnValue({
      bundle: referenceBundle,
      chartBundle: referenceBundle,
      isLoading: false,
      error: null,
      pastDataWarnings: [],
    });
    useVolumeDistributionCutoffProfileMock.mockReturnValue(cutoffDistribution);
    useLiveCursorStore.getState().setSidebarCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    expect(useVolumeDistributionCutoffProfileMock).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      code: '005930',
      timeframe: '5m',
      date: '20260616',
      cursorMs: HOVER_MS,
      rangeCount: 2,
      candles: [selectedDateCandle],
    }));
    expect(screen.getByTestId('volume-distribution-card')).toBeTruthy();
    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(3);
  });

  it('lets long reference detail indicators grow downward while the whole detail panel scrolls', () => {
    useLiveBrokersAtCursorMock.mockReturnValue(
      Array.from({ length: 18 }, (_, index) => ({
        broker: `거래원${index + 1}`,
        final_net: index * 100,
        dominant_side: 'buy',
        points: [{ ts_ms: HOVER_MS, net: index * 100 }],
      })),
    );
    useLiveCursorStore.getState().setSidebarCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    const stack = screen.getByTestId('study-reference-detail-cards');
    expect(stack).toHaveClass('min-h-full');
    expect(stack).toHaveClass('gap-2');
    expect(stack).toHaveClass('p-2');
    expect(stack.getAttribute('style') ?? '').toContain('auto auto auto auto');
    for (const key of ['orderbook', 'volume-distribution', 'brokers', 'program']) {
      expect(screen.getByTestId(`study-detail-card-${key}`)).toHaveClass('rounded-md');
      expect(screen.getByTestId(`study-detail-card-${key}`)).toHaveClass('bg-bg-card');
      expect(screen.getByTestId(`study-detail-card-${key}`)).not.toHaveClass('overflow-hidden');
      expect(screen.getByTestId(`study-detail-content-${key}`)).not.toHaveClass('overflow-y-auto');
      expect(screen.getByTestId(`study-detail-content-${key}`)).not.toHaveClass('overflow-hidden');
    }
  });

  it('shows loading while the reference bundle is loading', () => {
    useStudyReferenceBundleMock.mockReturnValue({
      bundle: null,
      chartBundle: null,
      isLoading: true,
      error: null,
      pastDataWarnings: [],
    });

    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('study-page-loading')).toBeTruthy();
    expect(screen.getByText('학습뷰 불러오는 중...')).toBeTruthy();
  });

  // 캔들이 디스크 온리(hogaplay/스크리너)로 단일 호출이라 청크 워크백이 없다 →
  // 과거 로딩 배지(구 isExtending)는 제거됐다. 차트는 게이트 통과 후 바로 뜬다.
  it('과거 로딩 배지를 렌더하지 않는다 (디스크 온리, 워크백 없음)', () => {
    renderPage('/study?view=view-ref');

    expect(screen.queryByTestId('study-past-loading-badge')).toBeNull();
    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
  });

  it('keeps study tabs usable while the reference bundle is loading', () => {
    useStudyTabsStore.setState({
      tabs: [
        {
          id: 'tab-a',
          viewId: 'view-ref',
          code: '005930',
          label: '삼성전자 · 돌파 복기 · 5m',
          name: '돌파 복기',
          timeframe: '5m',
        },
        {
          id: 'tab-b',
          viewId: 'view-second',
          code: '000660',
          label: 'SK하이닉스 · 눌림 복기 · 5m',
          name: '눌림 복기',
          timeframe: '5m',
        },
      ],
      activeTabId: 'tab-a',
    });
    useStudyReferenceBundleMock.mockReturnValue({
      bundle: null,
      chartBundle: null,
      isLoading: true,
      error: null,
      pastDataWarnings: [],
    });

    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('study-page-loading')).toBeTruthy();
    expect(getStudyTab('삼성전자 · 돌파 복기 · 5m')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(getStudyTab('SK하이닉스 · 눌림 복기 · 5m'));

    expect(screen.getByText('학습뷰 불러오는 중...')).toBeTruthy();
    expect(getStudyTab('SK하이닉스 · 눌림 복기 · 5m')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps previously focused study tabs in the warm query set after switching tabs', () => {
    useStudyTabsStore.setState({
      tabs: [
        {
          id: 'tab-a',
          viewId: 'view-ref',
          code: '005930',
          label: '삼성전자 · 돌파 복기 · 5m',
          name: '돌파 복기',
          timeframe: '5m',
        },
        {
          id: 'tab-b',
          viewId: 'view-second',
          code: '000660',
          label: 'SK하이닉스 · 눌림 복기 · 5m',
          name: '눌림 복기',
          timeframe: '5m',
        },
      ],
      activeTabId: 'tab-a',
    });

    renderPage('/study?view=view-ref');

    fireEvent.click(getStudyTab('SK하이닉스 · 눌림 복기 · 5m'));

    expect(useWarmStudyReferenceTabQueriesMock).toHaveBeenLastCalledWith(expect.objectContaining({
      activeTabId: 'tab-b',
      activatedTabIds: expect.arrayContaining(['tab-a']),
      saves: [referenceSave, secondReferenceSave],
    }));
  });

  it('returns to the empty state when the selected view is missing', () => {
    renderPage('/study?view=missing');

    expect(screen.getByTestId('study-page-empty')).toBeTruthy();
    expect(screen.getByText('저장된 학습뷰를 선택하세요.')).toBeTruthy();
  });
});
