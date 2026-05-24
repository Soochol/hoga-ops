import { useEffect, useRef } from 'react';
import { type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';

/**
 * One series inside a `PaneSpec`. Carries the lightweight-charts
 * SeriesDefinition + options plus a pure `data` projector and an optional
 * `afterAdd` hook (e.g. `series.createPriceLine` for `RATIO_SPEC`'s
 * zero-baseline reference).
 */
export type SeriesSpec<Ctx = void> = {
  type: any;
  options: any;
  data: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => any[];
  afterAdd?: (series: ISeriesApi<any>) => void;
};

/**
 * Declarative description of one chart pane: its slot name (= `data-pane`
 * attr), its stretch factor for `setStretchFactor`, its series, and an
 * optional context-providing hook. `useContext` is called once per render
 * by `RangeSeriesPane`; its result is passed to every series' `data`
 * projector. Specs without per-render context omit `useContext`.
 *
 * Rules-of-hooks: callers MUST keep each PaneSpec as a module-level
 * constant. The conditional `useContext` call below is stable per
 * component instance because `spec` is referentially stable.
 */
export type PaneSpec<Ctx = void> = {
  name: string;
  stretch: number;
  series: SeriesSpec<Ctx>[];
  useContext?: () => Ctx;
};

type Props<Ctx> = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex: number;
  spec: PaneSpec<Ctx>;
  /** Fired after the primary series (spec.series[0]) is added to the chart.
   *  ChartStage uses this to populate its PaneId→ISeriesApi registry that
   *  DrawingOverlay consumes for pane-aware coordinate conversion. */
  onPrimarySeriesReady?: (series: ISeriesApi<any>) => void;
  /** Fired right before the primary series is removed from the chart
   *  (component unmount or spec change). */
  onPrimarySeriesGone?: () => void;
};

/**
 * RangeSeriesPane — the deep module that owns chart-pane lifecycle for
 * any indicator derived from a RangeBundle. See CONTEXT.md
 * "RangeSeriesPane" for the architectural intent and
 * docs/superpowers/specs/2026-05-23-range-series-pane-design.md for the
 * full design.
 */
export default function RangeSeriesPane<Ctx>({
  chart,
  bundle,
  axis,
  paneIndex,
  spec,
  onPrimarySeriesReady,
  onPrimarySeriesGone,
}: Props<Ctx>) {
  // Hook position is stable: PaneSpec is a module-level constant per
  // caller (spec.useContext presence never flips between renders), so
  // this conditional call doesn't violate rules-of-hooks. See PaneSpec
  // JSDoc for the full justification.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const ctx = spec.useContext ? spec.useContext() : (undefined as Ctx);
  const seriesRef = useRef<ISeriesApi<any>[]>([]);
  // Lifecycle effect: create LineSeries once per (chart, paneIndex, spec)
  // tuple and tear them down on unmount. Does NOT depend on ctx/bundle/axis,
  // so prefs edits (e.g. Moving Average period bump) don't churn series
  // handles. Without this split, MA edits visibly redraw the entire MA
  // layer because all 5 LineSeries are removed and re-added.
  useEffect(() => {
    const seriesList: ISeriesApi<any>[] = spec.series.map((s) => {
      const series = chart.addSeries(s.type, s.options, paneIndex);
      s.afterAdd?.(series);
      return series;
    });
    seriesRef.current = seriesList;
    if (seriesList.length > 0) onPrimarySeriesReady?.(seriesList[0]);
    return () => {
      if (seriesList.length > 0) onPrimarySeriesGone?.();
      // Guard: when a sibling pane throws and ChartErrorBoundary unmounts
      // ChartStage, the parent's chart.remove() may run before this
      // cleanup, leaving the series handle dangling. lightweight-charts
      // then throws "Value is undefined" inside removeSeries. Centralised
      // here so the five former pane components no longer each maintain
      // the same try/catch.
      for (const series of seriesList) {
        try {
          chart.removeSeries(series);
        } catch {
          // chart already torn down
        }
      }
      seriesRef.current = [];
    };
    // onPrimarySeriesReady / onPrimarySeriesGone identities are stable on
    // the parent (ChartStage uses `useCallback`); intentionally excluded
    // from deps so the effect doesn't churn series on callback re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, paneIndex, spec]);

  // Data effect: push new projected data into existing series whenever
  // bundle/axis/ctx changes. Cheap (setData on a held handle), so it's
  // fine to run on every render where any of those changes.
  useEffect(() => {
    const seriesList = seriesRef.current;
    if (seriesList.length !== spec.series.length) return;
    spec.series.forEach((s, i) => {
      seriesList[i].setData(s.data(bundle, axis, ctx));
    });
  }, [bundle, axis, ctx, spec]);
  return null;
}
