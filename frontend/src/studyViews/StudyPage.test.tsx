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
import { useStudyWorkspaceStore, type StudyWorkspaceWindow } from '../state/studyWorkspace';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';

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
  capturedWindowSpecs,
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
  // 번들 훅이 받은 창별 스펙 — 봉·지표가 곧 쿼리 키라, 창 분리가 여기 닿는지를
  // 재려면 인자를 봐야 한다(반환값은 mock 이 만들므로 아무것도 증명하지 않는다).
  capturedWindowSpecs: { current: [] as Array<{ windowId: string; indicators: Record<string, unknown> }> },
}));

vi.mock('./useStudyViews', () => ({
  useStudyViews: useStudyViewsMock,
  useStudyViewMutations: useStudyViewMutationsMock,
}));

// 훅은 이제 창별 번들을 **창 id 로 접은 레코드**로 준다(#801). 기존 단수 mock 을
// 그대로 살리고(단언 자산이 크다) 여기서 창 목록에 같은 값을 펴 준다 — 창이 하나면
// 결과도 하나라 기존 계약과 동치다.
vi.mock('./useStudyReferenceBundle', () => ({
  useStudyReferenceBundles: (
    save: unknown,
    windows: ReadonlyArray<{ windowId: string; timeframe: string; indicators: Record<string, unknown> }>,
  ) => Object.fromEntries((capturedWindowSpecs.current = [...windows]).map((w) => {
    const displayedSave = save && typeof save === 'object'
      ? { ...save, timeframe: w.timeframe }
      : save;
    const result = useStudyReferenceBundleMock(displayedSave, null);
    // 실제 훅은 "이 창이 표시 중인 봉으로 덮어쓴 저장뷰" 와 그 봉의 맥락 창을 함께
    // 준다 — 페이지가 둘로 차트 봉·저장구간 밴드·초기 뷰포트를 정하므로 mock 도
    // 같은 모양이어야 한다(캘린더 봉에만 창이 있다는 규칙까지).
    const dailyContext = /^\d+m$/.test(w.timeframe)
      ? null
      : { from: '20250701', to: '20260810' };
    return [w.windowId, result ? { ...result, displayedSave, dailyContext } : result];
  })),
}));

vi.mock('./useWarmStudyReferenceTabQueries', () => ({
  useWarmStudyReferenceTabQueries: useWarmStudyReferenceTabQueriesMock,
}));

vi.mock('./useStudyRangeCacheEviction', () => ({
  useStudyRangeCacheEviction: () => {},
}));

// 툴바의 창 배치 프리셋 메뉴도 react-query 훅을 쓴다 — 이 파일은 Provider 를 두지 않고
// 데이터 훅을 모킹하는 방식이라 같은 규율을 따른다(프리셋 동작은 자기 테스트가 본다).
vi.mock('./presets/useStudyLayoutPresets', () => ({
  useStudyLayoutPresets: () => ({ data: { schema_version: 1, presets: [] }, refetch: vi.fn() }),
  useStudyLayoutPresetMutations: () => ({
    create: { mutate: vi.fn() },
    update: { mutate: vi.fn() },
    remove: { mutate: vi.fn() },
  }),
}));

vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: useLiveOrderbookAtCursorMock,
  useLiveBrokersAtCursor: useLiveBrokersAtCursorMock,
}));

vi.mock('../live/useVolumeDistributionCutoffProfile', () => ({
  useVolumeDistributionCutoffProfile: useVolumeDistributionCutoffProfileMock,
}));

