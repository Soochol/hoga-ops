import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import RangeSeriesPane, { type PaneSpec } from './RangeSeriesPane';

// Each addSeries returns a fresh stub so we can assert which series instance
// received setData after a re-create.
function makeChart() {
  const created: Array<{ setData: ReturnType<typeof vi.fn>; paneIndex: number }> = [];
  const chart = {
    addSeries: vi.fn((_type: unknown, _opts: unknown, paneIndex: number) => {
      const series = { setData: vi.fn(), paneIndex };
      created.push(series);
      return series;
    }),
    removeSeries: vi.fn(),
  } as never;
  return { chart, created };
}

const SPEC: PaneSpec = {
  name: 'volume',
  stretch: 0.3,
  series: [
    {
      type: {} as never,
      options: {} as never,
      data: () => [{ time: 1, value: 10 }] as never,
    },
  ],
};

// Stable refs so the data effect doesn't re-run for an unrelated reason.
const bundle = { candles: [] } as never;
const axis = { contains: () => true, toVirtual: (t: number) => t } as never;

describe('RangeSeriesPane', () => {
  afterEach(cleanup);

  it('re-pushes data after a paneIndex change re-creates the series', () => {
    // Regression: removing a pane above (volume off) shifts this pane's index,
    // which re-creates the series. The data effect must re-run too, or the new
    // series renders empty until a full remount (investor bars vanished bug).
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={2} spec={SPEC} />,
    );
    expect(created).toHaveLength(1);
    expect(created[0].setData).toHaveBeenCalledTimes(1); // initial push

    // Pane above removed → this pane shifts 2 → 1 → lifecycle re-creates series.
    rerender(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={1} spec={SPEC} />,
    );
    expect(created).toHaveLength(2);
    expect(created[1].paneIndex).toBe(1);
    expect(created[1].setData).toHaveBeenCalledTimes(1); // data re-pushed into the new series
  });

  it('re-pushes data after a chart change re-creates the series (per-view remount)', () => {
    // Regression: /live remounts the lwc chart per (code, timeframe) view
    // (LiveChartRoot's per-viewKey effect). The lifecycle effect re-creates
    // the series on the new chart instance; the data effect must re-run in
    // the same commit (chart is in its deps) or the pane renders blank until
    // the next bundle identity change (up to a 60s refetch on D/W/M).
    const first = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={first.chart} bundle={bundle} axis={axis} paneIndex={1} spec={SPEC} />,
    );
    expect(first.created).toHaveLength(1);

    const second = makeChart();
    rerender(
      <RangeSeriesPane chart={second.chart} bundle={bundle} axis={axis} paneIndex={1} spec={SPEC} />,
    );
    expect(second.created).toHaveLength(1);
    expect(second.created[0].setData).toHaveBeenCalledTimes(1); // data re-pushed into the new chart's series
  });

  it('does NOT re-create the series when only bundle data changes', () => {
    // The MA-edit optimization: data churn must not churn series handles.
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={1} spec={SPEC} />,
    );
    expect(created).toHaveLength(1);
    rerender(
      <RangeSeriesPane chart={chart} bundle={{ candles: [] } as never} axis={axis} paneIndex={1} spec={SPEC} />,
    );
    // New bundle ref → data effect re-runs (setData twice) but series NOT re-created.
    expect(created).toHaveLength(1);
    expect(created[0].setData).toHaveBeenCalledTimes(2);
  });
});
