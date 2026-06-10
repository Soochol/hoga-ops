import { memo, useEffect, useRef } from 'react';
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
import { classifyDataChange } from './seriesDataDiff';

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
  /** /live bundle-split routing (2026-06-09): `true` = this pane's projectors
   * read SSE-derived hoga series (quote_ratio / fill_strength), so LiveChartRoot
   * feeds it the live `bundle`. Unset/false = candle-path pane fed the stable
   * `chartBundle` (no re-setData on an SSE tick). Inert outside /live. */
  live?: boolean;
};

type Props<Ctx> = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex: number;
  spec: PaneSpec<Ctx>;
  /** Fired after the primary series (spec.series[0]) is added to the chart.
   *  The caller populates its PaneId→ISeriesApi registry that DrawingOverlay
   *  consumes for pane-aware coordinate conversion. `paneName` (= spec.name) is
   *  passed back so the caller can use ONE stable callback for all panes instead
   *  of a per-pane closure — required for React.memo on this component to skip
   *  re-renders when only the live bundle (hoga panes) changed. */
  onPrimarySeriesReady?: (series: ISeriesApi<any>, paneName: string) => void;
  /** Fired right before the primary series is removed from the chart
   *  (component unmount or spec change). `paneName` = spec.name (see above). */
  onPrimarySeriesGone?: (paneName: string) => void;
};

/**
 * RangeSeriesPane — the deep module that owns chart-pane lifecycle for
 * any indicator derived from a RangeBundle. See CONTEXT.md
 * "RangeSeriesPane" for the architectural intent and
 * docs/superpowers/specs/2026-05-23-range-series-pane-design.md for the
 * full design.
 */
function RangeSeriesPaneInner<Ctx>({
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
  // Last data array pushed to each series (by index). The data effect diffs the
  // new projection against this (classifyDataChange) to decide skip / update(tail)
  // / setData(full). Storing the ARRAY (not a hash) lets the diff do an exact
  // field-wise comparison — no hash-collision freeze risk — and P0's cached past
  // slice is reference-shared across ticks, so the prefix compare short-circuits
  // via `===`. Reset in the lifecycle effect when series are (re)created so a
  // fresh handle always gets a full setData first push.
  const lastDataRef = useRef<(readonly SeriesDataItemTypeMap[SeriesType][] | null)[]>([]);
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
    // Fresh handles hold no data — clear cached arrays so the data effect's first
    // run after (re)creation classifies as setData (prev === null) and full-pushes.
    lastDataRef.current = seriesList.map(() => null);
    if (seriesList.length > 0) onPrimarySeriesReady?.(seriesList[0], spec.name);
    return () => {
      if (seriesList.length > 0) onPrimarySeriesGone?.(spec.name);
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
      // Diff the new projection against the last push to avoid a full setData
      // when only the live tail changed. lwc re-ingests + re-autoscales the
      // whole array on every setData (measured: 6 series × 35k points ≈ 66ms
      // synchronous JS/tick at 90-day deep scroll), so on a live tick that only
      // mutates today's last bucket we call series.update(tail) instead (~1ms).
      // classifyDataChange falls back to setData on ANY earlier-element change —
      // auction-mask retroactive recolor, day-boundary anchors, pan/timeframe/ctx
      // change — so update() is only ever used when it is exactly equivalent to
      // setData. An identical re-projection (timeframe-switch render churn) is a
      // 'skip'.
      const decision = classifyDataChange(lastDataRef.current[i] ?? null, data);
      if (decision.kind === 'skip') return;
      if (decision.kind === 'update') seriesList[i].update(decision.point);
      else seriesList[i].setData(data);
      lastDataRef.current[i] = data;
    });
  }, [chart, bundle, axis, ctx, spec, paneIndex]);
  return null;
}

/** Memoised (2026-06-09 bundle-split, Phase B): skips re-render when props are
 * shallow-equal. On /live a candle/volume pane is fed the STABLE `chartBundle`
 * + stable axis + stable callbacks, so an SSE tick (which only changes the hoga
 * panes' `bundle`) no longer re-renders the candle panes via the parent. Hoga
 * panes still re-render (their `bundle` prop changes). The
 * `as typeof RangeSeriesPaneInner` cast restores the generic call signature that
 * React.memo's type drops. */
const RangeSeriesPane = memo(RangeSeriesPaneInner) as typeof RangeSeriesPaneInner;
export default RangeSeriesPane;
