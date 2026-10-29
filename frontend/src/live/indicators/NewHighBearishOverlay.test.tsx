import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLivePageStore } from '../../state/livePage';
import { FACTORY_INDICATOR_SETTINGS } from '../../state/indicatorSettingsV2';
import { NewHighBearishRaysPrimitive } from '../../chart/NewHighBearishRaysPrimitive';
import { readFlagLegendValues } from './flagLegendValueRegistry';
import NewHighBearishOverlay from './NewHighBearishOverlay';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('gates by daily/stock/completion, updates the same primitive, and removes it and its legend on disable', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T21:00:00+09:00'));
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: 'D', newHighBearishEnabled: true, newHighBearishLookback: 5 });
  const ohlc = [...Array.from({ length: 5 }, () => [100, 101, 99, 100]), [110, 120, 109, 110], [109, 111, 99, 100], [99, 100, 89, 90]];
  const candles = ohlc.map(([open, high, low, close], i) => ({ ts_ms: Date.parse('2026-09-01T09:00:00+09:00') + i * 86400000, open, high, low, close, vol_a: 1, vol_b: 0 }));
  const data = vi.spyOn(NewHighBearishRaysPrimitive.prototype, 'setData');
  const series = { attachPrimitive: vi.fn(), detachPrimitive: vi.fn() };
  const props = { bundle: { candles } as never, axis: { contains: () => true, toVirtual: (t: number) => t, toReal: (t: number) => t } as never,
    paneSeries: new Map([['candle', series]]) as never, timeframe: 'D' as const, venue: 'KRX' as const, code: '005930' };
  const view = render(<NewHighBearishOverlay {...props} timeframe="5m" />);
  expect(series.attachPrimitive).not.toHaveBeenCalled();
  view.rerender(<NewHighBearishOverlay {...props} />);
  expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
  expect(data.mock.calls.at(-1)![0]).toEqual([{ time: candles[6].ts_ms / 1000, endTime: candles[7].ts_ms / 1000, price: 109, futureEndMs: Date.parse('2027-03-07T09:00:00+09:00') }]);
  act(() => useLivePageStore.getState().setNewHighBearishSettings({ newHighBearishMaxCount: 2 }));
  expect(data.mock.calls.at(-1)![0]).toHaveLength(2);
  expect(readFlagLegendValues(null, 'new-high-bearish', 'main', null).map(c => c.value)).toEqual(['109', '99']);
  act(() => useLivePageStore.getState().setNewHighBearishHidden(true));
  expect(data.mock.calls.at(-1)![0]).toEqual([]);
  expect(series.attachPrimitive).toHaveBeenCalledTimes(1);
  act(() => useLivePageStore.getState().setNewHighBearishEnabled(false));
  expect(series.detachPrimitive).toHaveBeenCalledTimes(1);
  expect(readFlagLegendValues(null, 'new-high-bearish', 'main', null)).toEqual([]);
});

it('ends each ray at its calendar-month deadline and recalculates its endpoint when duration changes', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-29T21:00:00+09:00'));
  useLivePageStore.setState({ ...FACTORY_INDICATOR_SETTINGS, indicatorsByTimeframe: {}, indicatorsByWindow: {}, indicatorTimeframe: 'D', newHighBearishEnabled: true, newHighBearishLookback: 5 });
  const first = Date.parse('2026-01-01T09:00:00+09:00');
  const candles = Array.from({ length: 260 }, (_, i) => {
    const [open, high, low, close] = i < 5 ? [100, 101, 99, 100] : i === 5 ? [110, 120, 109, 110] : i === 6 ? [109, 111, 99, 100] : [80, 81, 79, 80];
    return { ts_ms: first + i * 86400000, open, high, low, close, vol_a: 1, vol_b: 0 };
  });
  const data = vi.spyOn(NewHighBearishRaysPrimitive.prototype, 'setData');
  render(<NewHighBearishOverlay bundle={{ candles } as never}
    axis={{ contains: () => true, toVirtual: (t: number) => t, toReal: (t: number) => t } as never}
    paneSeries={new Map([['candle', { attachPrimitive: vi.fn(), detachPrimitive: vi.fn() }]]) as never}
    timeframe="D" venue="KRX" code="005930" />);
  const ray = () => data.mock.calls.at(-1)![0][0];
  expect(ray()).toMatchObject({ time: Date.parse('2026-01-07T09:00:00+09:00') / 1000, endTime: Date.parse('2026-07-07T09:00:00+09:00') / 1000 });
  act(() => useLivePageStore.getState().setNewHighBearishSettings({ newHighBearishMonths: 1 }));
  expect(ray().endTime).toBe(Date.parse('2026-02-07T09:00:00+09:00') / 1000);
});
