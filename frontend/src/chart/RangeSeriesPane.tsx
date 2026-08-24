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
import { priceScaleIdForGroupMember } from './paneGroups';
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
  /** `/live` 번들 분리(2026-06-09) 라우팅 — **이 pane 이 어느 그릇을 받는가**.
   *
   * 종전엔 `live?: boolean` 이었는데 표현력이 모자라, 정작 어느 pane 이 호가 그릇인지
   * ratio 그릇인지는 `LiveChartRoot` 가 `spec.name` 으로 다시 분기해야 했다. 그릇을
   * 여기서 **선언**하면 새 pane 을 추가할 때 그 파일 한 칸으로 정해진다.
   *
   * 어느 값을 쓸지는 이 pane 의 projector 가 읽는 슬라이스의 `todaySource` 로 정한다
   * (`frontend/src/api/rangeSlices.ts`) — `'bundle'` 인 슬라이스를 읽으면 캔들 그릇으로는
   * 조용히 과거분만 얻는다.
   *
   * - `candle`(기본) — 안정 참조 `chartBundle`. SSE 틱에 re-setData 가 없다.
   * - `hoga` — 호가 pane 그릇(`quote_ratio`·`fill_strength` 를 읽는 pane).
   * - `ratio` — 호가비 pane 그릇(호가 그릇 위에 ratio 전용 폴백이 한 겹 더 있다).
   * - `live` — 라이브 성분이 얹힌 전체 번들.
   *
   * `/live` 밖에서는 무의미하다(단일 번들만 넘어온다). */
  bundleKind?: PaneBundleKind;
};

/** pane 이 받을 번들의 종류. 위 `PaneSpec.bundleKind` 주석 참조. */
export type PaneBundleKind = 'candle' | 'hoga' | 'ratio' | 'live';

type Props<Ctx> = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneIndex: number;
  /** 이 pane **앞에** 놓인 pane 이름들의 시퀀스(`'candle|volume'`). lifecycle effect
   *  의 dep 이며, 값 자체는 본문에서 쓰지 않는다.
   *
   *  왜 필요한가 — lightweight-charts 는 pane 의 **마지막 series 를 지우면 그 pane 을
   *  자동 삭제**하고 아래 pane 들의 인덱스를 당긴다(lwc 5.2.0 실측). React 는 한
   *  커밋에서 **모든 cleanup 을 먼저** 돌리므로, 재생성되는 pane 들이 전부 비워진
   *  뒤에야 `addSeries(..., paneIndex)` 가 실행된다. 이때 재생성에 참여하지 **않은**
   *  아래쪽 pane 은 이미 위로 밀려 있어서, 새 series 가 그 pane 안으로 합쳐진다.
   *
   *  순서 바꾸기(#1381 후속)가 정확히 그 경우였다 — 두 pane 을 맞바꾸면 그 **아래**
   *  pane 은 `paneIndex` 가 그대로라 effect 가 안 돌고, 결과적으로 pane 하나가
   *  통째로 사라졌다(실측 5→4, 새로고침해야 복구). 앞 시퀀스를 dep 으로 두면 "밑에서
   *  인덱스가 밀리는" pane 이 **정확히** 전부 참여하고, 그 집합은 항상 연속된
   *  suffix 라 teardown 후 오름차순 append 로 재구성된다(최초 마운트와 같은 경로).
   *
   *  캔들은 앞 시퀀스가 항상 `''` 이라 특수 케이스 없이 재생성에서 빠진다. */
  precedingPaneKey: string;
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
  /** pane 병합: 이 pane(= `paneIndex`)에 함께 사는 지표들의 PaneId 목록(자기 포함,
   *  그룹 순서 그대로). 2개 이상이면 비대표 멤버(첫 항목이 아닌 것)의 시리즈를
   *  멤버별 숨은 스케일로 격리한다(`priceScaleIdForGroupMember` — 공유 화이트리스트
   *  포함). 생략/싱글턴이면 스펙의 원래 스케일 그대로.
   *
   *  ⚠ identity 가 dep 이다 — 호출자는 구성이 같은 한 같은 배열을 넘겨야 한다
   *  (`paneGroupSpecs.paneGroupIds` 가 그 캐시를 소유). 구성이 바뀌면 이 pane 의
   *  전 시리즈가 재생성되는데, 그때 아래쪽 pane 들은 `precedingPaneKey` 로 함께
   *  재생성에 참여한다(그룹 구성이 그 키에 들어간다). */
  groupPaneIds?: readonly string[];
  /** 이 그룹의 **유효** y축 공유(`resolveAxisShared` — 수동 오버라이드 반영).
   *  생략 시 화이트리스트 기본값. `groupPaneIds` 와 같은 dep 규율 — 플립되면 이
   *  pane 의 전 시리즈가 재생성되고, 아래 pane 은 `precedingPaneKey`(구성에 공유
   *  플래그 포함)로 함께 참여한다. */
  groupAxisShared?: boolean;
  /** Optional caller-owned context for specs whose rendering depends on parent props. */
  contextOverride?: Ctx;
};

