import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
  usePaneLegendRegistry.getState().register(null, paneId, entries);
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
  useMaSeriesRegistry.setState({ byScope: new Map() });
  useDailyMaSeriesRegistry.setState({ byScope: new Map() });
  usePaneLegendRegistry.setState({ byScope: new Map() });
}

describe('PaneLegendOverlay — candle MA row', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  it('renders the candle MA legend with the latest-fallback value when no cursor', () => {
    useMaSeriesRegistry.getState().register(null, 'ma-1', seriesWithValue(311400));
    renderOverlay();
    expect(screen.getByText('311,400')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // MA period (색 입힌 기간)
  });

  it('memo(P1): 같은 props 부모 재렌더(SSE 호가 틱)에는 series.data() 재호출 안 함; dataEpoch 변경(캔들 갱신)엔 재호출', () => {
    let dataCalls = 0;
    const spy = {
      data: () => {
        dataCalls += 1;
        return [{ time: 1, value: 100 }, { time: 2, value: 200 }];
      },
    } as never;
    useMaSeriesRegistry.getState().register(null, 'ma-1', spy);
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
    useMaSeriesRegistry.getState().register(null, 'ma-1', seriesWithValue(100));
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: '이동평균선 지표 끄기' }));
    expect(useLivePageStore.getState().movingAverageEnabled).toBe(false);
  });

  it('eye on the MA row toggles movingAverageHidden', () => {
    useMaSeriesRegistry.getState().register(null, 'ma-1', seriesWithValue(100));
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: '이동평균선 선 숨김/표시' }));
    expect(useLivePageStore.getState().movingAverageHidden).toBe(true);
  });
});

describe('PaneLegendOverlay — candle daily-MA row', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  const minutePanes = () => makeChart([120, 60, 60]);
  const toggles = { foreignNet: false, institutionNet: false } as PaneToggles;

  // 일봉 이동평균선(daily-MA)은 사용자 요청으로 레전드에서 숨긴다 — 분봉 차트에서
  // enabled + series 값이 있어도 레전드 값 표시 행은 뜨지 않는다. 차트의 일봉 MA 선
  // 자체는 dailyMaSeriesRegistry 가 계속 그리므로 여기 검증 범위 밖(선은 유지).
  it('never renders the daily-MA row in the legend even on a minute timeframe', () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      dailyMovingAverageEnabled: true,
      dailyMovingAverages: [
        { id: 'dma-1', enabled: true, period: 20, color: '#3485FA', lineWidth: 1, source: 'close' },
      ],
    });
    useDailyMaSeriesRegistry.getState().register(null, 'dma-1', seriesWithValue(70500));
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.queryByText('일봉 이동평균선')).toBeNull();
    // 값 셀·토글 버튼도 함께 사라진다.
    expect(screen.queryByRole('button', { name: '일봉 이동평균선 선 숨김/표시' })).toBeNull();
  });
});

// 지표 값 레전드 중 flag 행(최대벽·매물대·히트맵·단별잔량·신규거래원)과 거래량·총잔량
// 밖의 cells pane(호가비·체결강도·프로그램·투자자)은 오버레이에서 숨긴다(2026-07-22,
// 차트 밀집도). 거래량·총잔량 cells 행은 2026-08-04 에 되살렸다(아래 describe). 행 생성
// 로직은 legendRows.test.ts 가, flag 값 provider 스코프는 flagLegendValueRegistry.test.ts
// 가 계속 커버한다.
describe('PaneLegendOverlay — 지표 값 레전드 숨김(2026-07-22)', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  const minutePanes = () => makeChart([120, 60, 60, 60, 60, 60]);
  const toggles = { foreignNet: false, institutionNet: false } as PaneToggles;

  it('flag 지표를 켜도 값 행이 렌더되지 않는다(이동평균선은 유지)', () => {
    useMaSeriesRegistry.getState().register(null, 'ma-1', seriesWithValue(100));
    useLivePageStore.setState({
      askPeakEnabled: true,
      bidPeakEnabled: true,
      tradeVolumePocEnabled: true,
      depthHeatmapEnabled: true,
    });
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('이동평균선')).toBeInTheDocument();
    expect(screen.queryByText('당일 매도 최대벽')).toBeNull();
    expect(screen.queryByText('당일 매수 최대벽')).toBeNull();
    expect(screen.queryByText('당일 최대 매물대')).toBeNull();
    expect(screen.queryByText('호가 잔량 히트맵')).toBeNull();
  });

  it('신규 거래원 등장(broker-late-entry)도 숨긴다', () => {
    useLivePageStore.setState({ movingAverageEnabled: false, brokerLateEntryEnabled: true });
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.queryByText('신규 거래원 등장')).toBeNull();
  });

  it('flag provider 값도 표시되지 않는다', () => {
    useLivePageStore.setState({ askPeakEnabled: true });
    const provider: FlagLegendValueProvider = () => [{ key: 'ask-peak', value: '300,000, 12.3만' }];
    registerFlagLegendValues(null, 'ask-peak', provider);
    try {
      render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
      expect(screen.queryByText('300,000, 12.3만')).toBeNull();
    } finally {
      unregisterFlagLegendValues(null, 'ask-peak', provider);
    }
  });

  it('거래량·총잔량 밖의 cells pane(호가비·체결강도)은 등록돼 있어도 숨긴다', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('ratio', [{ label: '호가비', value: 1.23 }]);
    registerLegend('fill-strength', [
      { label: '매수', value: 777, color: () => '#F04452' },
      { label: '매도', value: 888, color: () => '#3485FA' },
    ]);
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.queryByText('호가비')).toBeNull();
    expect(screen.queryByText('체결강도')).toBeNull();
    expect(screen.queryByText('777')).toBeNull();
    expect(screen.queryByText('888')).toBeNull();
  });
});

