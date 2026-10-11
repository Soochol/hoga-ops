import { act, cleanup, render } from '@testing-library/react';
import { CandlestickSeries } from 'lightweight-charts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { useLivePageStore } from '../../state/livePage';
import MovingAverageOverlay from './MovingAverageOverlay';
import DailyMovingAverageOverlay from './DailyMovingAverageOverlay';

vi.mock('./useResolvedDailyCandles', () => ({
  useResolvedDailyCandles: () => ({ candles: [], dataWarnings: [], isLoading: false }),
}));

interface TestSeries {
  seriesType: () => string;
  seriesOrder: () => number;
  setSeriesOrder: (order: number) => void;
  setData: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
}

function makeOrderedChart() {
  const ordered: TestSeries[] = [];
  const chart = {
    panes: () => [{ getSeries: () => [...ordered] }],
    addSeries: vi.fn((definition: { type: string }) => {
      const series: TestSeries = {
        seriesType: () => definition.type,
        seriesOrder: () => ordered.indexOf(series),
        setSeriesOrder: vi.fn((index: number) => {
          ordered.splice(ordered.indexOf(series), 1);
          ordered.splice(index, 0, series);
        }),
        setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
      };
      ordered.push(series);
      return series;
    }),
    removeSeries: vi.fn((series: TestSeries) => { ordered.splice(ordered.indexOf(series), 1); }),
    clearCrosshairPosition: vi.fn(),
  };
  return { chart, ordered };
}

const slot = { id: 'first', period: 2, enabled: true, color: '#f00', lineWidth: 1, source: 'close' } as const;
const ts = Date.parse('2026-10-01T09:00:00+09:00');
const bundle = { candles: [0, 1, 2].map(i => ({
  ts_ms: ts + i * 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0,
})) } as never;
const axis = {
  classifyAndProject: (m: number) => ({ contained: true, virtual: m }),
  findByReal: () => 0,
  segments: [{ date: '20261001' }],
} as never;

describe.each(['current', 'daily'] as const)('%s MA render order', kind => {
  const key = kind === 'current' ? 'movingAverages' : 'dailyMovingAverages';
  const component = (m: ReturnType<typeof makeOrderedChart>) => kind === 'current'
    ? <MovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis} />
    : <DailyMovingAverageOverlay chart={m.chart as never} bundle={bundle} axis={axis}
      code="005930" timeframe="1m" todayKst="20261001" />;

  beforeEach(() => {
    cleanup();
    useChartPrefsStore.getState().resetToDefaults();
    useLivePageStore.setState({ [key]: [{ ...slot }] });
  });

  it('keeps candles above added, removed and re-added lines without recreating existing series', () => {
    useChartPrefsStore.getState().setToggle('candleAlwaysOnTop', true);
    const m = makeOrderedChart();
    render(component(m));
    const originalMa = m.ordered[0];
    // LiveChartRoot starts MA overlays before candles when the setting is on.
    const candle = m.chart.addSeries(CandlestickSeries);
    expect(m.ordered.at(-1)).toBe(candle);
    act(() => useLivePageStore.setState({ [key]: [{ ...slot }, { ...slot, id: 'new', period: 3 }] }));
    expect(m.ordered.at(-1)).toBe(candle);
    expect(m.ordered[0]).toBe(originalMa);
    expect(m.chart.removeSeries).not.toHaveBeenCalled();
    const newMa = m.ordered[1];
    act(() => useLivePageStore.setState({ [key]: [{ ...slot, id: 'new', period: 3 }] }));
    expect(m.ordered).toEqual([newMa, candle]);
    act(() => useLivePageStore.setState({ [key]: [] }));
    expect(m.ordered).toEqual([candle]);
    act(() => useLivePageStore.setState({ [key]: [{ ...slot, id: 're-added' }] }));
    expect(m.ordered.at(-1)).toBe(candle);
    expect(m.chart.removeSeries.mock.calls.every(([s]) => s !== candle)).toBe(true);
    expect(candle.setData).not.toHaveBeenCalled();
  });

  it('keeps MA lines above candles when the setting is off', () => {
    const m = makeOrderedChart();
    const candle = m.chart.addSeries(CandlestickSeries);
    render(component(m));
    act(() => useLivePageStore.setState({ [key]: [{ ...slot }, { ...slot, id: 'new' }] }));
    expect(m.ordered[0]).toBe(candle);
    expect(candle.setSeriesOrder).not.toHaveBeenCalled();
    act(() => useLivePageStore.setState({ [key]: [{ ...slot, id: 'new' }] }));
    expect(m.ordered[0]).toBe(candle);
  });

  it('preserves order and series identity on edits, then restores order on a replacement chart', () => {
    useChartPrefsStore.getState().setToggle('candleAlwaysOnTop', true);
    const m = makeOrderedChart();
    const candle = m.chart.addSeries(CandlestickSeries);
    const view = render(component(m));
    const ma = m.ordered[0];
    act(() => useLivePageStore.setState({ [key]: [{ ...slot, period: 3, color: '#00f' }] }));
    expect(m.ordered).toEqual([ma, candle]);
    expect(m.chart.removeSeries).not.toHaveBeenCalled();
    expect(m.chart.addSeries).toHaveBeenCalledTimes(2);
    const next = makeOrderedChart();
    const nextCandle = next.chart.addSeries(CandlestickSeries);
    view.rerender(component(next));
    expect(next.ordered.at(-1)).toBe(nextCandle);
    expect(next.ordered).toHaveLength(2);
  });
});
