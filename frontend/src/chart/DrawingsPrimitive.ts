// frontend/src/chart/DrawingsPrimitive.ts
//
// Drawings rendered INSIDE the lightweight-charts render pipeline, one
// primitive per pane.
//
// Why this exists: the drawing layer used to own a DOM canvas that repainted
// from `subscribeVisibleLogicalRangeChange` → `requestAnimationFrame`. That
// delegate fires from inside lwc's own rAF callback, and a rAF scheduled from
// within a rAF callback lands on the NEXT frame — so drawings were always
// exactly one frame behind the candles (measured: 18.4–20.2ms). Panning made
// freehand pencil strokes visibly lag the bars they were drawn against.
//
// A pane primitive is drawn by lwc itself, in the same frame as the series, so
// the lag is structurally impossible rather than merely small.
//
// Coordinates: this canvas IS the pane, so Y is PANE-LOCAL — `priceToCoordinate`
// is used raw, with no `paneTopY` compensation. The DOM overlay that still
// handles pointer input keeps working in chart-global space; `ProjectCtx` is
// the seam that lets one renderer serve both. See drawing/render.ts.

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { VirtualAxis } from '../util/virtualAxis';
import {
  barPitchPx,
  realMsToCanvasX,
  realMsToCanvasXClamped,
  type FutureBand,
} from './drawing/chartCoordinates';
import {
  renderDrawing,
  renderAlignGuides,
  renderGhostPreview,
  renderHlinePriceBadge,
  renderMeasureDraft,
  renderRectDraft,
  renderTrendlineDraft,
  type GhostPreview,
  type ProjectCtx,
} from './drawing/render';
import type { Drawing, DrawingStyle, Hline, PaneId } from './drawing/types';
import type { AlignGuide } from './drawing/alignSnap';
import type {
  MeasureDraft,
  PencilDraft,
  RectDraft,
  TrendlineDraft,
} from './drawing/tools';

/** Everything the renderer needs for one frame. */
export type DrawingsSnapshot = {
  drawings: readonly Drawing[];
  /** 선택 멤버십. 오버레이가 선택 배열에서 파생해 넘긴다 — 이 getter 는 lwc 의
   *  draw 마다(팬 × 팬 수) 불리므로 여기서 Set 을 만들면 안 된다. */
  selectedIds: ReadonlySet<string>;
  /** 끝점·모서리 핸들을 그릴 도형. **단일 선택일 때만** non-null — 다중에서
   *  핸들이 뜨면 핸들 드래그와 그룹 이동이 같은 픽셀에서 경합한다. */
  handlesId: string | null;
  /** Hidden layer — draw nothing (drafts included; no gesture runs while hidden). */
  hiddenAll: boolean;
  axis: VirtualAxis;
  future?: FutureBand;
  bucketMs?: number;
  lastRealMs?: number;
  /** The loaded bars, for the measure readout's column count. Carried as data
   *  (like `axis` / `bucketMs`) rather than as a prebuilt domain so the renderer
   *  keeps deriving its own — one definition of "one column", shared with the
   *  drag. See DragBarDomain. */
  candles?: readonly { ts_ms: number }[];
  /** In-flight creation gestures. Live on refs in the overlay, so they change
   *  without a React render — hence the pull-based source below. */
  drafts: {
    trendline: TrendlineDraft | null;
    rect: RectDraft | null;
    measure: MeasureDraft | null;
    pencil: PencilDraft | null;
  };
  draftStyles: {
    trendline: DrawingStyle;
    rect: DrawingStyle;
    pencil: DrawingStyle;
  };
  ghost: GhostPreview | null;
  /**
   * Alignment guides for the in-flight drag, plus the color to draw them in
   * (the dragged shape's own — see `renderAlignGuides`). Null while nothing is
   * snapping. Lives on a ref like the drafts above: it changes at pointer
   * cadence, not at React's.
   */
  alignGuides: { guides: readonly AlignGuide[]; color: string } | null;
  /**
   * Called at the end of each pane's draw, inside lwc's frame. Lets the overlay
   * reposition DOM it anchors to chart coordinates (the text editor) in the
   * SAME frame the candles move — React never re-renders during a pan, so a
   * render-time computation would leave that DOM frozen in place.
   *
   * Must be idempotent: every mounted pane's primitive calls it once per frame.
   * Recomputing the same transform 2–3 times is cheaper than the bookkeeping
   * needed to elect a single caller.
   */
  onFrame?: () => void;
  /** Pane that owns the vline time badge — the bottom-most mounted pane. A
   *  vline is drawn by every pane's primitive, but its badge docks to the
   *  bottom of the STACK and must appear exactly once. Recomputed as panes are
   *  toggled, so ownership follows the bottom pane. */
  timeBadgePaneId?: PaneId | null;
};

