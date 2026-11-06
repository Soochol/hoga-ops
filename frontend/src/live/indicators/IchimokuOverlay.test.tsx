import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { useChartPrefsStore } from '../../state/chartPrefs';
import type { IchimokuSnapshot } from '../../chart/IchimokuPrimitive';
import { readFlagLegendValues } from './flagLegendValueRegistry';
import IchimokuOverlay from './IchimokuOverlay';
const candles = [10, 14, 12, 20, 18, 16].map((high, i) => ({ ts_ms: (i + 1) * 1000, open: high - 2, high, low: [2, 4, 6, 8, 10, 12][i], close: [6, 12, 9, 18, 14, 15][i], vol_a: 0, vol_b: 0 }));
const bundle = { candles, code: 'us-stock:AAPL' } as never;
const axis = { classifyAndProject: (m: number) => ({ contained: true, virtual: m }) } as never;
function host() {
  return { attachPrimitive: vi.fn(), detachPrimitive: vi.fn() };
}
describe('Ichimoku overlay lifecycle and readout', () => {
  beforeEach(() => {
    useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: '1m' });
    useChartPrefsStore.getState().resetToDefaults();
  });
  afterEach(cleanup);
  it('attaches one primitive after Add, updates snapshots, reads display coordinates and cleans up', () => {
    const series = host(), panes = new Map([['candle', series]]) as never;
    const view = render(<IchimokuOverlay bundle={bundle} axis={axis} paneSeries={panes} />);
    expect(series.attachPrimitive).not.toHaveBeenCalled();
    act(() => { useLivePageStore.getState().setIchimokuSettings({ ichimokuConversionPeriod: 2, ichimokuBasePeriod: 3, ichimokuLeadingBPeriod: 4, ichimokuDisplacement: 2 }); useLivePageStore.getState().setIchimokuEnabled(true); });
    expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
    const primitive = series.attachPrimitive.mock.calls[0][0] as { snapshot: IchimokuSnapshot | null };
    expect(primitive.snapshot?.model.lines.leadingA.offset).toBe(2);
    expect(readFlagLegendValues(null, 'ichimoku', 'main', 5).find(v => v.key === 'leadingA')?.value).toBe('8.50');
    expect(readFlagLegendValues(null, 'ichimoku', 'main', 1).find(v => v.key === 'lagging')?.value).toBe('9.00');
    expect(readFlagLegendValues(null, 'ichimoku', 'main', 2.5)).toEqual([]);
    const latest = readFlagLegendValues(null, 'ichimoku', 'main', null);
    expect(latest.filter(v => v.label?.includes('최근봉 위치'))).toHaveLength(1);
    expect(latest.find(v => v.key === 'lagging')?.value).toBe('—');
    act(() => useLivePageStore.getState().setIchimokuSettings({ ichimokuDisplacement: 0, ichimokuCloudOpacity: .7 }));
    expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
    expect(primitive.snapshot?.model.lines.leadingA.offset).toBe(0);
    expect(primitive.snapshot?.style.cloud.opacity).toBe(.7);
    act(() => useLivePageStore.getState().setIchimokuHidden(true)); expect(primitive.snapshot).toBeNull();
    act(() => useLivePageStore.getState().setIchimokuEnabled(false));
    expect(series.detachPrimitive).toHaveBeenCalledTimes(1);
    expect(readFlagLegendValues(null, 'ichimoku', 'main', null)).toEqual([]);
    view.unmount();
  });
  it('reprojects corrections and prepends, refuses malformed duplicate keys and releases replaced hosts', () => {
    useLivePageStore.setState({ ichimokuEnabled: true, ichimokuConversionPeriod: 1, ichimokuBasePeriod: 1, ichimokuLeadingBPeriod: 1, ichimokuDisplacement: 1 });
    const first = host(), second = host();
    const view = render(<IchimokuOverlay bundle={bundle} axis={axis} paneSeries={new Map([['candle', first]]) as never} />);
    const corrected = { candles: [...candles.slice(0, -1), { ...candles.at(-1)!, high: 100, low: 90 }], code: 'us-stock:AAPL' } as never;
    view.rerender(<IchimokuOverlay bundle={corrected} axis={axis} paneSeries={new Map([['candle', first]]) as never} />);
    expect(readFlagLegendValues(null, 'ichimoku', 'main', null)[0].value).toBe('95.00');
    const prepended = { candles: [{ ...candles[0], ts_ms: 500, high: 30, low: 10, close: 20 }, ...candles], code: 'us-stock:AAPL' } as never;
    view.rerender(<IchimokuOverlay bundle={prepended} axis={axis} paneSeries={new Map([['candle', first]]) as never} />);
    expect(readFlagLegendValues(null, 'ichimoku', 'main', 1).find(v => v.key === 'leadingA')?.value).toBe('20.00');
    expect((first.attachPrimitive.mock.calls[0][0] as { snapshot: IchimokuSnapshot }).snapshot.model.bars).toHaveLength(7);
    const duplicate = { candles: [...candles, candles.at(-1)!] } as never;
    view.rerender(<IchimokuOverlay bundle={duplicate} axis={axis} paneSeries={new Map([['candle', first]]) as never} />);
    expect(readFlagLegendValues(null, 'ichimoku', 'main', null)).toEqual([]);
    view.rerender(<IchimokuOverlay bundle={bundle} axis={axis} paneSeries={new Map([['candle', second]]) as never} />);
    expect(first.detachPrimitive).toHaveBeenCalledTimes(1); expect(second.attachPrimitive).toHaveBeenCalledTimes(1);
    view.unmount(); expect(second.detachPrimitive).toHaveBeenCalledTimes(1);
  });
});
