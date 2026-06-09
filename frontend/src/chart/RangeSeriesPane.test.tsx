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

// Projects candle rows so a test can vary the setData RESULT via the bundle.
// The production bug: a new bundle object carrying identical candles re-ran
// setData; the fix skips it by content signature.
type CandleBundle = { candles: Array<{ time: number; close: number }> };
const PROJECT_SPEC: PaneSpec = {
  name: 'candle',
  stretch: 1,
  series: [
    {
      type: {} as never,
      options: {} as never,
      data: (b) => (b as unknown as CandleBundle).candles.map((c) => ({ time: c.time, close: c.close })) as never,
    },
  ],
};
const candleBundle = (rows: Array<{ time: number; close: number }>) => ({ candles: rows }) as never;

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
    // New bundle ref → data effect re-runs, but series NOT re-created.
    expect(created).toHaveLength(1);
  });

  it('SKIPS a redundant setData when the projected data is unchanged', () => {
    // /live remounts + re-renders ~24× during a timeframe switch, handing down a
    // fresh `bundle` object each time while `bundle.candles` stays identical.
    // lwc re-runs price autoscale + viewport settle on EVERY setData, so those
    // identical re-pushes visibly re-fit the chart after the reveal cover lifts.
    // The data effect must skip a push whose result matches the last one.
    const { chart, created } = makeChart();
    const rows = [{ time: 1, close: 100 }, { time: 2, close: 110 }];
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={candleBundle(rows)} axis={axis} paneIndex={1} spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1); // initial push
    // New bundle OBJECT, identical candle CONTENT → setData must be skipped.
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([...rows])} axis={axis} paneIndex={1} spec={PROJECT_SPEC} />,
    );
    expect(created).toHaveLength(1); // series not re-created
    expect(created[0].setData).toHaveBeenCalledTimes(1); // redundant push SKIPPED
  });

  it('re-pushes when the last bar changes (live tick) — not over-skipping', () => {
    // Safety: a live tick mutates the last bar (same time, new close). Its
    // signature changes, so the push MUST flow through — over-aggressive
    // skipping would freeze the chart mid-session.
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 100 }])} axis={axis} paneIndex={1} spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1);
    // Last bar's close changed → new content → must re-push.
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 105 }])} axis={axis} paneIndex={1} spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(2);
    // A new bar appended → length changed → must re-push.
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 105 }, { time: 2, close: 108 }])} axis={axis} paneIndex={1} spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(3);
  });
});