/**
 * Pull-based source. The overlay hands over a getter rather than pushing a
 * snapshot because drafts and the cursor ghost mutate on refs at pointer
 * cadence: pushing would mean a setter call per pointermove, and any missed
 * push would render a stale stroke. The getter is read at draw time, so the
 * frame always sees current state.
 */
export type DrawingsSource = () => DrawingsSnapshot | null;

class DrawingsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: DrawingsPrimitive;

  constructor(source: DrawingsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    const snap = this._source.snapshot();
    if (!chart || !series || snap === null) return;

    const paneId = this._source.paneId();

    // Media (CSS-pixel) space, not bitmap: the whole drawing renderer — font
    // sizes, stroke widths, badge padding — is written in CSS pixels, and
    // lwc's media scope applies the device-pixel transform for us. Rewriting
    // 600 lines of renderer into bitmap coordinates would risk regressions for
    // no gain.
    // Hidden layer: skip the canvas work, but still run onFrame — the text
    // editor is DOM and stays visible even while drawings are hidden, so it
    // must keep tracking its anchor.
    if (snap.hiddenAll) {
      snap.onFrame?.();
      return;
    }

    target.useMediaCoordinateSpace((scope) => {
      const c = scope.context;
      const ctx: ProjectCtx = {
        realMsToX: (ms) => realMsToCanvasX(chart, snap.axis, ms, snap.future),
        realMsToXClamped: (ms) => realMsToCanvasXClamped(chart, snap.axis, ms, snap.future),
        // Pane-local: lwc v5 returns pane-local Y here and this canvas is the
        // pane, so there is nothing to offset.
        priceToY: (price) => {
          const y = series.priceToCoordinate(price);
          return y == null ? null : Number(y);
        },
        width: scope.mediaSize.width,
        paneBottom: scope.mediaSize.height,
        paneId,
        axis: snap.axis,
        bucketMs: snap.bucketMs,
        lastRealMs: snap.lastRealMs,
        candles: snap.candles,
        // Read once per frame, not once per point: `logicalToCoordinate` is a
        // model call, and a pencil stroke can carry thousands of vertices.
        barPx: barPitchPx(chart) ?? undefined,
      };

      // Two passes so vlines stay on top of everything else, matching the
      // draw order the single-canvas overlay had.
      for (const d of snap.drawings) {
        if (d.kind === 'vline' || d.paneId !== paneId) continue;
        renderDrawing(c, ctx, d, snap.selectedIds.has(d.id), { handles: d.id === snap.handlesId });
      }
      for (const d of snap.drawings) {
        // A vline spans every pane, so every pane's primitive draws it —
        // including panes it did not originate on. That also preserves the old
        // behaviour where a vline survives its origin pane being toggled off.
        if (d.kind !== 'vline') continue;
        renderDrawing(c, ctx, d, snap.selectedIds.has(d.id), {
          vlineTimeBadge: snap.timeBadgePaneId == null || snap.timeBadgePaneId === paneId,
          handles: d.id === snap.handlesId,
        });
      }

      const { trendline, rect, measure, pencil } = snap.drafts;
      if (trendline?.b && trendline.paneId === paneId) {
        renderTrendlineDraft(c, ctx, trendline, snap.draftStyles.trendline);
      }
      if (rect?.b && rect.paneId === paneId) {
        renderRectDraft(c, ctx, rect.a, rect.b, snap.draftStyles.rect);
      }
      if (measure?.b && measure.paneId === paneId) {
        renderMeasureDraft(c, ctx, measure.a, measure.b);
      }
      if (pencil && pencil.paneId === paneId && pencil.points.length >= 2) {
        renderDrawing(
          c,
          ctx,
          {
            id: '__draft__',
            kind: 'pencil',
            points: pencil.points,
            // Preview must use the same sub-bar offsets the commit will store,
            // or the stroke renders on the bar grid and visibly snaps sideways
            // the moment the pointer lifts.
            subX: pencil.subX,
            color: snap.draftStyles.pencil.color,
            width: snap.draftStyles.pencil.width,
            lineStyle: snap.draftStyles.pencil.lineStyle,
            paneId: pencil.paneId,
          },
          false,
        );
      }

      if (snap.ghost) renderGhostPreview(c, ctx, snap.ghost);
      // Last, so a guide is never buried under the shapes it measures.
      if (snap.alignGuides) {
        renderAlignGuides(c, ctx, snap.alignGuides.guides, snap.alignGuides.color);
      }
    });

    // Outside the coordinate scope: this repositions DOM, not canvas.
    snap.onFrame?.();
  }
}

