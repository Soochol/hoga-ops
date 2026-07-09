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
import { classifyDataChange, syncSeriesData } from './seriesDataDiff';
import {
  BrokerLateEntryMarkersPrimitive,
} from './BrokerLateEntryMarkersPrimitive';
import type { BrokerLateEntryMarkerPoint } from './projectors/brokerLateEntryMarkers';
import { SurgeMarkersPrimitive, type SurgeMarkerPoint } from './SurgeMarkersPrimitive';
// Type-only: keeps chart/ free of a runtime dependency on live/ (the
// `onLegend*` callbacks below, like `onPrimarySeriesReady`, hand registration
// to the live-side owner rather than importing the registry here).
import type { PanePrefKey } from '../live/indicators/indicatorPaneProfiles';

/**
 * Legend metadata colocated with a series in its `PaneSpec`. Consumed by the
 * `paneLegendRegistry` → `PaneLegendOverlay`: the label/color/format live with
 * the indicator definition, so adding a pane needs no edit to the legend model.
 */
export type SeriesLegendMeta = {
  /** Cell label, e.g. '매수', '누적'. */
  label: string;
  /** Swatch color thunk (theme-resolved lazily via `resolveTokensThemed` so it
   *  re-reads `var(--…)` after a theme swap). Omit for series with no single
   *  color — per-bar histograms (volume/investor) and the bi-color baseline
   *  (ratio) render no swatch. */
  color?: () => string;
  /** Value formatter; defaults to `formatKoreanInt` at the overlay. */
  format?: (v: number) => string;
};

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
  /**
   * Series creation options. A thunk (`() => options`) is resolved at
   * `addSeries` time, not module load — used by color-bearing specs so a chart
   * created after a theme swap reads the live `var(--…)` values via
   * `resolveTokensThemed`. A plain object is still accepted for static specs.
   */
  options:
    | SeriesPartialOptionsMap[SeriesType]
    | (() => SeriesPartialOptionsMap[SeriesType]);
  data: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => SeriesDataItemTypeMap[SeriesType][];
  /** Optional: markers to overlay on this series, recomputed in the data effect
   *  (same cadence as `data`). Rendered by `SurgeMarkersPrimitive` (a custom
   *  series primitive) rather than lwc's `createSeriesMarkers` — the latter
   *  positions markers via the shared timeScale's logical index, which desyncs
   *  when this series is shorter than the timeScale (sparse past quote_ratio vs
   *  candles). The primitive draws by `timeToCoordinate`, immune to that. */
  markers?: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => SurgeMarkerPoint[];
  /** Optional: labelled late-entry markers drawn by a separate primitive so
   *  surge dots keep their existing renderer and lifecycle. */
  labelMarkers?: (bundle: RangeBundle, axis: VirtualAxis, ctx: Ctx) => BrokerLateEntryMarkerPoint[];
  afterAdd?: (series: ISeriesApi<SeriesType>) => void;
  /** Optional: this series contributes a Pane Legend cell. Registered by the
   *  lifecycle effect via `onLegendReady`; the overlay reads its value back
   *  from the live series (no recompute). Series without it are legend-silent
   *  (overlays, baseline guides). */
  legend?: SeriesLegendMeta;
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
  /** The store toggle this pane's Pane Legend ✕ turns off. Lives at pane
   *  altitude (one indicator = one pane = one off-switch), distinct from the
   *  per-series `legend` cell metadata. Read by the overlay from the pane spec
   *  (static), so no paneId→key switch is needed. */
  legendToggleKey?: PanePrefKey;
  /** Optional Pane Legend title shown before the cells (like MA's '이동평균선'),
   *  disambiguating multi-cell panes whose cell labels repeat across panes
   *  (총잔량 매수/매도 vs 체결강도 매수/매도). Single-cell panes omit it — the
   *  cell label already names the indicator (거래량, 외국인 순매수량). */
  legendTitle?: string;
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
  /** Fired after series creation with the subset of series carrying `legend`
   *  metadata, zipped with their meta. The live-side owner (LiveChartRoot)
   *  registers these in `paneLegendRegistry`; the overlay reads the pane-level
   *  toggle/title from the spec, not here (those are static). Kept as a callback
   *  (not a direct registry import) so chart/ stays free of a runtime dependency
   *  on live/ — same rationale as `onPrimarySeriesReady`. Not fired when no
   *  series declares `legend`. */
  onLegendReady?: (
    paneName: string,
    entries: { series: ISeriesApi<any>; meta: SeriesLegendMeta }[],
  ) => void;
  /** Fired before legend series teardown (unmount / spec change). */
  onLegendGone?: (paneName: string) => void;
  /** Force full replacement instead of tail update. Used where lightweight-
   * charts' incremental update path can leave stale candlestick geometry. */
  forceSetData?: boolean;
  /** When true, create the candle pane primary series after its same-pane
   * overlays so lightweight-charts paints candle bodies on top. */
  candleAlwaysOnTop?: boolean;
  /** Optional caller-owned context for specs whose rendering depends on parent props. */
  contextOverride?: Ctx;
};

