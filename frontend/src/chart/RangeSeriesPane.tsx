import { useEffect, useRef } from 'react';
import {
  type IChartApi,
  type ISeriesApi,
  type SeriesDataItemTypeMap,
  type SeriesDefinition,
  type SeriesPartialOptionsMap,
  type SeriesType,
} from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { type VirtualAxis } from '../util/virtualAxis';

/**
 * One series inside a `PaneSpec`. Each field is typed to the lightweight-charts
 * series vocabulary rather than `any`: `type` must be a real `SeriesDefinition`,
 * `options` real series options, and `data` must return real series data items
 * (`SeriesDataItemTypeMap` entries) — not arbitrary objects.
 *
 * The per-entry `type`↔`data` correlation is deliberately NOT encoded as a
 * discriminated `SeriesSpec<T>`: every `SeriesDataItemTypeMap[T]` includes the
 * minimal `WhitespaceData` (`{ time }`), and OHLC/value items are structural
 * supersets of it, so a `SeriesSpec<'Histogram'>` cannot actually reject a
 * candle-shaped projector — the same "catches nothing" trap the audit flagged
 * for the `defineSeries<T>` factory (verified: a deliberate
 * Candlestick-series-with-value-data spec still type-checked under the union).
 * The real guard lives one level down — each projector annotates its concrete
 * return (`projectCandle(): CandlestickData<Time>[]`, …), so a wrong-shaped
 * item fails TS2353 at the projector, where the literal is fresh.
 */
export type SeriesSpec<Ctx = void> = {
  type: SeriesDefinition<SeriesType>;
  options: SeriesPartialOptionsMap[SeriesType];
  data: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => SeriesDataItemTypeMap[SeriesType][];
  afterAdd?: (series: ISeriesApi<SeriesType>) => void;
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
 * Content signature for a projected series-data array, used to skip a
 * `setData` call whose result is identical to the last one already pushed to
 * that series (see the data effect below). Folds length + every item's
 * time and primary value (close → value → high) into one int32 — O(n), but
 * the projection that produced `data` is already O(n), so this adds no order.
 *
 * Why it MUST hash the whole array (not just first/last): a live tick mutates
 * only the last bar (same time, new close), which length+endpoints would
 * catch — but a partial-bar correction or a mid-array fill would slip through
 * a first/last-only check and freeze the chart. Hashing every item's value
 * means any genuine change re-pushes, while a byte-identical re-render (the
 * churn this guards against) matches and is skipped.
 */
function seriesDataSignature(data: readonly SeriesDataItemTypeMap[SeriesType][]): string {
  let h = 0;
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as { time?: unknown; close?: number; value?: number; high?: number };
    const t = typeof item.time === 'number' ? item.time : 0;
    const v = item.close ?? item.value ?? item.high ?? 0;
    h = (Math.imul(h, 31) + t + (v | 0)) | 0;
  }
  return `${data.length}:${h}`;
}

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
  // Signature of the last data array pushed to each series (by index). Lets the
  // data effect skip a redundant setData whose projected result is identical to
  // what the series already holds — the parent re-renders ~24× during a
  // timeframe switch (a fresh `bundle` object each time, same `bundle.candles`
  // reference), and lightweight-charts re-runs price autoscale + viewport
  // settle on EVERY setData, so those identical re-pushes visibly re-fit the
  // chart after the reveal cover has lifted. Reset in the lifecycle effect when
  // the series are (re)created so a fresh handle always gets its first push.
  const lastSigRef = useRef<(string | null)[]>([]);
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
    // Fresh handles hold no data — clear cached signatures so the data effect's
    // first run after (re)creation always pushes (null !== any real signature).
    lastSigRef.current = seriesList.map(() => null);
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
  //
  // `paneIndex` and `chart` are in the deps because the lifecycle effect
  // above RE-CREATES the series when either changes (a pane toggled off
  // above this one shifts its index; /live remounts the chart instance per
  // (code, timeframe) view — see LiveChartRoot's per-viewKey effect). The
  // fresh series starts empty, so the data must be re-pushed in the same
  // commit — otherwise the pane renders blank until the next bundle
  // identity change (up to a 60s refetch on D/W/M).
  useEffect(() => {
    const seriesList = seriesRef.current;
    if (seriesList.length !== spec.series.length) return;
    spec.series.forEach((s, i) => {
      const data = s.data(bundle, axis, ctx);
      // Skip a setData whose result is byte-identical to the last push: lwc
      // re-autoscales the price axis and re-settles the viewport on every
      // setData, so a redundant identical push (the timeframe-switch render
      // churn) would visibly re-fit the chart. A live tick changes the last
      // bar → its signature changes → it still flows through.
      const sig = seriesDataSignature(data);
      if (lastSigRef.current[i] === sig) return;
      lastSigRef.current[i] = sig;
      seriesList[i].setData(data);
    });
  }, [chart, bundle, axis, ctx, spec, paneIndex]);
  return null;
}
