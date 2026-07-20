import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaneLegendOverlay from './PaneLegendOverlay';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './indicators/dailyMaSeriesRegistry';
import {
  registerFlagLegendValues,
  unregisterFlagLegendValues,
  type FlagLegendValueProvider,
} from './indicators/flagLegendValueRegistry';
import {
  usePaneLegendRegistry,
  type LegendSeriesEntry,
} from './indicators/paneLegendRegistry';
import type { PaneId } from '../chart/drawing/types';
import type { PaneToggles } from './paneSpecsForTimeframe';

// Minimal chart stub: the overlay only reads pane heights for positioning and
// (un)subscribes to crosshair / range — no live chart needed. Latest-fallback
// value path (cursor absent) reads `series.data()`, stubbed per series.
const noop = () => {};
function makeChart(paneHeights: number[]) {
  return {
    subscribeCrosshairMove: noop,
    unsubscribeCrosshairMove: noop,
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: noop,
      unsubscribeVisibleLogicalRangeChange: noop,
    }),
    panes: () => paneHeights.map((h) => ({ getHeight: () => h })),
  } as never;
}

const seriesWithValue = (value: number) =>
  ({ data: () => [{ time: 1, value: value - 1 }, { time: 2, value }] }) as never;

/** Register a pane's legend entries (mirrors what RangeSeriesPane fires). */
function registerLegend(
  paneId: PaneId,
  cells: { label: string; value: number | null; color?: () => string; format?: (v: number) => string }[],
) {
  const entries: LegendSeriesEntry[] = cells.map((c) => ({
    series: c.value === null ? ({ data: () => [] } as never) : seriesWithValue(c.value),
    meta: { label: c.label, color: c.color, format: c.format },
  }));
  usePaneLegendRegistry.getState().register(paneId, entries);
}

function renderOverlay({
  timeframe = 'D' as LiveTimeframe,
  paneToggles = { foreignNet: false, institutionNet: false, volumeEnabled: false } as PaneToggles,
  chart = makeChart([120]),
} = {}) {
  return render(
    <PaneLegendOverlay chart={chart} timeframe={timeframe} paneToggles={paneToggles} />,
  );
}

function resetStore() {
  useLivePageStore.setState({
    candleTimeframe: 'D',
    movingAverages: [
      { id: 'ma-1', enabled: true, period: 5, color: '#EC4899', lineWidth: 1, source: 'close' },
    ],
    movingAverageEnabled: true,
    movingAverageHidden: false,
    dailyMovingAverageEnabled: false,
    dailyMovingAverageHidden: false,
    askPeakEnabled: false,
    askPeakHidden: false,
    bidPeakEnabled: false,
    bidPeakHidden: false,
    tradeVolumePocEnabled: false,
    tradeVolumePocHidden: false,
    depthHeatmapEnabled: false,
    depthHeatmapHidden: false,
    brokerLateEntryEnabled: false,
    brokerLateEntryHidden: false,
    brokerLateEntrySideMode: 'both',
    volumeEnabled: false,
    foreignNetEnabled: false,
    institutionNetEnabled: false,
  });
  useMaSeriesRegistry.setState({ series: new Map() });
  useDailyMaSeriesRegistry.setState({ series: new Map() });
  usePaneLegendRegistry.setState({ panes: new Map() });
}

