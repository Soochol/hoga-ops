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

export type DrawingKind = 'hline' | 'trendline' | 'pencil';

export type DrawingTool = 'select' | 'hline' | 'trendline' | 'pencil' | 'eraser';

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

export interface Trendline extends DrawingBase {
  kind: 'trendline';
  a: Point;
  b: Point;
}

export interface Pencil extends DrawingBase {
  kind: 'pencil';
  /** >= 2 points. Capped at PENCIL_MAX_POINTS during capture. */
  points: Point[];
}

export type Drawing = Hline | Trendline | Pencil;

/** Hard cap on pencil points to keep one drawing under ~250KB serialized. */
export const PENCIL_MAX_POINTS = 5000;

/** Hit-test thresholds in canvas-space pixels. */
export const HIT_THRESHOLD = {
  hline: 6,
  trendlineBody: 8,
  trendlineHandle: 6,
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
};

/** Seed used when no persisted defaults exist. Teal accent, integer-step
 *  2 px, solid. */
export const INITIAL_DEFAULTS: DrawingDefaults = {
  color: '#14B8A6',
  width: 2,
  lineStyle: 'solid',
};