/**
 * The price-axis column is its own canvas, so an hline's price badge — which
 * has always been drawn ON the axis, TradingView-style — needs a renderer
 * there. Y is the same pane-local coordinate as the plot area; only the width
 * differs (the axis column, ~58px), which the badge's right-inset math already
 * keys off. The hline itself now stops at the plot edge.
 */
class DrawingsPriceAxisRenderer implements IPrimitivePaneRenderer {
  private readonly _source: DrawingsPrimitive;

  constructor(source: DrawingsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const series = this._source.seriesApi();
    const snap = this._source.snapshot();
    if (!series || snap === null || snap.hiddenAll) return;

    const paneId = this._source.paneId();
    const hlines = snap.drawings.filter(
      (d): d is Hline => d.kind === 'hline' && d.paneId === paneId,
    );
    if (hlines.length === 0) return;

    target.useMediaCoordinateSpace((scope) => {
      const c = scope.context;
      const ctx: ProjectCtx = {
        // No time axis on the price-axis canvas — a badge never needs X.
        realMsToX: () => null,
        realMsToXClamped: () => null,
        priceToY: (price) => {
          const y = series.priceToCoordinate(price);
          return y == null ? null : Number(y);
        },
        width: scope.mediaSize.width,
        paneBottom: scope.mediaSize.height,
        paneId,
        axis: snap.axis,
        bucketMs: snap.bucketMs,
        lastRealMs: snap.lastRealMs,
      };
      for (const h of hlines) {
        renderHlinePriceBadge(c, ctx, h, snap.selectedIds.has(h.id));
      }
    });
  }
}

class DrawingsPriceAxisPaneView implements IPrimitivePaneView {
  private readonly _source: DrawingsPrimitive;
  private readonly _renderer: DrawingsPriceAxisRenderer;

  constructor(source: DrawingsPrimitive) {
    this._source = source;
    this._renderer = new DrawingsPriceAxisRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._source.zOrder();
  }
}

class DrawingsPaneView implements IPrimitivePaneView {
  private readonly _source: DrawingsPrimitive;
  private readonly _renderer: DrawingsRenderer;

  constructor(source: DrawingsPrimitive) {
    this._source = source;
    this._renderer = new DrawingsRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._source.zOrder();
  }
}

export type DrawingsPrimitiveOptions = {
  /** Defaults to 'top' — drawings annotate the candles, so they sit above them. */
  zOrder?: PrimitivePaneViewZOrder;
};

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private _source: DrawingsSource | null = null;
  private readonly _paneId: PaneId;
  private readonly _zOrder: PrimitivePaneViewZOrder;
  private readonly _paneView: DrawingsPaneView;
  private readonly _priceAxisPaneView: DrawingsPriceAxisPaneView;

  constructor(paneId: PaneId, options: DrawingsPrimitiveOptions = {}) {
    this._paneId = paneId;
    this._zOrder = options.zOrder ?? 'top';
    this._paneView = new DrawingsPaneView(this);
    this._priceAxisPaneView = new DrawingsPriceAxisPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = undefined;
  }

  updateAllViews(): void {
    // The pane view reads the source directly at draw time — nothing to cache.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return [this._priceAxisPaneView];
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }

  paneId(): PaneId {
    return this._paneId;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._zOrder;
  }

  snapshot(): DrawingsSnapshot | null {
    return this._source?.() ?? null;
  }

  setSource(source: DrawingsSource | null): void {
    this._source = source;
    this._requestUpdate?.();
  }

  /** Ask lwc for a repaint — used when a draft or the cursor ghost mutates on
   *  a ref, which React never sees. */
  requestUpdate(): void {
    this._requestUpdate?.();
  }
}