describe('PaneLegendOverlay — candle MA row', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  it('renders the candle MA legend with the latest-fallback value when no cursor', () => {
    useMaSeriesRegistry.getState().register('ma-1', seriesWithValue(311400));
    renderOverlay();
    expect(screen.getByText('311,400')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // MA period swatch label
  });

  it('memo(P1): 같은 props 부모 재렌더(SSE 호가 틱)에는 series.data() 재호출 안 함; dataEpoch 변경(캔들 갱신)엔 재호출', () => {
    let dataCalls = 0;
    const spy = {
      data: () => {
        dataCalls += 1;
        return [{ time: 1, value: 100 }, { time: 2, value: 200 }];
      },
    } as never;
    useMaSeriesRegistry.getState().register('ma-1', spy);
    const chart = makeChart([120]);
    const paneToggles = { foreignNet: false, institutionNet: false, volumeEnabled: false };
    const { rerender } = render(
      <PaneLegendOverlay chart={chart} timeframe="D" paneToggles={paneToggles} dataEpoch={1} />,
    );
    const afterFirst = dataCalls;
    expect(afterFirst).toBeGreaterThan(0);
    // SSE 호가 틱 = 부모 재렌더, props 동일 → memo가 차단 → data() 추가 호출 없음
    rerender(
      <PaneLegendOverlay chart={chart} timeframe="D" paneToggles={paneToggles} dataEpoch={1} />,
    );
    expect(dataCalls).toBe(afterFirst);
    // 캔들 갱신 = dataEpoch 증가 → 재렌더 → latest 값 신선화(data() 재호출)
    rerender(
      <PaneLegendOverlay chart={chart} timeframe="D" paneToggles={paneToggles} dataEpoch={2} />,
    );
    expect(dataCalls).toBeGreaterThan(afterFirst);
  });

  it('✕ on the MA row turns the moving-average master off', () => {
    useMaSeriesRegistry.getState().register('ma-1', seriesWithValue(100));
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: '이동평균선 지표 끄기' }));
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
  });

  it('eye on the MA row toggles movingAverageHidden', () => {
    useMaSeriesRegistry.getState().register('ma-1', seriesWithValue(100));
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: '이동평균선 선 숨김/표시' }));
    expect(useLivePageStore.getState().movingAverageHidden).toBe(true);
  });
});