// 10호가 전일 종가 baseline 조회 훅만 목킹(순수 prevCloseBeforeDate 는 실제 유지). 기본은
// data 없음 → baselinePrice null → BookPanel.dirClass 가 중립 text-fg-dim 으로 폴백하고
// 등락률은 생략된다(색 단언 없는 기존 테스트 무영향).
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
  // 지표는 앱 전역 1세트다 — 창은 어느 봉 버킷을 볼지만 정한다. 창 밖 소비자
  // (vdist 데이터 창·번들 쿼리 키)도 같은 전역 버킷을 창의 봉으로 편다(#904).
  useLivePageStore.setState({
    indicatorsByTimeframe: {
      minute: {
        volumeDistributionEnabled: true,
        volumeDistributionHoverCutoffEnabled: false,
        volumeDistributionRangeCount: 2,
      },
      D: {
        volumeDistributionEnabled: true,
        volumeDistributionHoverCutoffEnabled: false,
        volumeDistributionRangeCount: 2,
      },
    },
  });
  useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  useEntryDragStore.setState({ draggingCode: null, overStudy: false });
  // 창 워크스페이스(ADR-0123) — 시드와 무관한 결정적 배치로 초기화. DOM 순서 =
  // windows 배열 순서(orderbook → brokers → vdist → program).
  const seedWindows: StudyWorkspaceWindow[] = [
    {
      id: 'w-chart',
      kind: 'chart',
      rect: { x: 0, y: 0, w: 0.72, h: 1 },
      // ⚠️ setState 는 하이드레이션(ensureChartWindow)을 우회하므로 창 설정을
      // 직접 심어야 한다. 없으면 `withChart` 가 no-op 이라 봉 전환이 조용히 죽고,
      // 지표도 폴백 봉의 버킷으로 펴진다.
      chart: {
        timeframe: '5m',
        lastMinuteTimeframe: '5m',
      },
    },
    { id: 'w-book', kind: 'book', rect: { x: 0.72, y: 0, w: 0.28, h: 0.25 } },
    { id: 'w-broker', kind: 'broker', rect: { x: 0.72, y: 0.25, w: 0.28, h: 0.25 } },
    { id: 'w-vdist', kind: 'vdist', rect: { x: 0.72, y: 0.5, w: 0.28, h: 0.25 } },
    { id: 'w-program', kind: 'program', rect: { x: 0.72, y: 0.75, w: 0.28, h: 0.25 } },
  ];
  useStudyWorkspaceStore.setState({
    windows: seedWindows,
    zOrder: ['w-book', 'w-broker', 'w-vdist', 'w-program', 'w-chart'],
  });
});

