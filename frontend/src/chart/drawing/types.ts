// frontend/src/chart/drawing/types.ts

/**
 * Drawing primitive types. All time coordinates are real Unix-ms (UTC) —
 * NOT virtual-ms from the Virtual Axis — so drawings remain valid across
 * different Stock-Date Range loads of the same Code (see ADR-0024 and
 * the design spec).
 *
 * Every Drawing is bound to one chart pane via `paneId`. The id mirrors
 * `PaneSpec.name` and is the stable persistence key — see ADR-0028.
 */

export type Point = {
  /** Real Unix-ms (UTC), per ADR-0003. */
  realMs: number;
  /** Value on the pane's Y-domain. KRW on candle, share count on volume,
   *  signed -1..1 on ratio, etc. */
  price: number;
};

export type DrawingId = string;

export type DrawingKind =
  | 'hline'
  | 'vline'
  | 'trendline'
  | 'rect'
  | 'measure'
  | 'text'
  | 'pencil';

export type DrawingTool =
  | 'select'
  | 'hline'
  | 'vline'
  | 'trendline'
  | 'rect'
  | 'measure'
  | 'text'
  | 'pencil'
  | 'eraser';

/** Narrow a tool to a drawable kind — everything except the non-drawing modes
 *  (select / eraser). Used to pick the per-kind style slot for the active tool. */
export function isDrawingKind(tool: DrawingTool): tool is DrawingKind {
  return tool !== 'select' && tool !== 'eraser';
}

/** Stable identifier for a chart pane. Mirrors `PaneSpec.name`. Renaming
 *  any literal here is a breaking change — strands every user's saved
 *  drawings bound to that name. See ADR-0028. */
export type PaneId =
  | 'candle'
  | 'volume'
  | 'ratio'
  | 'quote-totals'
  | 'fill-strength'
  | 'program-trade'
  | 'investor-foreign'
  | 'investor-institution';

interface DrawingBase {
  id: DrawingId;
  /** Stroke color as hex string. */
  color: string;
  /** Stroke width in CSS pixels. */
  width: number;
  /** Line style (solid, dashed, or dotted). */
  lineStyle: LineStyle;
  /** Pane this drawing belongs to. Required. See ADR-0028. */
  paneId: PaneId;
}

export interface Hline extends DrawingBase {
  kind: 'hline';
  /** The single price level. Renders as a horizontal line spanning the canvas. */
  price: number;
}

export interface Vline extends DrawingBase {
  kind: 'vline';
  /** The single time level (real Unix-ms). Renders as a vertical line spanning
   *  every mounted pane — time is shared across panes, so unlike other shapes
   *  vline is NOT clipped to `paneId`. `paneId` is retained (the pane it was
   *  created in) only for schema uniformity; render and hit-test ignore it. */
  realMs: number;
}

export interface Trendline extends DrawingBase {
  kind: 'trendline';
  a: Point;
  b: Point;
}

export interface Rect extends DrawingBase {
  kind: 'rect';
  /** Opposite corners. Rendered/hit-tested after min/max normalization, so the
   *  two corners may be stored in any order (a handle drag can cross them). */
  a: Point;
  b: Point;
  /** Fill alpha 0..1. 0 = outline only. Not a sticky default (excluded from the
   *  DrawingDefaults propagation whitelist), so it never leaks to other kinds. */
  fillOpacity: number;
}

export interface Measure extends DrawingBase {
  kind: 'measure';
  /** Diagonal corners of the measured region. Renders as a shaded box plus a
   *  Δprice / Δ% / Δtime / bar-count readout. Same 2-point model as Trendline,
   *  so it reuses the endpoint-handle drag path. */
  a: Point;
  b: Point;
}

export interface Text extends DrawingBase {
  kind: 'text';
  /** Anchor (top-left of the text box). */
  at: Point;
  /** The label content. Empty strings are never committed. */
  text: string;
  /** Font size in CSS px. `width`/`lineStyle` are unused for text (the panel
   *  hides them); a dedicated field avoids overloading `width` and leaking a
   *  font size into other kinds' sticky stroke defaults. */
  fontSize: number;
}

export interface Pencil extends DrawingBase {
  kind: 'pencil';
  /** >= 2 points. Capped at PENCIL_MAX_POINTS during capture. */
  points: Point[];
  /**
   * Sub-bar horizontal offset per point, as a FRACTION OF ONE BAR'S WIDTH
   * (typically -0.5..+0.5). Parallel to `points`; index i belongs to
   * `points[i]`. Absent (or a shorter array) → 0, which is exactly the
   * pre-subX behaviour, so old strokes keep rendering unchanged.
   *
   * Why this exists: `points[i].realMs` can only ever name a BAR. Capture goes
   * through `timeScale().coordinateToTime`, which is `Math.ceil` on the float
   * bar index — so a freehand stroke's X collapses onto the bar grid and the
   * curve renders as a staircase whose step equals the bar pitch (measured:
   * 15.8px zoomed out, 28.2px zoomed in). The residual pixel offset the anchor
   * threw away is kept here and re-added at projection time
   * (`x = realMsToX(realMs) + subX[i] * barPx`).
   *
   * Stored as a bar fraction rather than raw pixels because pixels are only
   * meaningful at the zoom level that captured them; a fraction of a bar is
   * scale-invariant and survives zoom, pan, and a timeframe switch inside the
   * same slot (1m↔30m share one storage slot — see `DrawingSlot`).
   *
   * ⚠ NOT applicable to the other kinds. hline/vline/trendline/rect/measure/
   * text anchor to bars deliberately (a trendline endpoint on a candle is the
   * point), and magnet snapping reinforces that. Pencil is the one tool whose
   * whole value is the shape between bars, and the one tool that opts out of
   * magnet (see DrawingOverlay's `buildCtx`).
   */
  subX?: number[];
}