/** 병합 pane 의 시리즈 옵션에 스케일 격리를 적용한다(리매핑 없으면 원본 그대로).
 *  'right' 만이 아니라 오버레이('') id 도 리매핑 대상이다 — lwc 는 같은 id 를 같은
 *  스케일로 합치므로, 두 멤버의 누적선이 둘 다 '' 면 오토스케일을 나눠 갖는다. */
function withGroupPriceScale(
  options: SeriesPartialOptionsMap[SeriesType],
  paneName: string,
  groupPaneIds: readonly string[] | undefined,
  groupAxisShared: boolean | undefined,
): SeriesPartialOptionsMap[SeriesType] {
  if (!groupPaneIds || groupPaneIds.length <= 1) return options;
  const original = (options as { priceScaleId?: string }).priceScaleId ?? 'right';
  const mapped = groupAxisShared === undefined
    ? priceScaleIdForGroupMember(groupPaneIds, paneName, original)
    : priceScaleIdForGroupMember(groupPaneIds, paneName, original, groupAxisShared);
  return mapped === null ? options : { ...options, priceScaleId: mapped };
}

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
  precedingPaneKey,
  spec,
  onPrimarySeriesReady,
  onPrimarySeriesGone,
  onLegendReady,
  onLegendGone,
  forceSetData = false,
  candleAlwaysOnTop = false,
  groupPaneIds,
  groupAxisShared,
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
      const options = withGroupPriceScale(
        typeof s.options === 'function' ? s.options() : s.options,
        spec.name,
        groupPaneIds,
        groupAxisShared,
      );
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
  }, [chart, paneIndex, precedingPaneKey, spec, candleAlwaysOnTop, groupPaneIds, groupAxisShared]);

  // Data effect: push new projected data into existing series whenever
  // bundle/axis/ctx changes. Cheap (setData on a held handle), so it's
  // fine to run on every render where any of those changes.
  //
  // ⚠ **위 lifecycle effect 의 dep 은 하나도 빠짐없이 여기에도 있어야 한다.**
  // 그 effect 가 series 를 **재생성**하면 새 핸들은 비어 있으므로, 같은 커밋에서
  // 데이터를 다시 밀지 않으면 pane 이 **빈 채로 남는다** — 다음 bundle 식별자 변경
  // (D/W/M 은 최대 60초 refetch)까지. 에러도 경고도 없고 화면만 비므로 조용하다.
  //
  // 한쪽에만 dep 을 추가하는 것이 이 파일의 반복 실패 유형이다. 실제로 두 건:
  //   · `precedingPaneKey` — 순서 바꾸기에서 **아래쪽** pane(자기 `paneIndex` 는
  //     그대로라 오직 이 키로만 재생성에 참여한다)이 데이터를 못 받아 빈 pane 이
  //     됐다. 실측: 이동 1회로 아래 두 pane 이 1776건 → 0건.
  //   · `candleAlwaysOnTop` — 같은 구멍(캔들 pane 전용).
  // dep 을 lifecycle 쪽에 추가하면 **여기도 같이** 추가할 것.
  //
  // (`chart` 는 /live 가 (code, timeframe) 뷰마다 차트를 다시 만들기 때문에,
  //  `paneIndex` 는 위쪽 pane 이 꺼지면 인덱스가 밀리기 때문에 각각 dep 이다.)
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
  }, [chart, bundle, axis, ctx, spec, paneIndex, precedingPaneKey, candleAlwaysOnTop, groupPaneIds, groupAxisShared, forceSetData]);
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
