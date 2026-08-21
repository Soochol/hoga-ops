import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import PaneLegendOverlay from './PaneLegendOverlay';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useLiveCursorStore } from './useLiveCursorStore';
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
import { formatKoreanWonEok } from '../util/koreanNumber';

// Minimal chart stub: the overlay only reads pane heights for positioning and
// (un)subscribes to crosshair / range — no live chart needed. Latest-fallback
// value path (cursor absent) reads `series.data()`, stubbed per series.
const noop = () => {};
function makeChart(paneHeights: number[], plotWidth = 500) {
  return {
    subscribeCrosshairMove: noop,
    unsubscribeCrosshairMove: noop,
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: noop,
      unsubscribeVisibleLogicalRangeChange: noop,
      // pane 플롯 폭(우측 가격축 거터 제외). 오버레이가 pane 이동 컨트롤을 **플롯**
      // 우측에 붙일 때 쓴다 — 0 이면 클램프 폴백 경로.
      width: () => plotWidth,
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

/**
 * **동기화로 그려진 크로스헤어를 레전드가 따라간다**(2026-08-21).
 *
 * lwc 는 `setCrosshairPosition` 으로 그린 크로스헤어에 대해 `subscribeCrosshairMove`
 * 를 발화시키지 않는다. 그래서 이 창의 `param.time` 은 비어 있고, 그 상태에서 폴백만
 * 있으면 레전드가 **항상 최신 봉**을 보여준다 — 선은 옆 창과 같은 자리인데 숫자만
 * 달라 "다른 차트" 로 읽힌다(실측: 종가 260,500 vs 281,500).
 *
 * **이 테스트가 막는 방향**: 동기화 대상이 있는데도 최신 봉으로 떨어지는 것.
 * **못 보는 것**: 내 마우스가 올라가 있을 때의 우선순위(그건 `param.time` 경로라
 * 종전대로 1순위다 — 아래 마지막 케이스가 그 순서를 고정한다).
 */
describe('PaneLegendOverlay — 동기화 크로스헤어 연동', () => {
  const DAY1 = Date.UTC(2025, 5, 18, 0, 0);
  const DAY2 = Date.UTC(2025, 5, 19, 0, 0);
  const DAY3 = Date.UTC(2025, 5, 20, 0, 0);
  const CANDLES = [
    { ts_ms: DAY1, open: 100, high: 110, low: 90, close: 105, vol_a: 1, vol_b: 0 },
    { ts_ms: DAY2, open: 105, high: 130, low: 100, close: 120, vol_a: 1, vol_b: 0 },
    { ts_ms: DAY3, open: 120, high: 140, low: 115, close: 135, vol_a: 1, vol_b: 0 },
  ];
  /** 항등 축 — 가상초 = ms/1000. */
  const axis = {
    contains: () => true,
    toVirtual: (ms: number) => ms,
  } as never;

  const publish = (tsMs: number) => act(() => {
    useLiveCursorStore.getState().setSyncCursor(tsMs, {
      windowId: 'other-window', group: null, code: '005930', timeframe: '1m',
    });
  });

  /** 크로스헤어 핸들러를 붙잡는 차트 — 「내 마우스」 경로를 재려면 필요하다. */
  let crosshairHandler: ((p: { time?: unknown; point?: unknown }) => void) | null = null;
  const capturingChart = () => ({
    subscribeCrosshairMove: (h: (p: { time?: unknown; point?: unknown }) => void) => {
      crosshairHandler = h;
    },
    unsubscribeCrosshairMove: () => { crosshairHandler = null; },
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
      width: () => 500,
    }),
    panes: () => [{ getHeight: () => 120 }],
  }) as never;

  const renderWithCandles = () => render(
    <PaneLegendOverlay
      chart={makeChart([120])}
      timeframe="D"
      paneToggles={{ foreignNet: false, institutionNet: false, volumeEnabled: false }}
      candles={CANDLES}
      axis={axis}
      code="005930"
    />,
  );

  beforeEach(() => { useLiveCursorStore.getState().resetCursor(); });

  /** OHLC 행의 「시작」 값만 읽는다 — 봉마다 값이 갈려 판별식으로 충분하고,
   *  `getByText` 로 숫자를 찾으면 다른 행의 같은 숫자와 섞인다. */
  const openText = (c: HTMLElement) =>
    c.querySelector('.legend-ohlc-open')?.textContent ?? '';

  it('동기화 발행이 없으면 최신 봉을 읽는다 — 종전 폴백', () => {
    const { container } = renderWithCandles();
    expect(openText(container)).toContain('120'); // DAY3 시가
  });

  it('동기화 대상이 있으면 **그 봉**을 읽는다 — 최신 봉이 아니라', () => {
    const { container } = renderWithCandles();
    publish(DAY2 + 6 * 3600_000); // 그 날 낮 — 날짜로 DAY2 에 스냅된다

    expect(openText(container)).toContain('105'); // DAY2 시가
    expect(openText(container)).not.toContain('120');
  });

  it('⚠ 내 마우스가 1순위 — 동기화 대상이 있어도 내 호버가 이긴다', async () => {
    // 이 케이스가 없으면 우선순위를 뒤집어도(동기화가 내 마우스를 이기도록) 테스트가
    // 전부 초록이다 — red-check 으로 실제 확인한 구멍이다.
    const { container } = render(
      <PaneLegendOverlay
        chart={capturingChart()}
        timeframe="D"
        paneToggles={{ foreignNet: false, institutionNet: false, volumeEnabled: false }}
        candles={CANDLES}
        axis={axis}
        code="005930"
      />,
    );
    publish(DAY2 + 6 * 3600_000); // 동기화 대상은 DAY2
    // ⚠ `point` 가 없으면 구현이 param 을 **버린다**(커서가 차트 밖이라는 뜻).
    //   그리고 갱신은 rAF 로 미뤄지므로 한 프레임을 흘려야 한다.
    act(() => { crosshairHandler?.({ time: DAY1 / 1000, point: { x: 10, y: 10 } }); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

    expect(openText(container)).toContain('100'); // DAY1 시가 — 내 마우스가 이긴다
  });

  it('창번호가 다르면 따라가지 않는다 — 게이트는 크로스헤어와 같은 판정을 쓴다', () => {
    const { container } = renderWithCandles();
    act(() => {
      useLiveCursorStore.getState().setSyncCursor(DAY2 + 6 * 3600_000, {
        windowId: 'other-window', group: 7, code: '005930', timeframe: '1m',
      });
    });

    // Provider 밖이라 내 group 은 null — 7 과 다르므로 막힌다 → 최신 봉.
    expect(openText(container)).toContain('120');
  });
});

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

// 지표 값 레전드 중 flag 행(최대벽·매물대·히트맵·단별잔량·신규거래원)과 화이트리스트
// 밖의 cells pane(호가비·체결강도·투자자)은 오버레이에서 숨긴다(2026-07-22, 차트
// 밀집도). 거래량·총잔량은 2026-08-04 에, 프로그램 순매수는 2026-08-18 에 되살렸다
// (아래 describe). 행 생성 로직은 legendRows.test.ts 가, flag 값 provider 스코프는
// flagLegendValueRegistry.test.ts 가 계속 커버한다.
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

// 거래량·총잔량·프로그램 순매수 pane 은 다른 지표(캔들 OHLC·이동평균선)처럼 값
// 레전드를 갖는다(2026-08-04 · 2026-08-18 사용자 요청). `/live` 와 `/study` 가 같은
// LiveChartRoot 를 쓰므로 이 게이트 하나가 두 화면을 동시에 덮는다.
describe('PaneLegendOverlay — 화이트리스트 cells 행 표시(2026-08-04 · 08-18)', () => {
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

  // 2026-08-18. 이 행이 생기면서 프로그램 pane 의 `lastValueVisible`(가격축 최신값
  // 칩)을 껐다 — 두 판독면은 갱신 주기가 달라 같이 켜면 한 시리즈가 두 숫자로 보인다.
  // 그 짝은 projector 쪽 옵션이라 여기서 못 재고, programTrade.test.ts 가 맡는다.
  it('프로그램 순매수 pane 의 값 행을 렌더한다(억 단위 포맷)', () => {
    useLivePageStore.setState({ movingAverageEnabled: false });
    registerLegend('program-trade', [
      { label: '프로그램 순매수', value: 512_800_000_000, format: formatKoreanWonEok },
    ]);
    render(<PaneLegendOverlay chart={minutePanes()} timeframe="1m" paneToggles={toggles} />);
    expect(screen.getByText('프로그램 순매수')).toBeInTheDocument();
    expect(screen.getByText(formatKoreanWonEok(512_800_000_000))).toBeInTheDocument();
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

  it('이동 버튼 aria-label 이 한글 pane 이름을 쓴다 (영문 paneId 아님)', () => {
    render(<PaneLegendOverlay chart={sixPaneChart()} timeframe="1m" paneToggles={toggles} />);
    // `spec.legendTitle` 은 셀 앞 제목 접두사라 대부분의 pane 에 일부러 없다 — 그걸
    // 이름으로 쓰면 정의된 2개(총잔량·체결강도)만 한글이고 나머지는 `volume pane 위로
    // 이동` 처럼 영문 paneId 로 샌다.
    expect(screen.getByTestId('pane-move-up-volume')).toHaveAttribute(
      'aria-label', '거래량 pane 위로 이동',
    );
    expect(screen.getByTestId('pane-move-down-ratio')).toHaveAttribute(
      'aria-label', '호가비 pane 아래로 이동',
    );
    expect(screen.getByTestId('pane-move-up-program-trade')).toHaveAttribute(
      'aria-label', '프로그램 순매수 pane 위로 이동',
    );
    // legendTitle 이 있는 pane 도 같은 출처를 쓴다(값이 우연히 같아도 경로는 하나).
    expect(screen.getByTestId('pane-move-up-quote-totals')).toHaveAttribute(
      'aria-label', '총잔량 pane 위로 이동',
    );
  });

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

describe('PaneLegendOverlay — 이동 컨트롤 배치 (legend 와 같은 줄 · pane 우측)', () => {
  const CANON: PaneId[] = [
    'candle', 'volume', 'quote-totals', 'ratio',
    'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
  ];
  const toggles = { foreignNet: false, institutionNet: false } as PaneToggles;
  const PLOT_WIDTH = 500;

  beforeEach(() => {
    resetStore();
    useLivePageStore.setState({ candleTimeframe: '1m', volumeEnabled: true, paneOrder: [...CANON] });
  });
  afterEach(cleanup);

  /** ↑버튼 → 컨트롤 칩(span) → pane 래퍼. */
  const chipOf = (paneId: string) => screen.getByTestId(`pane-move-up-${paneId}`).parentElement!;
  const wrapperOf = (paneId: string) => chipOf(paneId).parentElement!;

  function renderPanes(plotWidth = PLOT_WIDTH) {
    render(
      <PaneLegendOverlay
        chart={makeChart([100, 100, 100, 100, 100, 100], plotWidth)}
        timeframe="1m"
        paneToggles={toggles}
      />,
    );
  }

  it('컨트롤이 legend 행 스택과 같은 flex row 안의 형제로, 행 뒤에 온다', () => {
    registerLegend('volume', [{ label: '거래량', value: 5000 }]);
    renderPanes();
    const wrapper = wrapperOf('volume');
    // 'column' 이면 컨트롤이 legend 위 한 줄을 통째로 차지한다(변경 전 동작).
    expect(wrapper.style.flexDirection).toBe('row');
    const rows = screen.getByTestId('pane-legend-rows-volume');
    expect(rows.parentElement).toBe(wrapper);
    // DOM 순서 = 시각 순서 → 탭 순서도 레전드 → 컨트롤.
    expect(rows.compareDocumentPosition(chipOf('volume')) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    // 긴 레전드가 컨트롤을 pane 밖으로 밀지 않게 하는 두 축. `min-width:auto`(flex 기본)
    // 면 행 스택이 축소를 거부하고, flexShrink 가 0 이 아니면 버튼이 잘린다.
    expect(rows.style.minWidth).toBe('0px');
    expect(chipOf('volume').style.flexShrink).toBe('0');
  });

  it('legend 행이 없는 pane 도 컨트롤은 우측에 남는다 (auto 마진, space-between 아님)', () => {
    renderPanes();
    // ratio 는 LEGEND_CELL_PANES 밖이라 행 스택 자체가 없다 — 자식이 컨트롤 하나뿐이라
    // justifyContent:'space-between' 였다면 그 하나가 **왼쪽**으로 붙었을 자리.
    expect(screen.queryByTestId('pane-legend-rows-ratio')).toBeNull();
    expect(chipOf('ratio').style.marginLeft).toBe('auto');
    expect(chipOf('volume').style.marginLeft).toBe('auto');
  });

  it('컨트롤 있는 pane 의 우측 인셋은 플롯 폭으로 클램프된다 (가격축 거터 회피)', () => {
    renderPanes();
    // 컨테이너는 거터까지 덮으므로 `right: var(--space-xs)` 면 버튼이 가격 라벨 위에 얹힌다.
    expect(wrapperOf('volume').style.right).toBe(`calc(100% - ${PLOT_WIDTH}px + var(--space-xs))`);
  });

  it('캔들 pane 은 클램프하지 않는다 — OHLC 컨테이너 쿼리 기준 폭 보존', () => {
    useMaSeriesRegistry.getState().register(null, 'ma-1', seriesWithValue(100));
    renderPanes();
    const candleWrapper = screen.getByTestId('pane-legend-rows-candle').parentElement!;
    expect(candleWrapper.style.right).toBe('var(--space-xs)');
  });

  it('플롯 폭을 못 읽으면(첫 프레임·teardown) 기존 인셋으로 폴백한다', () => {
    renderPanes(0);
    expect(wrapperOf('volume').style.right).toBe('var(--space-xs)');
  });
});
