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

export type DrawingDefaults = {
  color: string;
  width: number;
  lineStyle: LineStyle;
  /** Sticky font size (CSS px) for new text labels. Separate from `width` so a
   *  size pick never leaks into stroke-tool defaults (and vice versa); it
   *  propagates alongside the style fields so the last-used size carries over. */
  fontSize: number;
  /** Magnet mode — snap creation/handle drags to the nearest candle. Session
   *  preference persisted alongside style defaults; NOT a per-drawing field, so
   *  it never propagates through the style whitelist. */
  magnet: boolean;
  /** Hide all drawings without deleting them (rail eye toggle). */
  hiddenAll: boolean;
};

/** Seed used when no persisted defaults exist. Teal accent, integer-step
 *  2 px, solid, 13px text, magnet off, all visible. */
export const INITIAL_DEFAULTS: DrawingDefaults = {
  color: '#14B8A6',
  width: 2,
  lineStyle: 'solid',
  fontSize: TEXT_DEFAULT_FONT_SIZE,
  magnet: false,
  hiddenAll: false,
};