describe('StudyPage', () => {
  it('renders an empty state without a selected view', () => {
    renderPage();

    expect(screen.getByTestId('study-page-empty')).toHaveClass('bg-bg');
    expect(screen.getByTestId('study-page-empty')).toHaveClass('text-fg');
    expect(screen.getByText('저장된 학습뷰를 선택하세요')).toBeTruthy();
  });

  it('empty state offers a button that opens the saved-views drawer', async () => {
    // 빈 상태 = "한 줄 설명 + 행동 1개" — 다음 행동(저장뷰 드로어)을 버튼이 직접 연다.
    const { useRightRailStore } = await import('../state/rightRail');
    useRightRailStore.getState().setActivePanel(null);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: '저장뷰 열기' }));
    expect(useRightRailStore.getState().activePanel).toBe('savedViews');
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

    // 창 워크스페이스(ADR-0123): 카드 크롬은 창 프레임(WindowFrameCore)이 소유하고,
    // 차트 콘텐츠는 차트 창 안에 산다.
    expect(screen.getByTestId('study-page-primary')).toHaveClass('bg-bg');
    expect(screen.getByTestId('study-page-primary')).not.toHaveClass('border');
    expect(screen.getByTestId('study-chart-card').closest('[data-win]')).not.toBeNull();
    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
    // 44px 그리기 레일은 #760 으로 폐기 — 그리기는 헤더의 DrawingMenu 가 연다.
    expect(screen.queryByTestId('live-drawing-rail')).not.toBeInTheDocument();
    // 2번째 인자 null = 프로토타입 일봉 맥락 창 미사용(현행 동작).
    expect(useStudyReferenceBundleMock).toHaveBeenCalledWith(expect.objectContaining(referenceSave), null);
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

  it('창 봉이 탭 봉과 저장 봉을 모두 이긴다 (#1326)', () => {
    // 창은 시드대로 5m, 탭은 3m 을 들고 있다. 예전에는 탭이 이겨(그리고 창을 덮어)
    // 3m 이 됐다 — 이제 봉의 소유자는 창이므로 5m 이다.
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

    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('5m');
    expect(screen.getByText('005930 · 복기뷰')).toBeTruthy();
  });

  it('첫 렌더부터 창 봉으로만 번들을 요청한다 — 버려질 번들을 안 받는다', () => {
    // 세 값을 **모두 다르게** 둔다(창 15m · 탭 3m · 저장 5m). 하나라도 겹치면 어느
    // 축이 이겼는지 구별할 수 없다. 창 봉이 아닌 값으로 한 번이라도 요청이 나가면
    // 그 구간 range 번들(수십 MB)을 받아 놓고 버린다(#689 후속, #1326 에서 축 반전).
    setChartWindowTimeframe('15m');
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

    useStudyReferenceBundleMock.mockClear();
    renderPage('/study?view=view-ref');

    const requestedTimeframes = useStudyReferenceBundleMock.mock.calls
      .map(([save]) => (save as StudyViewReference | null)?.timeframe)
      .filter((timeframe): timeframe is StudyViewReference['timeframe'] => timeframe != null);
    expect(requestedTimeframes.length).toBeGreaterThan(0);
    expect(requestedTimeframes.every((timeframe) => timeframe === '15m')).toBe(true);
  });

  it('switches the study reference timeframe with the live timeframe controls', () => {
    renderPage('/study?view=view-ref');

    fireEvent.click(screen.getByRole('button', { name: '일' }));

    expect(screen.getByText('005930 · 복기뷰')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'view-ref',
      timeframe: 'D',
      // 맥락 창(#1240) 계산은 훅 안으로 내려갔다(#801) — 여기서는 "이 창의 봉으로
      // 계획이 세워졌는가"만 본다. 창 계산은 useStudyReferenceBundle.test 가 잰다.
    }), null);
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('D');

    fireEvent.click(screen.getByRole('button', { name: '분봉으로 전환: 5분' }));

    expect(screen.getByText('005930 · 복기뷰')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'view-ref',
      timeframe: '5m',
    }), null);
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('5m');

    fireEvent.click(screen.getByRole('button', { name: '분봉 선택 열기: 5분' }));
    fireEvent.click(within(screen.getByRole('menu', { name: '분봉 목록' })).getByRole('menuitemradio', { name: '15분' }));

    expect(screen.getByText('005930 · 복기뷰')).toBeTruthy();
    expect(useStudyReferenceBundleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'view-ref',
      timeframe: '15m',
    }), null);
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('15m');
  });

  it('keeps a study tab on the selected minute after switching from calendar timeframe', () => {
    // 창을 D 로 세운다 — 봉의 소유자가 창이므로(#1326) 탭만 D 로 두면 화면은 5m 이라
    // "캘린더 봉에서 전환" 이라는 이 테스트의 전제 자체가 사라진다.
    setChartWindowTimeframe('D');
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

    expect(screen.getByText('005930 · 복기뷰')).toBeTruthy();
    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '5m',
      label: '삼성전자 · 돌파 복기 · 5m',
    });
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].timeframe).toBe('5m');
  });

  /**
   * 포커스 차트 창의 봉을 세운다.
   *
   * 봉의 소유자가 창이므로(#1326) **화면이 설 봉은 여기서 정해진다** — 탭에만 봉을
   * 심으면 창이 시드값(5m)에 남아 그 테스트의 전제가 조용히 사라진다.
   */
  function setChartWindowTimeframe(timeframe: LiveTimeframe) {
    useStudyWorkspaceStore.setState({
      windows: useStudyWorkspaceStore.getState().windows.map((w) => (
        w.id === 'w-chart' && w.chart ? { ...w, chart: { ...w.chart, timeframe } } : w
      )),
    });
  }

  // ── 멀티 차트 창 (#801 단계 1) ──────────────────────────────────────
  /** 두 번째 차트 창을 심는다 — 스토어 setState 는 하이드레이션을 우회하므로
   *  첫 창의 chart 설정을 복제해 넣는다(addWindow 가 하는 일과 같다). */
  function addSecondChartWindow(timeframe: LiveTimeframe) {
    const s = useStudyWorkspaceStore.getState();
    const first = s.windows.find((w) => w.id === 'w-chart')!;
    useStudyWorkspaceStore.setState({
      windows: [
        ...s.windows,
        {
          ...first,
          id: 'w-chart-2',
          rect: { x: 0, y: 0, w: 0.3, h: 0.5 },
          chart: { ...first.chart!, timeframe },
        },
      ],
      // zOrder 최상단 = 포커스. 첫 창을 포커스로 유지한다.
      zOrder: [...s.zOrder, 'w-chart-2', 'w-chart'],
    });
  }

  function chartPropsByTimeframe() {
    const byTf: Record<string, unknown> = {};
    for (const call of liveChartRootMock.mock.calls) byTf[call[0].timeframe] = call[0];
    return byTf;
  }

  it('차트 창마다 자기 봉으로 렌더한다 — 창별 번들', () => {
    addSecondChartWindow('D');

    renderPage('/study?view=view-ref');

    const rendered = chartPropsByTimeframe();
    // 포커스 창은 5m(탭·저장뷰), 두 번째 창은 D.
    expect(Object.keys(rendered).sort()).toEqual(['5m', 'D']);
  });

  it('비포커스 창의 봉을 바꿔도 탭 라벨은 그대로다 — write-through 는 포커스 창만', () => {
    useStudyTabsStore.setState({
      tabs: [{
        id: 'tab-ref', viewId: 'view-ref', code: '005930',
        label: '삼성전자 · 돌파 복기 · 5m', name: '돌파 복기', timeframe: '5m',
      }],
      activeTabId: 'tab-ref',
    });
    addSecondChartWindow('D');

    renderPage('/study?view=view-ref');

    // 두 번째(비포커스) 창의 헤더에서 주봉으로 바꾼다.
    const headers = screen.getAllByTestId('study-chart-window-header');
    fireEvent.click(within(headers[1]).getByRole('button', { name: '주' }));

    // 창은 바뀌고,
    expect(useStudyWorkspaceStore.getState().windows.find((w) => w.id === 'w-chart-2')?.chart?.timeframe)
      .toBe('W');
    // 탭 라벨은 포커스 창의 봉 그대로다 — 안 만진 창이 라벨을 갈아치우면 안 된다.
    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '5m', label: '삼성전자 · 돌파 복기 · 5m',
    });
  });

  // #902 의 "탭을 오가면 포커스 창이 그 탭의 봉으로 재시드된다" 는 #1326 에서
  // **방향이 뒤집혔다** — 이제 탭이 창을 따라간다. 그 계약의 가드는 아래
  // '봉의 소유자는 차트 창이다' describe 에 있다.

  it('다른 차트 창으로 포커스를 옮겨도 그 창의 봉이 바뀌지 않는다', () => {
    useStudyTabsStore.setState({
      tabs: [{
        id: 'tab-ref', viewId: 'view-ref', code: '005930',
        label: '삼성전자 · 돌파 복기 · 5m', name: '돌파 복기', timeframe: '5m',
      }],
      activeTabId: 'tab-ref',
    });
    addSecondChartWindow('5m');

    renderPage('/study?view=view-ref');

    // 포커스 창(w-chart)을 일봉으로 → write-through 로 탭도 D 가 된다.
    const headers = screen.getAllByTestId('study-chart-window-header');
    fireEvent.click(within(headers[0]).getByRole('button', { name: '일' }));
    expect(useStudyTabsStore.getState().tabs[0].timeframe).toBe('D');

    // 다른 창으로 포커스만 옮긴다 — 봉은 아무것도 안 만졌다.
    act(() => { useStudyWorkspaceStore.getState().focusWindow('w-chart-2'); });

    // 재시드는 **탭 재활성** 전용이다. 포커스 이동에 걸리면 탭이 들고 있는 봉이
    // 옮겨간 창을 덮어써 "창을 클릭했을 뿐인데 봉이 바뀐다" 가 된다.
    expect(useStudyWorkspaceStore.getState().windows.find((w) => w.id === 'w-chart-2')?.chart?.timeframe)
      .toBe('5m');
    // 렌더도 그 창의 봉이어야 한다(스토어만 지키고 렌더가 새면 증상은 같다).
    const tfs = liveChartRootMock.mock.calls.slice(-2).map((c) => c[0].timeframe);
    expect(tfs).toContain('5m');
  });

  it('탭을 오갔다 돌아와도 두 창의 봉이 그대로다 — 멀티 타임프레임 배치 보존', () => {
    useStudyTabsStore.setState({
      tabs: [
        { id: 'tab-a', viewId: 'view-ref', code: '005930', label: 'A', name: 'A', timeframe: '5m' },
        { id: 'tab-b', viewId: 'view-second', code: '000660', label: 'B', name: 'B', timeframe: '5m' },
      ],
      activeTabId: 'tab-a',
    });
    addSecondChartWindow('D');

    renderPage('/study?view=view-ref');
    fireEvent.click(getStudyTab('B'));
    fireEvent.click(getStudyTab('A'));

    // 탭 전환은 어느 창의 봉도 바꾸지 않는다(#1326). 예전엔 포커스 창을 탭 봉으로
    // 재시드해서, 탭을 한 번 오갈 때마다 "일봉+5분봉으로 벌려 놨는데 둘 다 5분봉" 이 됐다.
    expect(useStudyWorkspaceStore.getState().windows.find((w) => w.id === 'w-chart-2')?.chart?.timeframe)
      .toBe('D');
  });

  /**
   * 봉의 소유자는 **차트 창**이고 저장뷰는 종목·구간만 정한다(#1326).
   *
   * **이 가드가 막는 방향**: 저장뷰를 열거나 탭을 오갔다는 이유로 차트 창의 봉이
   * 바뀌는 것. 반대 방향(#902 재시드)은 이 PR 에서 뒤집혔다 — 탭이 창을 따라간다.
   *
   * **이 가드가 못 보는 것**: 사용자가 창 헤더에서 직접 봉을 바꾸는 경로
   * (`changeTimeframe`)는 그대로다 — 제스처는 언제나 창을 이긴다(아래 마지막 케이스).
   *
   * **설정 의존 없음**: 이 계약은 이제 조건 없이 성립한다. 예전에는 「저장뷰 사이드
   * 메뉴 기본 분봉」 설정이 봉을 정했고, 그 설정 자체가 이 PR 에서 삭제됐다.
   */
  describe('봉의 소유자는 차트 창이다 (#1326)', () => {
    it('일봉 창 + 분봉 창 배치에서 다른 분봉 저장뷰를 열어도 두 창 다 그대로다', () => {
      // 사용자가 보고한 순서 그대로: 창 두 개(5m 포커스 + D)를 벌려 두고,
      // 어느 창의 봉과도 일치하지 않는 분봉(15m) 저장뷰를 연다. #1295 가 넣었던
      // 완화는 봉이 **정확히** 일치할 때만 걸려서 이 순서에서 포커스 창이 희생됐다.
      useStudyTabsStore.setState({
        tabs: [
          { id: 'tab-a', viewId: 'view-ref', code: '005930', label: 'A', name: 'A', timeframe: '5m' },
          { id: 'tab-b', viewId: 'view-second', code: '000660', label: 'B', name: 'B', timeframe: '15m' },
        ],
        activeTabId: 'tab-a',
      });
      addSecondChartWindow('D');

      renderPage('/study?view=view-ref');
      fireEvent.click(getStudyTab('B'));

      const state = useStudyWorkspaceStore.getState();
      const tfOf = (id: string) => state.windows.find((w) => w.id === id)?.chart?.timeframe;
      expect(tfOf('w-chart')).toBe('5m');
      expect(tfOf('w-chart-2')).toBe('D');
    });

    it('렌더도 창의 봉으로 나간다 — 저장 봉으로 유령 번들을 fetch 하지 않는다', () => {
      // 스토어만 지키고 렌더 경로(`chartWindowSpecs`)가 새면 화면은 멀쩡한데
      // 저장뷰를 열 때마다 엉뚱한 봉의 번들(수 MB)이 한 커밋 나간다.
      useStudyTabsStore.setState({
        tabs: [
          { id: 'tab-a', viewId: 'view-ref', code: '005930', label: 'A', name: 'A', timeframe: '5m' },
          { id: 'tab-b', viewId: 'view-second', code: '000660', label: 'B', name: 'B', timeframe: '15m' },
        ],
        activeTabId: 'tab-a',
      });
      addSecondChartWindow('D');

      renderPage('/study?view=view-ref');
      liveChartRootMock.mockClear();
      fireEvent.click(getStudyTab('B'));

      const rendered = new Set(liveChartRootMock.mock.calls.map((c) => c[0].timeframe));
      expect(rendered).toEqual(new Set(['5m', 'D']));
    });

    it('탭 라벨이 포커스 창의 봉을 따라간다 — 거울이 반대로 돈다', () => {
      // 창을 안 바꾸므로 탭 봉이 저장 봉으로 남으면 라벨(`… · 15m`)이 실제 창(5m)과
      // 어긋난 채 노출된다. #902 write-through 의 역방향.
      useStudyTabsStore.setState({
        tabs: [
          { id: 'tab-a', viewId: 'view-ref', code: '005930', label: 'A', name: 'A', timeframe: '5m' },
          { id: 'tab-b', viewId: 'view-second', code: '000660', label: 'B · 000660', name: 'B', timeframe: '15m' },
        ],
        activeTabId: 'tab-a',
      });

      renderPage('/study?view=view-ref');
      fireEvent.click(getStudyTab('B · 000660'));

      const tabB = useStudyTabsStore.getState().tabs.find((t) => t.id === 'tab-b');
      expect(tabB?.timeframe).toBe('5m');
      expect(tabB?.label).toContain('5m');
    });

    it('창 헤더로 직접 바꾸는 봉 전환은 그대로다 — 제스처는 창을 이긴다', () => {
      useStudyTabsStore.setState({
        tabs: [{
          id: 'tab-ref', viewId: 'view-ref', code: '005930',
          label: '삼성전자 · 돌파 복기 · 5m', name: '돌파 복기', timeframe: '5m',
        }],
        activeTabId: 'tab-ref',
      });

      renderPage('/study?view=view-ref');
      const headers = screen.getAllByTestId('study-chart-window-header');
      fireEvent.click(within(headers[0]).getByRole('button', { name: '일' }));

      expect(useStudyWorkspaceStore.getState().windows.find((w) => w.id === 'w-chart')?.chart?.timeframe)
        .toBe('D');
      expect(useStudyTabsStore.getState().tabs[0].timeframe).toBe('D');
    });
  });

  it('does not reuse a saved minute viewport after switching the study chart to D/W/M', () => {
    renderPage('/study?view=view-ref');

    // 캘린더 봉은 **저장 구간을 맥락 창 안에 앉히는 자체 뷰포트**를 쓴다. 이 테스트가
    // 막는 방향은 "분봉 저장 뷰포트(barSpan 120)가 캘린더로 새는 것" 이므로, null
    // 대신 그 값이 아님을 못박는다 — 값이 실린다는 사실만으로는 통과하지 않는다.
    const savedMinuteSpan = 120;

    fireEvent.click(screen.getByRole('button', { name: '일' }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({
      timeframe: 'D',
      restoreViewport: { atLiveEdge: false },
    });
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].restoreViewport.barSpan).not.toBe(savedMinuteSpan);

    fireEvent.click(screen.getByRole('button', { name: '주' }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].restoreViewport.barSpan).not.toBe(savedMinuteSpan);
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({ timeframe: 'W' });

    fireEvent.click(screen.getByRole('button', { name: '월' }));
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].restoreViewport.barSpan).not.toBe(savedMinuteSpan);
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({ timeframe: 'M' });

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
    // 레일 폐기(#760) 이후 /study 도 헤더에서 그리기를 연다 — 이 단언은 레일이
    // 있던 시절 "그리기는 헤더에 없다" 를 못박고 있었고, 이번에 의도적으로 뒤집혔다.
    expect(screen.getByTestId('drawing-menu-trigger')).toBeTruthy();

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
    // 로딩 구간에는 저장뷰 모델이 아직 없어 폴백이 답을 낸다. 그 폴백도 **창**을
    // 읽어야 한다(#1326) — 탭을 먼저 읽으면 되받아쓰기 전의 저장 봉이 지표
    // 버킷으로 샌다. 그래서 창을 D 로 세우고 D 가 나오는지 본다.
    setChartWindowTimeframe('D');
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
    setChartWindowTimeframe('15m');
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
    setChartWindowTimeframe('D');
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

    // 캡처 전에는 맥락 창 기본 뷰포트(저장 분봉 뷰포트가 아님)를 쓴다.
    expect(liveChartRootMock.mock.calls.at(-1)?.[0]).toMatchObject({ timeframe: 'D' });
    expect(liveChartRootMock.mock.calls.at(-1)?.[0].restoreViewport).not.toMatchObject({ barSpan: 120 });

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

    // venue 는 백엔드 필수(ADR-0140) — 복기는 KRX 고정이라 studyReferenceQueries
    // 의 /api/range 호출과 같은 값을 넘겨야 카드와 차트가 같은 시장을 본다.
    const spotArgs = { code: '005930', timeframe: '5m', venue: 'KRX' };
    expect(useLiveOrderbookAtCursorMock).toHaveBeenCalledWith(spotArgs);
    expect(useLiveBrokersAtCursorMock).toHaveBeenCalledWith(spotArgs);
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

  it('has no per-card drag handle or hide control (창 전환으로 카드 크롬 제거)', () => {
    renderPage('/study?view=view-ref');

    expect(screen.getByTestId('study-detail-content-orderbook')).toBeInTheDocument();
    expect(screen.queryByTestId('study-detail-drag-orderbook')).toBeNull();
    expect(screen.queryByTestId('study-detail-hide-orderbook')).toBeNull();
    expect(screen.queryByTestId('study-detail-restore')).toBeNull();
  });

  it('closes a data window from its frame and re-adds it from the add menu', () => {
    renderPage('/study?view=view-ref');

    const brokerFrame = screen.getByTestId('study-detail-card-brokers').closest('[data-win]') as HTMLElement;
    act(() => {
      within(brokerFrame).getByTitle('창 닫기').click();
    });
    expect(screen.queryByTestId('study-detail-card-brokers')).toBeNull();
    expect(useStudyWorkspaceStore.getState().windows.some((w) => w.kind === 'broker')).toBe(false);

    act(() => {
      screen.getByTestId('study-window-add').click();
    });
    act(() => {
      screen.getByTestId('study-add-broker').click();
    });
    expect(screen.getByTestId('study-detail-card-brokers')).toBeInTheDocument();
  });

  it('창 추가 메뉴는 툴바 밖(portal)에 뜬다 — 툴바가 클리핑 컨텍스트라', () => {
    // WorkspaceToolbar 는 `overflow-x-auto` 라 **양 축 모두** 클리핑한다(한 축이
    // visible 이 아니면 다른 축도 auto 로 계산). in-flow 팝오버는 툴바 높이 밖으로
    // 나가는 순간 통째로 잘려 메뉴가 아예 안 보였다. jsdom 은 레이아웃이 없어 "보인다"
    // 를 직접 볼 수 없으므로, 잘림을 구조적으로 불가능하게 하는 성질(툴바 밖에 있음)을
    // 못 박는다. 같은 툴바의 창 목록·프리셋 메뉴가 멀쩡했던 이유이기도 하다.
    renderPage('/study?view=view-ref');
    act(() => {
      screen.getByTestId('study-window-add').click();
    });

    const menu = screen.getByRole('menu', { name: '창 추가' });
    expect(screen.getByTestId('study-page-toolbar').contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('종목 식별(`이름 코드 · 복기뷰`)은 페이지 툴바가 아니라 차트 창 타이틀바에 있다', () => {
    // `/live` 가 종목 식별을 창 타이틀바에 두는 것과 같은 자리. 다른 단언들은
    // getByText 라 **어디에 있든** 통과하므로 위치를 여기서 못 박는다.
    renderPage('/study?view=view-ref');

    const chartFrame = screen.getByTestId('study-chart-card').closest('[data-win]') as HTMLElement;
    const symbolRow = within(chartFrame).getByTestId('study-titlebar-symbol-row');
    expect(symbolRow.textContent).toContain('삼성전자');
    expect(within(symbolRow).getByText('005930 · 복기뷰')).toBeTruthy();
    // 타이틀바(드래그 핸들 밴드) 안이어야 한다 — 컨트롤 행이면 접힘 임계(#905)가
    // 실측 파생값이라 라벨 폭만큼 통째로 어긋난다.
    expect(symbolRow.closest('[data-handle="move"]')).not.toBeNull();

    const toolbar = screen.getByTestId('study-page-toolbar');
    expect(toolbar.textContent).not.toContain('복기뷰');
    expect(toolbar.textContent).not.toContain('005930');
  });

  it('데이터 창 타이틀바는 종류 라벨을 유지한다 — 식별 행은 차트 창만', () => {
    renderPage('/study?view=view-ref');

    const bookFrame = screen.getByTestId('study-detail-card-orderbook').closest('[data-win]') as HTMLElement;
    expect(within(bookFrame).queryByTestId('study-titlebar-symbol-row')).toBeNull();
    expect(bookFrame.textContent).toContain('10호가');
  });

  it('does not offer a close control on the only chart window (차트 0개 금지)', () => {
    renderPage('/study?view=view-ref');

    const chartFrame = screen.getByTestId('study-chart-card').closest('[data-win]') as HTMLElement;
    expect(within(chartFrame).queryByTitle('창 닫기')).toBeNull();
  });

  it('toggles the memo window with the header memo button', () => {
    renderPage('/study?view=view-ref');

    expect(useStudyWorkspaceStore.getState().windows.some((w) => w.kind === 'memo')).toBe(false);
    act(() => {
      screen.getByRole('button', { name: '메모' }).click();
    });
    expect(useStudyWorkspaceStore.getState().windows.some((w) => w.kind === 'memo')).toBe(true);
    act(() => {
      screen.getByRole('button', { name: '메모' }).click();
    });
    expect(useStudyWorkspaceStore.getState().windows.some((w) => w.kind === 'memo')).toBe(false);
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
    expect(within(orderbookCard).getByText('커서 위치 불러오는 중…')).toBeTruthy();
    expect(within(orderbookCard).queryByText('호가 데이터 없음')).toBeNull();
  });

  it('keeps study cursor indicators visible while cursor remains set without relying on active callbacks', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue(undefined);
    useLiveBrokersAtCursorMock.mockReturnValue(undefined);
    useLiveCursorStore.getState().setSidebarCursor(HOVER_MS);

    renderPage('/study?view=view-ref');

    const orderbookCard = screen.getByTestId('study-detail-card-orderbook');
    const brokersCard = screen.getByTestId('study-detail-card-brokers');
    expect(within(orderbookCard).getByText('커서 위치 불러오는 중…')).toBeTruthy();
    expect(within(orderbookCard).queryByText('호가 데이터 없음')).toBeNull();
    expect(within(brokersCard).getByText('커서 위치 불러오는 중…')).toBeTruthy();
    expect(within(brokersCard).queryByText('거래원 정보 없음')).toBeNull();
  });

  it('renders each data surface inside its own workspace window frame', () => {
    renderPage('/study?view=view-ref');

    for (const key of ['orderbook', 'brokers', 'volume-distribution', 'program'] as const) {
      const section = screen.getByTestId(`study-detail-card-${key}`);
      expect(section.closest('[data-win]')).not.toBeNull();
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
    // hover-cutoff 를 켜는 곳은 전역 버킷이다 — 창(5m)이 minute 버킷을 편다(#904).
    useLivePageStore.getState().patchIndicatorsAt('5m', {
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

  it('lets long reference detail indicators scroll inside their own window', () => {
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

    // 창 모델: 스크롤은 패널 전체가 아니라 각 창 콘텐츠가 담당한다.
    for (const key of ['orderbook', 'volume-distribution', 'brokers', 'program']) {
      expect(screen.getByTestId(`study-detail-card-${key}`)).toHaveClass('overflow-y-auto');
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
    expect(screen.getByText('저장된 학습뷰를 선택하세요')).toBeTruthy();
  });

  /**
   * 번들 쿼리 키에는 지표 플래그가 실린다(`studyReferenceQuerySettings`). 창을
   * 분리하면 그 창의 요청도 갈려야 한다 — 안 그러면 차트는 히트맵을 그리려는데
   * 페이지가 받아온 번들에 그 데이터가 없어 **"켰는데 안 보임"** 이 된다.
   */
  it('분리된 창의 지표가 그 창의 번들 요청에 실린다', () => {
    useLivePageStore.getState().detachWindowIndicators('study:w-chart');
    useLivePageStore.getState().patchIndicatorsScoped('study:w-chart', '5m', {
      depthHeatmapEnabled: true,
    });

    renderPage('/study?view=view-ref');

    const chartSpec = capturedWindowSpecs.current.find((w) => w.windowId === 'w-chart');
    expect(chartSpec?.indicators.depthHeatmapEnabled).toBe(true);
    // 공용 세트는 그대로다 — 이 값이 공용에서 온 것이 아님을 못 박는다.
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.depthHeatmapEnabled)
      .toBeUndefined();
  });
});
