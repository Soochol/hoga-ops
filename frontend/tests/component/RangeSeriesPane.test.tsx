import { render, act } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { LineSeries } from 'lightweight-charts';
import RangeSeriesPane, { type PaneSpec } from '../../src/chart/RangeSeriesPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

const makeMockChart = () => {
  const seriesList: Array<{
    setData: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    createPriceLine: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    chart: {
      addSeries: vi.fn(() => {
        const s = { setData: vi.fn(), update: vi.fn(), createPriceLine: vi.fn() };
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

  it('does not recreate series when ctx changes via subscription — data effect re-runs instead', () => {
    // Regression guard for the Moving Average flicker: ctx gets a fresh
    // reference on every config change. The lifecycle/data split keeps ctx OUT
    // of the lifecycle effect deps, so a ctx change re-runs setData on existing
    // handles WITHOUT tearing down + re-adding series.
    //
    // Bundle-split Phase B (2026-06-09): RangeSeriesPane is now React.memo'd.
    // In production ctx changes arrive via the useContext hook's OWN store
    // subscription (zustand / useSyncExternalStore), which re-renders the
    // component THROUGH memo (memo only blocks parent-prop-driven re-renders,
    // never a component's own subscription). This test mirrors that path: a tiny
    // external store drives ctx, and bumping it must re-run setData while leaving
    // the series handles intact.
    const { chart, seriesList } = makeMockChart();
    let period = 5;
    const listeners = new Set<() => void>();
    const store = {
      get: () => period,
      set: (v: number) => { period = v; listeners.forEach((l) => l()); },
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
    // Two bars so a ctx bump changes only the LAST bar's value → the data effect
    // takes the update(tail) path. The intent under test is "ctx change re-runs
    // the data effect on the existing handle (no recreate)", independent of
    // whether that push is a setData or an update.
    const dataFn = vi.fn((_b: any, _ax: any, ctx: { period: number }) => [
      { time: 0, value: 1 },
      { time: 1, value: ctx.period },
    ]);
    const spec: PaneSpec<{ period: number }> = {
      name: 'test-ctx-stability',
      stretch: 0.4,
      series: [{ type: LineSeries, options: {}, data: dataFn }],
      // useContext subscribes to the store → store change re-renders the memo'd
      // RangeSeriesPane (subscription bypasses memo), yielding a fresh ctx.
      useContext: () => ({ period: useSyncExternalStore(store.subscribe, store.get) }),
    };
    render(<RangeSeriesPane chart={chart} bundle={baseBundle} axis={axis} paneIndex={0} spec={spec} />);
    expect(chart.addSeries).toHaveBeenCalledTimes(1);
    const pushesBefore =
      seriesList[0].setData.mock.calls.length + seriesList[0].update.mock.calls.length;

    // ctx changes via the store subscription (NOT a parent re-render).
    act(() => store.set(10));

    // Lifecycle effect must not have re-run — addSeries/removeSeries unchanged.
    expect(chart.addSeries).toHaveBeenCalledTimes(1);
    expect(chart.removeSeries).not.toHaveBeenCalled();
    // Data effect re-ran on the existing handle with the new ctx (a last-bar-only
    // change → update(tail), no recreate, no full setData).
    const pushesAfter =
      seriesList[0].setData.mock.calls.length + seriesList[0].update.mock.calls.length;
    expect(pushesAfter).toBeGreaterThan(pushesBefore);
    expect(seriesList[0].update).toHaveBeenLastCalledWith({ time: 1, value: 10 });
    expect(dataFn).toHaveBeenLastCalledWith(baseBundle, axis, { period: 10 });
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
