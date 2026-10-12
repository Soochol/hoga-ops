import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { readFlagLegendValues } from './flagLegendValueRegistry';
import BollingerOverlay from './BollingerOverlay';

const candles = [1, 2, 3, 4, 5].map((close, i) => ({
  ts_ms: (i + 1) * 1000, open: close * 2, high: close * 3, low: close, close, vol_a: 0, vol_b: 0,
}));
const bundle = { candles } as never;
const axis = { classifyAndProject: (m: number) => ({ contained: true, virtual: m }) } as never;
function chartMock() {
  const chart = {
    addSeries: vi.fn(() => ({ setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn() })),
    removeSeries: vi.fn(), clearCrosshairPosition: vi.fn(),
  };
  return chart;
}

describe('BollingerOverlay', () => {
  beforeEach(() => {
    useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorTimeframe: '1m' });
    useChartPrefsStore.getState().resetToDefaults();
  });
  afterEach(cleanup);

  it('creates three lines only when added, updates in place, hides, and cleans up on deletion', () => {
    const chart = chartMock();
    render(<BollingerOverlay chart={chart as never} bundle={bundle} axis={axis} />);
    expect(chart.addSeries).not.toHaveBeenCalled();
    act(() => {
      useLivePageStore.getState().setBollingerSettings({ bollingerPeriod: 3 });
      useLivePageStore.getState().setBollingerEnabled(true);
    });
    expect(chart.addSeries).toHaveBeenCalledTimes(3);
    const [upper, middle, lower] = chart.addSeries.mock.results.map((r) => r.value);
    expect(middle.setData.mock.calls.at(-1)[0]).toEqual([{ time: 1 }, { time: 2 }, { time: 3, value: 2 }, { time: 4, value: 3 }, { time: 5, value: 4 }]);
    expect(upper.setData.mock.calls.at(-1)[0][2].value).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3));
    expect(lower.setData.mock.calls.at(-1)[0][2].value).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3));
    expect(readFlagLegendValues(null, 'bollinger', 'main', 2)).toEqual([]);
    expect(readFlagLegendValues(null, 'bollinger', 'main', 3)[1]).toMatchObject({ label: '중심', value: '2' });
    act(() => useLivePageStore.getState().setBollingerSettings({ bollingerSource: 'open', bollingerUpperColor: '#123456' }));
    expect(chart.addSeries).toHaveBeenCalledTimes(3);
    expect(middle.setData.mock.calls.at(-1)[0][2].value).toBe(4);
    act(() => useLivePageStore.getState().setBollingerHidden(true));
    expect(upper.applyOptions.mock.calls.at(-1)[0]).toMatchObject({ visible: false, color: '#123456' });
    act(() => useLivePageStore.getState().setBollingerEnabled(false));
    expect(chart.removeSeries).toHaveBeenCalledTimes(3);
    expect(readFlagLegendValues(null, 'bollinger', 'main', null)).toEqual([]);
  });

  it('reprojects price corrections and releases old series when the chart changes', () => {
    useLivePageStore.setState({ bollingerEnabled: true, bollingerPeriod: 2 });
    const first = chartMock(), second = chartMock();
    const view = render(<BollingerOverlay chart={first as never} bundle={bundle} axis={axis} />);
    const changed = { candles: [...candles.slice(0, -1), { ...candles.at(-1)!, close: 9 }] } as never;
    view.rerender(<BollingerOverlay chart={first as never} bundle={changed} axis={axis} />);
    expect(readFlagLegendValues(null, 'bollinger', 'main', null)[1].value).toBe('7');
    view.rerender(<BollingerOverlay chart={second as never} bundle={changed} axis={axis} />);
    expect(first.removeSeries).toHaveBeenCalledTimes(3);
    expect(second.addSeries).toHaveBeenCalledTimes(3);
    expect(second.addSeries.mock.results[1].value.setData.mock.calls[0][0].at(-1).value).toBe(6.5);
    view.unmount();
    expect(second.removeSeries).toHaveBeenCalledTimes(3);
  });
});