// 거래량·총잔량 pane 은 다른 지표(캔들 OHLC·이동평균선)처럼 값 레전드를 갖는다
// (2026-08-04 사용자 요청). `/live` 와 `/study` 가 같은 LiveChartRoot 를 쓰므로
// 이 게이트 하나가 두 화면을 동시에 덮는다.
describe('PaneLegendOverlay — 거래량·총잔량 cells 행 표시(2026-08-04)', () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  const minutePanes = () => makeChart([120, 60, 60, 60, 60, 60]);
  const toggles = { foreignNet: false, institutionNet: false } as PaneToggles;

  it('거래량 pane 의 값 행을 렌더한다(라벨 + 최신값 폴백)', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('volume', [
      { label: '거래량', value: 5000 },
      { label: '누적', value: 12345, color: () => '#8B5CF6' },
    ]);
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('거래량')).toBeInTheDocument();
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.getByText('누적')).toBeInTheDocument();
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });

  it('총잔량 pane 은 spec 의 legendTitle 과 매수·매도 셀을 렌더한다', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('quote-totals', [
      { label: '매수', value: 311400, color: () => '#F04452' },
      { label: '매도', value: 6789, color: () => '#3485FA' },
    ]);
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('총잔량')).toBeInTheDocument();
    expect(screen.getByText('311,400')).toBeInTheDocument();
    expect(screen.getByText('6,789')).toBeInTheDocument();
  });

  // 값이 null 인 셀(토글 off / 콜드로드)은 빠지고, 남는 셀이 없으면 행 자체가 사라진다
  // — buildLegendRows 의 범용 규칙(legendRows.ts)이 여기서도 그대로 성립한다.
  it('값 없는 셀은 빠지고, 전부 비면 행이 사라진다', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('volume', [
      { label: '거래량', value: 5000 },
      { label: '누적', value: null },
    ]);
    registerLegend('quote-totals', [
      { label: '매수', value: null },
      { label: '매도', value: null },
    ]);
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('5,000')).toBeInTheDocument();
    expect(screen.queryByText('누적')).toBeNull();
    expect(screen.queryByText('총잔량')).toBeNull();
  });

  it('✕ 는 해당 pane 지표를 현재 타임프레임에서 끈다', () => {
    // 최상위 volumeEnabled 는 indicatorTimeframe 으로 resolve 된 값이라(livePage.ts
    // §IndicatorSettings), 분봉 버킷에 쓴 결과가 최상위에 반영되려면 둘이 같은
    // 프로파일이어야 한다.
    useLivePageStore.setState({
      movingAverageEnabled: false,
      indicatorTimeframe: '1m',
      volumeEnabled: true,
    });
    registerLegend('volume', [{ label: '거래량', value: 5000 }]);
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    fireEvent.click(screen.getByRole('button', { name: '거래량 지표 끄기' }));
    expect(useLivePageStore.getState().volumeEnabled).toBe(false);
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