function creationOrderForSpec(seriesCount: number, candleAlwaysOnTop: boolean): number[] {
  if (!candleAlwaysOnTop || seriesCount <= 1) {
    return Array.from({ length: seriesCount }, (_, i) => i);
  }
  return [
    ...Array.from({ length: seriesCount - 1 }, (_, i) => i + 1),
    0,
  ];
}

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
  onLegendReady,
  onLegendGone,
  forceSetData = false,
  candleAlwaysOnTop = false,
  contextOverride,
}: Props<Ctx>) {
  // Hook position is stable: PaneSpec is a module-level constant per
  // caller (spec.useContext presence never flips between renders), so
  // this conditional call doesn't violate rules-of-hooks. See PaneSpec
  // JSDoc for the full justification.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const specContext = spec.useContext ? spec.useContext() : (undefined as Ctx);
  const ctx = contextOverride !== undefined ? contextOverride : specContext;
  const seriesRef = useRef<ISeriesApi<any>[]>([]);
  // Last data array pushed to each series (by index). The data effect diffs the
  // new projection against this (classifyDataChange) to decide skip / update(tail)
  // / setData(full). Storing the ARRAY (not a hash) lets the diff do an exact
  // field-wise comparison — no hash-collision freeze risk — and P0's cached past
  // slice is reference-shared across ticks, so the prefix compare short-circuits
  // via `===`. Reset in the lifecycle effect when series are (re)created so a
  // fresh handle always gets a full setData first push.
  const lastDataRef = useRef<(readonly SeriesDataItemTypeMap[SeriesType][] | null)[]>([]);
  // Per-series surge-markers primitive (null for series without a `markers`
  // projector). Attached/detached alongside the series in the lifecycle effect;
  // updated in the data effect via setMarkers (same cadence as data).
  const markersRef = useRef<(SurgeMarkersPrimitive | null)[]>([]);
  // Per-series labelled marker primitive (null for series without a
  // `labelMarkers` projector). Managed independently so surge markers keep
  // their existing primitive and behaviour.
  const labelMarkersRef = useRef<(BrokerLateEntryMarkersPrimitive | null)[]>([]);
  // Lifecycle effect: create LineSeries once per (chart, paneIndex, spec)
  // tuple and tear them down on unmount. Does NOT depend on ctx/bundle/axis,
  // so prefs edits (e.g. Moving Average period bump) don't churn series
  // handles. Without this split, MA edits visibly redraw the entire MA
  // layer because all 5 LineSeries are removed and re-added.
  useEffect(() => {
    const seriesList: ISeriesApi<any>[] = new Array(spec.series.length);
    const creationOrder = creationOrderForSpec(
      spec.series.length,
      candleAlwaysOnTop && spec.name === 'candle',
    );
    creationOrder.forEach((specIndex) => {
      const s = spec.series[specIndex];
      const options = typeof s.options === 'function' ? s.options() : s.options;
      const series = chart.addSeries(s.type, options, paneIndex);
      s.afterAdd?.(series);
      seriesList[specIndex] = series;
    });
    seriesRef.current = seriesList;
    // Fresh handles hold no data — clear cached arrays so the data effect's first
    // run after (re)creation classifies as setData (prev === null) and full-pushes.
    lastDataRef.current = seriesList.map(() => null);
    // Custom surge-markers primitive per series that declares a `markers` projector.
    markersRef.current = spec.series.map((s, i) => {
      if (!s.markers) return null;
      const prim = new SurgeMarkersPrimitive();
      seriesList[i].attachPrimitive(prim);
      return prim;
    });
    labelMarkersRef.current = spec.series.map((s, i) => {
      if (!s.labelMarkers) return null;
      const prim = new BrokerLateEntryMarkersPrimitive();
      seriesList[i].attachPrimitive(prim);
      return prim;
    });
    if (seriesList.length > 0) onPrimarySeriesReady?.(seriesList[0], spec.name);
    // Pane Legend: hand the legend-bearing series (zipped with their meta) to
    // the live-side registry owner. Registration presence == pane mounted, so
    // the legend never re-derives pane visibility from toggle state.
    const legendEntries = spec.series
      .map((s, i) => (s.legend ? { series: seriesList[i], meta: s.legend } : null))
      .filter((e): e is { series: ISeriesApi<any>; meta: SeriesLegendMeta } => e !== null);
    if (legendEntries.length > 0) {
      onLegendReady?.(spec.name, legendEntries);
    }
    return () => {
      if (legendEntries.length > 0) onLegendGone?.(spec.name);
      if (seriesList.length > 0) onPrimarySeriesGone?.(spec.name);
      seriesList.forEach((series, i) => {
        const prim = markersRef.current[i];
        if (prim) {
          try {
            series.detachPrimitive(prim);
          } catch {
            // chart already torn down
          }
        }
        const labelPrim = labelMarkersRef.current[i];
        if (labelPrim) {
          try {
            series.detachPrimitive(labelPrim);
          } catch {
            // chart already torn down
          }
        }
      });
      markersRef.current = [];
      labelMarkersRef.current = [];
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
    // onPrimarySeriesReady / onPrimarySeriesGone / onLegendReady / onLegendGone
    // identities are stable on the parent (ChartStage uses `useCallback`);
    // intentionally excluded from deps so the effect doesn't churn series on
    // callback re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, paneIndex, spec, candleAlwaysOnTop]);

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
      // The decision (skip / update(tail) / setData(full)), the series mutation,
      // and the cache update all live behind syncSeriesData's seam — so the
      // invariant "lastDataRef equals what the series holds" can't drift across
      // this effect. Rationale for the tail-diff (lwc re-ingests + re-autoscales
      // the whole array on every setData, ≈66ms/tick at 90-day deep scroll vs
      // ~1ms for update(tail)) and its safety (update only when exactly
      // equivalent to setData) live in seriesDataDiff.ts.
      if (forceSetData) {
        const decision = classifyDataChange(lastDataRef.current[i] ?? null, data);
        if (decision.kind !== 'skip') {
          seriesList[i].setData(data);
          lastDataRef.current[i] = data;
        }
      } else {
        lastDataRef.current[i] = syncSeriesData(seriesList[i], lastDataRef.current[i] ?? null, data);
      }
      // Markers: order vs setData is irrelevant — SurgeMarkersPrimitive draws by
      // timeToCoordinate at render time, not by a snapshotted series index.
      if (s.markers) markersRef.current[i]?.setMarkers(s.markers(bundle, axis, ctx));
      if (s.labelMarkers) labelMarkersRef.current[i]?.setMarkers(s.labelMarkers(bundle, axis, ctx));
    });
  }, [chart, bundle, axis, ctx, spec, paneIndex, forceSetData]);
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