/**
 * Pixel offset that re-adds what bar-anchoring threw away for `points[i]`.
 * Zero for a stroke without `subX`, for an index past the array's end, for a
 * non-finite entry, and whenever the bar pitch is unknown — every one of those
 * degrades to the bar-anchored X, never to a wrong one.
 *
 * Lives here, not in the renderer, because render AND hit-test both call it
 * and they MUST agree: a disagreement makes a stroke grabbable somewhere other
 * than where it is drawn. (`hitTest.ts` is deliberately dependency-light — it
 * imports only this module — so the shared piece has to sit at that level.)
 */
export function subBarOffsetPx(p: Pencil, i: number, barPx: number | undefined): number {
  if (barPx == null || !Number.isFinite(barPx)) return 0;
  const sub = p.subX?.[i];
  return typeof sub === 'number' && Number.isFinite(sub) ? sub * barPx : 0;
}

export type Drawing = Hline | Vline | Trendline | Rect | Measure | Text | Pencil;

/** Default fill alpha for a freshly-created rectangle. */
export const RECT_DEFAULT_FILL_OPACITY = 0.1;
/** Selectable fill-opacity steps shown in the property panel for a rect. */
export const RECT_FILL_OPACITIES = [0, 0.1, 0.2, 0.35] as const;

/** Default font size (CSS px) for a freshly-created text label. */
export const TEXT_DEFAULT_FONT_SIZE = 13;
/** Selectable font-size steps shown in the property panel for a text label. */
export const TEXT_FONT_SIZES = [11, 13, 16, 20, 24] as const;

/** Hard cap on pencil points to keep one drawing under ~250KB serialized. */
export const PENCIL_MAX_POINTS = 5000;

/** Hit-test thresholds in canvas-space pixels. */
export const HIT_THRESHOLD = {
  hline: 6,
  vline: 6,
  trendlineBody: 8,
  trendlineHandle: 6,
  rectBorder: 6,
  rectHandle: 6,
  measureBorder: 6,
  measureHandle: 6,
  pencil: 8,
} as const;

export type LineStyle = 'solid' | 'dashed' | 'dotted';

export const STROKE_WIDTHS = [1, 2, 3, 4, 5] as const;
export const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;

/**
 * Sixteen-colour palette for user-authored Drawings. A fourth "user
 * annotation layer" category alongside DESIGN.md's three system / status /
 * market-direction categories — distinct because annotations are user
 * content, not system chrome. See ADR-0032.
 */
export const COLOR_PALETTE = [
  '#14B8A6', '#10B981', '#F43F5E', '#F59E0B',
  '#EF4444', '#F97316', '#EAB308', '#84CC16',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899',
  '#FFFFFF', '#9CA3AF', '#4B5563', '#1F2937',
] as const;

/** The last-used sticky style for ONE drawing tool (kind). Uniform shape across
 *  every kind so `styleByKind` is a plain `Record` — `fontSize` is only
 *  meaningful for `text` and `fillOpacity` only for `rect`, but every slot
 *  carries both so the type stays flat and the propagation whitelist is a single
 *  field list regardless of which kind was edited. */
export type DrawingStyle = {
  color: string;
  width: number;
  lineStyle: LineStyle;
  /** Sticky font size (CSS px) for new text labels. Lives in the per-kind slot
   *  so a size pick on a text label never leaks into a stroke tool's defaults. */
  fontSize: number;
  /** Sticky fill alpha 0..1 for new rectangles. Per-kind, so a fill pick on a
   *  rect never touches another tool's style. */
  fillOpacity: number;
};

/** Sticky drawing defaults. Style is now kept PER TOOL (kind): picking red on a
 *  trendline no longer recolors the next rectangle — each tool remembers its own
 *  last-used color / width / lineStyle (+ fontSize for text, fillOpacity for
 *  rect). `magnet` / `hiddenAll` stay session-global (they are not styles), so
 *  they never live inside a per-kind slot. See ADR-0032 / drawing-tools notes. */
export type DrawingDefaults = {
  /** One `DrawingStyle` per drawable kind. */
  styleByKind: Record<DrawingKind, DrawingStyle>;
  /** Magnet mode — snap creation/handle drags to the nearest candle. Session
   *  preference persisted alongside style defaults; NOT a per-drawing field. */
  magnet: boolean;
  /** Hide all drawings without deleting them (rail eye toggle). */
  hiddenAll: boolean;
};

/** Seed for one kind's slot: teal accent, integer-step 2 px, solid, 13px text,
 *  10% fill. */
export const INITIAL_STYLE: DrawingStyle = {
  color: '#14B8A6',
  width: 2,
  lineStyle: 'solid',
  fontSize: TEXT_DEFAULT_FONT_SIZE,
  fillOpacity: RECT_DEFAULT_FILL_OPACITY,
};

/** Every drawable kind, seeded with a fresh copy of `INITIAL_STYLE`. Single
 *  source of truth for "which kinds have a style slot". */
export function initialStyleByKind(): Record<DrawingKind, DrawingStyle> {
  return {
    hline: { ...INITIAL_STYLE },
    vline: { ...INITIAL_STYLE },
    trendline: { ...INITIAL_STYLE },
    rect: { ...INITIAL_STYLE },
    measure: { ...INITIAL_STYLE },
    text: { ...INITIAL_STYLE },
    pencil: { ...INITIAL_STYLE },
  };
}

/** Seed used when no persisted defaults exist. Every tool starts identical;
 *  magnet off, all visible. */
export const INITIAL_DEFAULTS: DrawingDefaults = {
  styleByKind: initialStyleByKind(),
  magnet: false,
  hiddenAll: false,
};