describe('PaneLegendOverlay — candle-pane indicator rows', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  const minutePanes = () => makeChart([120, 60, 60]);
  const toggles = { foreignNet: false, institutionNet: false } as PaneToggles;

  it('renders the daily-MA row with the latest-fallback value on a minute timeframe', () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      dailyMovingAverageEnabled: true,
      dailyMovingAverages: [
        { id: 'dma-1', enabled: true, period: 20, color: '#3485FA', lineWidth: 1, source: 'close' },
      ],
    });
    useDailyMaSeriesRegistry.getState().register('dma-1', seriesWithValue(70500));
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('일봉 이동평균선')).toBeInTheDocument();
    expect(screen.getByText('70,500')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('hides the daily-MA row on D even when enabled (minute-only overlay)', () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      dailyMovingAverageEnabled: true,
      dailyMovingAverages: [
        { id: 'dma-1', enabled: true, period: 20, color: '#3485FA', lineWidth: 1, source: 'close' },
      ],
    });
    renderOverlay({ timeframe: 'D' });
    expect(screen.queryByText('일봉 이동평균선')).toBeNull();
  });

  it('daily-MA row: eye toggles hidden, ✕ turns the master off', () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      dailyMovingAverageEnabled: true,
      dailyMovingAverages: [
        { id: 'dma-1', enabled: true, period: 20, color: '#3485FA', lineWidth: 1, source: 'close' },
      ],
    });
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    fireEvent.click(screen.getByRole('button', { name: '일봉 이동평균선 선 숨김/표시' }));
    expect(useLivePageStore.getState().dailyMovingAverageHidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '일봉 이동평균선 지표 끄기' }));
    expect(useLivePageStore.getState().dailyMovingAverageEnabled).toBe(false);
  });

  it('renders enabled flag rows on a minute timeframe and stacks them with the MA row', () => {
    useMaSeriesRegistry.getState().register('ma-1', seriesWithValue(100));
    useLivePageStore.setState({
      askPeakEnabled: true,
      bidPeakEnabled: true,
      tradeVolumePocEnabled: true,
      depthHeatmapEnabled: true,
    });
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('이동평균선')).toBeInTheDocument();
    expect(screen.getByText('당일 매도 최대벽')).toBeInTheDocument();
    expect(screen.getByText('당일 매수 최대벽')).toBeInTheDocument();
    expect(screen.getByText('당일 최대 매물대')).toBeInTheDocument();
    expect(screen.getByText('호가 잔량 히트맵')).toBeInTheDocument();
  });

  it('단별 잔량 증감: 데이터가 있을 때만 행이 렌더된다', () => {
    useLivePageStore.setState({ depthDeltaEnabled: true });
    // 오늘 SSE 가 유일한 소스 — /study·과거일 전용 뷰에서는 켜져 있어도 그릴 게 없다.
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.queryByText('단별 잔량 증감')).toBeNull();

    render(
      <PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} hasDepthDelta />,
    );
    expect(screen.getAllByText('단별 잔량 증감').length).toBeGreaterThan(0);
  });

  it('단별 잔량 증감: ✕ 는 끄고, 눈은 숨김만 토글한다', () => {
    useLivePageStore.setState({ depthDeltaEnabled: true });
    render(
      <PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} hasDepthDelta />,
    );
    fireEvent.click(screen.getByRole('button', { name: '단별 잔량 증감 표시 숨김/표시' }));
    expect(useLivePageStore.getState().depthDeltaHidden).toBe(true);
    expect(screen.getByText('단별 잔량 증감')).toBeInTheDocument(); // 숨김은 그리기만

    fireEvent.click(screen.getByRole('button', { name: '단별 잔량 증감 지표 끄기' }));
    expect(useLivePageStore.getState().depthDeltaEnabled).toBe(false);
  });

  it('단별 잔량 증감: D 봉에서는 데이터가 있어도 행이 없다', () => {
    useLivePageStore.setState({ depthDeltaEnabled: true });
    render(
      <PaneLegendOverlay chart={minutePanes()} timeframe="D" paneToggles={toggles} hasDepthDelta />,
    );
    expect(screen.queryByText('단별 잔량 증감')).toBeNull();
  });

  it('renders no flag rows on D/W/M (minute-only overlays)', () => {
    useLivePageStore.setState({ askPeakEnabled: true, depthHeatmapEnabled: true });
    renderOverlay({ timeframe: 'D' });
    expect(screen.queryByText('당일 매도 최대벽')).toBeNull();
    expect(screen.queryByText('호가 잔량 히트맵')).toBeNull();
  });

  it('✕ on a flag row turns that indicator off in the store', () => {
    useLivePageStore.setState({ askPeakEnabled: true, depthHeatmapEnabled: true });
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽 지표 끄기' }));
    expect(useLivePageStore.getState().askPeakEnabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '호가 잔량 히트맵 지표 끄기' }));
    expect(useLivePageStore.getState().depthHeatmapEnabled).toBe(false);
  });

  it('eye on a flag row toggles its hidden store flag (row stays rendered)', () => {
    useLivePageStore.setState({ askPeakEnabled: true });
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    fireEvent.click(screen.getByRole('button', { name: '당일 매도 최대벽 표시 숨김/표시' }));
    expect(useLivePageStore.getState().askPeakHidden).toBe(true);
    // 눈은 그리기만 숨긴다 — 레전드 행은 그대로.
    expect(screen.getByText('당일 매도 최대벽')).toBeInTheDocument();
  });

  it('renders provider value cells on a flag row (latest fallback, cursor away)', () => {
    useLivePageStore.setState({ askPeakEnabled: true });
    const provider: FlagLegendValueProvider = (cursorTimeSec) =>
      cursorTimeSec === null ? [{ key: 'ask-peak', value: '300,000, 12.3만' }] : [];
    registerFlagLegendValues('ask-peak', provider);
    try {
      render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
      expect(screen.getByText('300,000, 12.3만')).toBeInTheDocument();
    } finally {
      unregisterFlagLegendValues('ask-peak', provider);
    }
  });

  it('renders labeled/colored provider cells (히트맵 매수/매도)', () => {
    useLivePageStore.setState({ depthHeatmapEnabled: true });
    const provider: FlagLegendValueProvider = () => [
      { key: 'dh-bid', label: '매수', color: '#F04452', value: '299,000, 30만' },
      { key: 'dh-ask', label: '매도', color: '#3485FA', value: '300,000, 12만' },
    ];
    registerFlagLegendValues('depth-heatmap', provider);
    try {
      render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
      expect(screen.getByText('호가 잔량 히트맵')).toBeInTheDocument();
      expect(screen.getByText('299,000, 30만')).toBeInTheDocument();
      expect(screen.getByText('300,000, 12만')).toBeInTheDocument();
      expect(screen.getByText('매수')).toBeInTheDocument();
      expect(screen.getByText('매도')).toBeInTheDocument();
    } finally {
      unregisterFlagLegendValues('depth-heatmap', provider);
    }
  });

  it('renders the 거래원 등장 flag on the ratio pane when mounted, and ✕ turns it off', () => {
    useLivePageStore.setState({ movingAverageEnabled: false, brokerLateEntryEnabled: true });
    // '1m' pane order: candle volume quote-totals ratio fill-strength …
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60, 60, 60, 60, 60])}
        timeframe="1m"
        paneToggles={toggles}
      />,
    );
    expect(screen.getByText('신규 거래원 등장')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '신규 거래원 등장 지표 끄기' }));
    expect(useLivePageStore.getState().brokerLateEntryEnabled).toBe(false);
  });

  it('hides the 거래원 등장 flag when the ratio pane is unmounted (호가비 off)', () => {
    useLivePageStore.setState({ movingAverageEnabled: false, brokerLateEntryEnabled: true });
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60, 60, 60, 60])}
        timeframe="1m"
        paneToggles={{ ...toggles, ratioEnabled: false } as PaneToggles}
      />,
    );
    expect(screen.queryByText('신규 거래원 등장')).toBeNull();
  });

  it('hides the 거래원 등장 flag on D (분봉 전용)', () => {
    useLivePageStore.setState({ movingAverageEnabled: false, brokerLateEntryEnabled: true });
    renderOverlay({ timeframe: 'D', chart: makeChart([120, 60]) });
    expect(screen.queryByText('신규 거래원 등장')).toBeNull();
  });
});

