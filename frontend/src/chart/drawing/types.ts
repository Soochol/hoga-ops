// frontend/src/chart/drawing/types.ts

/**
 * Drawing primitive types. All time coordinates are real Unix-ms (UTC) —
 * NOT virtual-ms from the Virtual Axis — so drawings remain valid across
 * different Stock-Date Range loads of the same Code (see ADR-0024 and
 * the design spec).
 */

export type Point = {
  /** Real Unix-ms (UTC), per ADR-0003. */
  realMs: number;
  /** Price in KRW. */
  price: number;
};

export type DrawingId = string;

export type DrawingKind = 'hline' | 'trendline' | 'pencil';

export type DrawingTool = 'select' | 'hline' | 'trendline' | 'pencil' | 'eraser';

interface DrawingBase {
  id: DrawingId;
  /** Stroke color. v1 always references the accent token via util/tokens. */
  color: string;
  /** Stroke width in CSS pixels. v1 fixed to 1.5. */
  width: number;
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
