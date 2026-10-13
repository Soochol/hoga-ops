import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { readFlagLegendValues } from './flagLegendValueRegistry';
import SupertrendOverlay from './SupertrendOverlay';

const candles = [10, 10, 14, 15, 9, 8].map((close, i) => ({
  ts_ms: (i + 1) * 1000, open: close, high: close + 1, low: close - 1, close, vol_a: 0, vol_b: 0,
}));
const bundle = { candles } as never;
const axis = { classifyAndProject: (m: number) => ({ contained: true, virtual: m }) } as never;
function chartMock() {
  return {
    addSeries: vi.fn(() => ({ setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn() })),
    removeSeries: vi.fn(), clearCrosshairPosition: vi.fn(),
  };
}

describe('SupertrendOverlay', () => {
  beforeEach(() => {
    useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorTimeframe: '1m' });
    useChartPrefsStore.getState().resetToDefaults();
  });
  afterEach(cleanup);

  it('adds a colored trend line, retains identity when edited/hidden, and cleans up', () => {
    const chart = chartMock();
    render(<SupertrendOverlay chart={chart as never} bundle={bundle} axis={axis} />);
    expect(chart.addSeries).not.toHaveBeenCalled();
    act(() => {
      useLivePageStore.getState().setSupertrendSettings({ supertrendPeriod: 2, supertrendMultiplier: 1 });
      useLivePageStore.getState().setSupertrendEnabled(true);
    });
    const series = chart.addSeries.mock.results[0].value;
    const data = series.setData.mock.calls.at(-1)[0];
    expect(data[2]).toEqual({ time: 3, value: 10.5, color: '#F04452' });
    expect(data[3]).toEqual({ time: 4, value: 12.25, color: 'transparent' });
    expect(readFlagLegendValues(null, 'supertrend', 'main', 1)).toEqual([]);
    expect(readFlagLegendValues(null, 'supertrend', 'main', 3)).toEqual([{ key: 'trend', label: '상승', value: '11', color: '#F04452' }]);
    expect(readFlagLegendValues(null, 'supertrend', 'main', null)[0]).toMatchObject({ label: '하락', value: '11' });
    act(() => useLivePageStore.getState().setSupertrendSettings({ supertrendUpColor: '#123456', supertrendLineWidth: 4 }));
    expect(chart.addSeries).toHaveBeenCalledTimes(1);
    expect(series.applyOptions.mock.calls.at(-1)[0]).toMatchObject({ color: '#123456', lineWidth: 4 });
    act(() => useLivePageStore.getState().setSupertrendHidden(true));
    expect(series.applyOptions.mock.calls.at(-1)[0].visible).toBe(false);
    expect(readFlagLegendValues(null, 'supertrend', 'main', 3)[0].color).toBe('#123456');
    act(() => useLivePageStore.getState().setSupertrendEnabled(false));
    expect(chart.removeSeries).toHaveBeenCalledTimes(1);
    expect(readFlagLegendValues(null, 'supertrend', 'main', null)).toEqual([]);
  });

  it('recalculates a corrected tail and pushes data to a replacement chart', () => {
    useLivePageStore.setState({ supertrendEnabled: true, supertrendPeriod: 2, supertrendMultiplier: 1 });
    const first = chartMock(), second = chartMock();
    const view = render(<SupertrendOverlay chart={first as never} bundle={bundle} axis={axis} />);
    const changed = { candles: [...candles.slice(0, -1), { ...candles.at(-1)!, high: 21, low: 19, close: 20 }] } as never;
    view.rerender(<SupertrendOverlay chart={first as never} bundle={changed} axis={axis} />);
    expect(readFlagLegendValues(null, 'supertrend', 'main', null)[0].label).toBe('상승');
    view.rerender(<SupertrendOverlay chart={second as never} bundle={changed} axis={axis} />);
    expect(first.removeSeries).toHaveBeenCalledTimes(1);
    expect(second.addSeries.mock.results[0].value.setData).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(second.removeSeries).toHaveBeenCalledTimes(1);
  });
});