describe('PaneLegendOverlay — generic pane rows', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  it('renders a multi-cell hoga pane (총잔량 매수/매도) and ✕ turns it off', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('quote-totals', [
      { label: '매수', value: 311400, color: () => '#F04452' },
      { label: '매도', value: 6789, color: () => '#3485FA' },
    ]);
    // 1m mounts candle(0) volume(1) quote-totals(2) ... — place quote-totals at idx 2.
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60, 60])}
        timeframe="1m"
        paneToggles={{ foreignNet: false, institutionNet: false }}
      />,
    );
    expect(screen.getByText('총잔량')).toBeInTheDocument();
    expect(screen.getByText('매수')).toBeInTheDocument();
    expect(screen.getByText('311,400')).toBeInTheDocument();
    expect(screen.getByText('매도')).toBeInTheDocument();
    expect(screen.getByText('6,789')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '총잔량 지표 끄기' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.minute?.quoteTotalsEnabled).toBe(false);
  });

  it('omits a null-valued cell (체결강도 누적 off) but keeps the rest', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('fill-strength', [
      { label: '매수', value: 10 },
      { label: '매도', value: 20 },
      { label: '누적', value: null }, // cumulative toggle off → empty series → omitted
    ]);
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60, 60, 60, 60])}
        timeframe="1m"
        paneToggles={{ foreignNet: false, institutionNet: false }}
      />,
    );
    expect(screen.getByText('체결강도')).toBeInTheDocument();
    expect(screen.getByText('매수')).toBeInTheDocument();
    expect(screen.getByText('매도')).toBeInTheDocument();
    expect(screen.queryByText('누적')).toBeNull();
  });

  it('renders the volume row from the registry and ✕ writes the active timeframe profile', () => {
    useLivePageStore.setState({ volumeEnabled: true, movingAverageEnabled: false });
    registerLegend('volume', [{ label: '거래량', value: 5000 }]);
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60])}
        timeframe="D"
        paneToggles={{ foreignNet: false, institutionNet: false, volumeEnabled: true }}
      />,
    );
    expect(screen.getByText('5,000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '거래량 지표 끄기' }));
    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('renders no investor row on a weekly timeframe even with registry entries', () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      foreignNetEnabled: true,
      institutionNetEnabled: true,
    });
    registerLegend('investor-foreign', [{ label: '외국인 순매수량', value: 100 }]);
    registerLegend('investor-institution', [{ label: '기관 순매수량', value: -100 }]);
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60])}
        timeframe="W"
        paneToggles={{ foreignNet: true, institutionNet: true, volumeEnabled: false }}
      />,
    );
    // Investor panes are D-only → absent from the W spec order → no placement.
    expect(screen.queryByText('외국인 순매수량')).toBeNull();
    expect(screen.queryByText('기관 순매수량')).toBeNull();
  });

  it('foreign close writes D profile investor toggle', async () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      foreignNetEnabled: true,
      indicatorsByTimeframe: { D: { foreignNetEnabled: true } },
    });
    registerLegend('investor-foreign', [{ label: '외국인 순매수량', value: 100 }]);
    renderOverlay({
      timeframe: 'D',
      chart: makeChart([120, 60]),
      paneToggles: { foreignNet: true, institutionNet: false, volumeEnabled: false },
    });

    await userEvent.click(screen.getByLabelText('외국인 순매수량 지표 끄기'));

    expect(useLivePageStore.getState().indicatorsByTimeframe.D?.foreignNetEnabled).toBe(false);
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });
});

