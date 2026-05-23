import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LineSeries } from 'lightweight-charts';
import RangeSeriesPane, { type PaneSpec } from '../../src/chart/RangeSeriesPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

const makeMockChart = () => {
  const seriesList: Array<{ setData: ReturnType<typeof vi.fn>; createPriceLine: ReturnType<typeof vi.fn> }> = [];
  return {
    chart: {
      addSeries: vi.fn(() => {
        const s = { setData: vi.fn(), createPriceLine: vi.fn() };
        seriesList.push(s);
        return s;
      }),
      removeSeries: vi.fn(),
    } as any,
    seriesList,
  };
};

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);
const baseBundle: any = { quote_ratio: { points: [{ t: sessionOpenMs, bid_total: 100, ask_total: 200 }] } };

describe('RangeSeriesPane', () => {
  it('mounts each series on the given paneIndex and feeds projector output to setData', () => {
    const { chart, seriesList } = makeMockChart();
    const spec: PaneSpec = {
      name: 'test-one',
      stretch: 0.4,
      series: [
        {
          type: LineSeries,
          options: { color: '#aaa' },
          data: (b, ax) => b.quote_ratio.points.map((p: any) => ({ time: ax.toVirtual(p.t) / 1000, value: p.bid_total })),
        },
      ],
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={3} spec={spec} />);
    expect(chart.addSeries).toHaveBeenCalledTimes(1);
    expect(chart.addSeries.mock.calls[0][2]).toBe(3);
    expect(seriesList[0].setData).toHaveBeenCalledWith([{ time: 0, value: 100 }]);
  });

  it('mounts multiple series in order on the same paneIndex', () => {
    const { chart, seriesList } = makeMockChart();
    const spec: PaneSpec = {
      name: 'test-two',
      stretch: 0.4,
      series: [
        { type: LineSeries, options: { color: '#a' }, data: () => [{ time: 0, value: 1 }] },
        { type: LineSeries, options: { color: '#b' }, data: () => [{ time: 0, value: 2 }] },
      ],
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={2} spec={spec} />);
    expect(chart.addSeries).toHaveBeenCalledTimes(2);
    expect(seriesList[0].setData).toHaveBeenCalledWith([{ time: 0, value: 1 }]);
    expect(seriesList[1].setData).toHaveBeenCalledWith([{ time: 0, value: 2 }]);
  });

  it('calls useContext, threads result into data(), and invokes afterAdd per series', () => {
    const { chart, seriesList } = makeMockChart();
    const useCtx = vi.fn(() => ({ flag: true }));
    const dataFn = vi.fn(() => [{ time: 0, value: 1 }]);
    const afterAdd = vi.fn();
    const spec: PaneSpec<{ flag: boolean }> = {
      name: 'test-ctx',
      stretch: 0.4,
      series: [{ type: LineSeries, options: {}, data: dataFn, afterAdd }],
      useContext: useCtx,
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={1} spec={spec} />);
    expect(useCtx).toHaveBeenCalled();
    expect(dataFn).toHaveBeenCalledWith(baseBundle, axis, { flag: true });
    expect(afterAdd).toHaveBeenCalledWith(seriesList[0]);
  });

  it('removes every series on unmount via try/catch-guarded removeSeries', () => {
    const { chart, seriesList } = makeMockChart();
    const spec: PaneSpec = {
      name: 'test-cleanup',
      stretch: 0.4,
      series: [
        { type: LineSeries, options: {}, data: () => [] },
        { type: LineSeries, options: {}, data: () => [] },
      ],
    };
    const { unmount } = render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={0} spec={spec} />);
    unmount();
    expect(chart.removeSeries).toHaveBeenCalledTimes(2);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[0]);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[1]);
  });
});
