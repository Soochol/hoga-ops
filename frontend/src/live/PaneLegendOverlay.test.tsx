import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaneLegendOverlay from './PaneLegendOverlay';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
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
    volumeEnabled: false,
    foreignNetEnabled: false,
    institutionNetEnabled: false,
  });
  useMaSeriesRegistry.setState({ series: new Map() });
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
    expect(useLivePageStore.getState().panePrefsByTimeframe.minute?.quoteTotalsEnabled).toBe(false);
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
    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
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
      panePrefsByTimeframe: { D: { foreignNetEnabled: true } },
    });
    registerLegend('investor-foreign', [{ label: '외국인 순매수량', value: 100 }]);
    renderOverlay({
      timeframe: 'D',
      chart: makeChart([120, 60]),
      paneToggles: { foreignNet: true, institutionNet: false, volumeEnabled: false },
    });

    await userEvent.click(screen.getByLabelText('외국인 순매수량 지표 끄기'));

    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.foreignNetEnabled).toBe(false);
    expect(useLivePageStore.getState().foreignNetEnabled).toBe(true);
  });
});