describe('PaneLegendOverlay — pane reorder controls (ADR-0114)', () => {
  const CANON: PaneId[] = [
    'candle', 'volume', 'quote-totals', 'ratio',
    'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
  ];
  const toggles = { foreignNet: false, institutionNet: false } as PaneToggles;
  // 분봉 전체 pane(candle, volume, quote-totals, ratio, fill-strength, program-trade).
  const sixPaneChart = () => makeChart([100, 100, 100, 100, 100, 100]);

  beforeEach(() => {
    resetStore();
    useLivePageStore.setState({ candleTimeframe: '1m', volumeEnabled: true, paneOrder: [...CANON] });
  });
  afterEach(cleanup);

  it('renders ↑/↓ controls on non-candle panes and none on candle', () => {
    render(<PaneLegendOverlay chart={sixPaneChart()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.queryByTestId('pane-move-up-candle')).toBeNull();
    expect(screen.queryByTestId('pane-move-down-candle')).toBeNull();
    expect(screen.getByTestId('pane-move-up-volume')).toBeInTheDocument();
    expect(screen.getByTestId('pane-move-down-volume')).toBeInTheDocument();
    expect(screen.getByTestId('pane-move-up-program-trade')).toBeInTheDocument();
  });

  it('disables ↑ on the first non-candle pane and ↓ on the last pane', () => {
    render(<PaneLegendOverlay chart={sixPaneChart()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByTestId('pane-move-up-volume')).toBeDisabled();
    expect(screen.getByTestId('pane-move-down-program-trade')).toBeDisabled();
    // 중간 pane(ratio)은 양쪽 다 활성.
    expect(screen.getByTestId('pane-move-up-ratio')).not.toBeDisabled();
    expect(screen.getByTestId('pane-move-down-ratio')).not.toBeDisabled();
  });

  it('dispatches swapPaneOrder with the mounted up-neighbor on ↑ click', () => {
    render(<PaneLegendOverlay chart={sixPaneChart()} timeframe="1m" paneToggles={toggles} />);
    // ratio(idx3) ↑ → 마운트된 위 이웃 quote-totals(idx2)와 스왑.
    fireEvent.click(screen.getByTestId('pane-move-up-ratio'));
    const order = useLivePageStore.getState().paneOrder;
    expect(order.indexOf('ratio')).toBeLessThan(order.indexOf('quote-totals'));
  });

  it('swaps mounted neighbors across a gated-absent pane (investor absent on minute)', () => {
    // 분봉에서 investor 는 게이트로 부재 — 마운트된 program-trade(idx5) ↑ 는
    // 마운트 이웃 fill-strength(idx4)와 스왑하고, 전체 순서에서 investor 슬롯은 불변.
    render(<PaneLegendOverlay chart={sixPaneChart()} timeframe="1m" paneToggles={toggles} />);
    fireEvent.click(screen.getByTestId('pane-move-up-program-trade'));
    const order = useLivePageStore.getState().paneOrder;
    expect(order.indexOf('program-trade')).toBeLessThan(order.indexOf('fill-strength'));
    // investor 두 pane 은 여전히 순서 끝에 canonical 위치.
    expect(order.slice(-2)).toEqual(['investor-foreign', 'investor-institution']);
  });
});
