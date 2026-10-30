import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import CandleMovingAverageDetails from './CandleMovingAverageDetails';
import { useLivePageStore, type LiveMAConfig } from '../state/livePage';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './indicators/dailyMaSeriesRegistry';
import { WindowViewContext } from './workspace/windowView';

const config = (id: string, period = 20, extra: Partial<LiveMAConfig> = {}): LiveMAConfig => ({
  id, period, enabled: true, source: 'close', color: '#EC4899', lineWidth: 1, ...extra,
});
const chart = { timeScale: () => ({ timeToIndex: () => 1 }) } as unknown as IChartApi;
const props = { chart, timeSec: 1060, close: 107, code: '005930', timeframe: '1m' as const };

function line(value: number | null, time = 1060) {
  let point = value === null ? { time } : { time, value };
  const listeners = new Set<() => void>();
  const data = vi.fn(() => [point]);
  const series = {
    dataByIndex: vi.fn(() => point), data,
    subscribeDataChanged: vi.fn((callback: () => void) => listeners.add(callback)),
    unsubscribeDataChanged: vi.fn((callback: () => void) => listeners.delete(callback)),
  };
  return { series: series as unknown as ISeriesApi<SeriesType>, data, listeners,
    update: (value: number) => act(() => { point = { time, value }; listeners.forEach(callback => callback()); }),
  };
}

beforeEach(() => {
  useMaSeriesRegistry.setState({ byScope: new Map() });
  useDailyMaSeriesRegistry.setState({ byScope: new Map() });
  useLivePageStore.setState({ movingAverages: [config('ma')], dailyMovingAverages: [],
    indicatorInstances: [], indicatorPrimaryHidden: [] });
});
afterEach(cleanup);

describe('candle moving-average details', () => {
  it('reads the hovered plotted price, using the raw value for the signed close gap', () => {
    const { series, data } = line(100.49);
    useMaSeriesRegistry.getState().register(null, 'ma', series);
    render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('MA 20');
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('100 (+6.48%)');
    expect(series.dataByIndex).toHaveBeenCalledWith(1);
    expect(data).not.toHaveBeenCalled();
  });

  it.each([
    [110, '-2.73%', 'text-price-down'], [107, '0.00%', 'text-fg-dim'],
    [107.00001, '0.00%', 'text-fg-dim'], [106.99999, '0.00%', 'text-fg-dim'],
  ])('rounds the sign and color consistently at MA %s', (value, text, className) => {
    useMaSeriesRegistry.getState().register(null, 'ma', line(value).series);
    render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getByText(`(${text})`)).toHaveClass(className);
  });

  it.each([null, 0, -1, NaN, Infinity])('shows unavailable MA %s as a dash', value => {
    useMaSeriesRegistry.getState().register(null, 'ma', line(value).series);
    render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('MA 20—');
    expect(screen.getByTestId('candle-ma-row')).not.toHaveTextContent('%');
  });

  it('never borrows the last or previous value for a missing candle', () => {
    useMaSeriesRegistry.getState().register(null, 'ma', line(100, 1000).series);
    render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('MA 20—');
  });

  it('updates under a stationary pointer and unsubscribes when closed', () => {
    const plot = line(100);
    useMaSeriesRegistry.getState().register(null, 'ma', plot.series);
    const { unmount } = render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('100 (+7.00%)');
    plot.update(110);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('110 (-2.73%)');
    unmount();
    expect(plot.listeners.size).toBe(0);
  });

  it('shows visible slots in settings order, independently of the legend', () => {
    useLivePageStore.setState({ movingAverages: [config('second', 60), config('hidden', 5, { hidden: true }),
      config('off', 10, { enabled: false }), config('first', 20)] });
    useMaSeriesRegistry.getState().register(null, 'first', line(100).series);
    useMaSeriesRegistry.getState().register(null, 'second', line(110).series);
    render(<CandleMovingAverageDetails {...props} />);
    const rows = screen.getAllByTestId('candle-ma-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('MA 60');
    expect(rows[1]).toHaveTextContent('MA 20');
  });

  it('omits a hidden primary group and includes repeated instances from their own registries', () => {
    useLivePageStore.setState({ indicatorPrimaryHidden: ['moving-average'], indicatorInstances: [
      { id: 'extra', category: 'moving-average', settings: { movingAverages: [config('ma', 5)] }, prefs: {} },
      { id: 'hidden', category: 'moving-average', hidden: true, settings: { movingAverages: [config('ma', 60)] }, prefs: {} },
    ] });
    useMaSeriesRegistry.getState().register(null, 'ma', line(999).series);
    useMaSeriesRegistry.getState().register('ambient:indicator:extra', 'ma', line(100).series);
    render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getAllByTestId('candle-ma-row')).toHaveLength(1);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('MA 5100 (+7.00%)');
  });

  it('reads daily projections as a separate group and refreshes asynchronous values', () => {
    useLivePageStore.setState({ movingAverages: [], dailyMovingAverages: [config('daily')] });
    const daily = line(null);
    useDailyMaSeriesRegistry.getState().register(null, 'daily', daily.series);
    const { rerender } = render(<CandleMovingAverageDetails {...props} />);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('일봉 MA 20—');
    daily.update(100);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('일봉 MA 20100 (+7.00%)');
    rerender(<CandleMovingAverageDetails {...props} timeframe="D" />);
    expect(screen.queryByTestId('candle-ma-details')).toBeNull();
  });

  it('keeps US price decimals', () => {
    useMaSeriesRegistry.getState().register(null, 'ma', line(100.49).series);
    render(<CandleMovingAverageDetails {...props} code="us-stock:NASDAQ:AAPL" />);
    expect(screen.getByTestId('candle-ma-row')).toHaveTextContent('100.49 (+6.48%)');
  });

  it('keeps identically named slots in two windows isolated', () => {
    for (const [id, price] of [['a', 100], ['b', 110]] as const) {
      useLivePageStore.getState().patchIndicatorsScoped({ windowKey: `live:${id}` }, '1m', {
        movingAverages: [config('ma')], dailyMovingAverages: [], indicatorInstances: [], indicatorPrimaryHidden: [],
      });
      useMaSeriesRegistry.getState().register(id, 'ma', line(price).series);
    }
    render(<>{['a', 'b'].map(id => <WindowViewContext.Provider key={id} value={{
      windowId: id, group: null, code: '005930', timeframe: '1m', historicalFromDate: null,
    }}><div data-testid={`window-${id}`}><CandleMovingAverageDetails {...props} /></div></WindowViewContext.Provider>)}</>);
    expect(within(screen.getByTestId('window-a')).getByTestId('candle-ma-row')).toHaveTextContent('100 (+7.00%)');
    expect(within(screen.getByTestId('window-b')).getByTestId('candle-ma-row')).toHaveTextContent('110 (-2.73%)');
  });
});
