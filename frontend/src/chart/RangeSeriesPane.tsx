import { useEffect } from 'react';
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
}: Props<Ctx>) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const ctx = spec.useContext ? spec.useContext() : (undefined as Ctx);
  useEffect(() => {
    const seriesList: ISeriesApi<any>[] = spec.series.map((s) => {
      const series = chart.addSeries(s.type, s.options, paneIndex);
      s.afterAdd?.(series);
      series.setData(s.data(bundle, axis, ctx));
      return series;
    });
    return () => {
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
    };
  }, [chart, bundle, axis, paneIndex, spec, ctx]);
  return null;
}
