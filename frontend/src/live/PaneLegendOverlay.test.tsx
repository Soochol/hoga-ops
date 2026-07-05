import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaneLegendOverlay from './PaneLegendOverlay';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';

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

function renderOverlay({
  timeframe = 'D' as LiveTimeframe,
  paneToggles = { foreignNet: false, institutionNet: false, volumeEnabled: false },
  paneSeries = new Map() as never,
  chart = makeChart([120]),
} = {}) {
  return render(
    <PaneLegendOverlay
      chart={chart}
      timeframe={timeframe}
      paneSeries={paneSeries}
      paneToggles={paneToggles}
    />,
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
}

describe('PaneLegendOverlay', () => {
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
    // 안정 참조 props (LiveChartRoot가 SSE 틱 간 유지하는 것들)
    const chart = makeChart([120]);
    const paneSeries = new Map() as never;
    const paneToggles = { foreignNet: false, institutionNet: false, volumeEnabled: false };
    const { rerender } = render(
      <PaneLegendOverlay
        chart={chart}
        timeframe="D"
        paneSeries={paneSeries}
        paneToggles={paneToggles}
        dataEpoch={1}
      />,
    );
    const afterFirst = dataCalls;
    expect(afterFirst).toBeGreaterThan(0);
    // SSE 호가 틱 = 부모 재렌더, props 동일 → memo가 차단 → data() 추가 호출 없음
    rerender(
      <PaneLegendOverlay
        chart={chart}
        timeframe="D"
        paneSeries={paneSeries}
        paneToggles={paneToggles}
        dataEpoch={1}
      />,
    );
    expect(dataCalls).toBe(afterFirst);
    // 캔들 갱신 = dataEpoch 증가 → 재렌더 → latest 값 신선화(data() 재호출)
    rerender(
      <PaneLegendOverlay
        chart={chart}
        timeframe="D"
        paneSeries={paneSeries}
        paneToggles={paneToggles}
        dataEpoch={2}
      />,
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

  it('renders the volume row from its pane primary series and ✕ turns volume off', () => {
    useLivePageStore.setState({ volumeEnabled: true, movingAverageEnabled: false });
    const paneSeries = new Map([['volume', seriesWithValue(5000)]]) as never;
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60])}
        timeframe="D"
        paneSeries={paneSeries}
        paneToggles={{ foreignNet: false, institutionNet: false, volumeEnabled: true }}
      />,
    );
    expect(screen.getByText('5,000')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '거래량 지표 끄기' }));
    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('renders no investor row on a weekly timeframe even with toggles on', () => {
    useLivePageStore.setState({
      movingAverageEnabled: false,
      foreignNetEnabled: true,
      institutionNetEnabled: true,
    });
    const paneSeries = new Map([
      ['investor-foreign', seriesWithValue(100)],
      ['investor-institution', seriesWithValue(-100)],
    ]) as never;
    render(
      <PaneLegendOverlay
        chart={makeChart([120, 60])}
        timeframe="W"
        paneSeries={paneSeries}
        paneToggles={{ foreignNet: true, institutionNet: true, volumeEnabled: false }}
      />,
    );
    expect(screen.queryByText('외국인 순매수량')).toBeNull();
    expect(screen.queryByText('기관 순매수량')).toBeNull();
  });

  it('volume close writes the active timeframe profile', async () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      panePrefsByTimeframe: {},
    });
    renderOverlay({
      timeframe: 'D',
      chart: makeChart([120, 60]),
      paneToggles: { foreignNet: false, institutionNet: false, volumeEnabled: true },
    });

    await userEvent.click(screen.getByLabelText('거래량 지표 끄기'));

    expect(useLivePageStore.getState().panePrefsByTimeframe.D?.volumeEnabled).toBe(false);
    expect(useLivePageStore.getState().volumeEnabled).toBe(true);
  });

  it('foreign close writes D profile investor toggle', async () => {
    useLivePageStore.setState({
      foreignNetEnabled: true,
      panePrefsByTimeframe: { D: { foreignNetEnabled: true } },
    });
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
