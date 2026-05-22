/**
 * Static chart option overrides for the 1.25× default density.
 *
 * Why this module exists: `lightweight-charts` renders to `<canvas>` and
 * its layout/text options do not inherit from CSS. The CSS single-dial
 * (`:root font-size: 20px`) does not reach the canvas. These constants
 * keep all charts visually aligned with the rest of the UI at the current
 * default density.
 *
 * Future density modes: if `:root font-size` changes, the values below
 * must be updated alongside. See DESIGN.md "Scale Factor" for the
 * intentional scope limitation.
 */
import type { DeepPartial, LayoutOptions, TimeScaleOptions } from 'lightweight-charts';

/** Library default font is 12; we use 15 (= 12 × 1.25). */
export const CHART_LAYOUT_OPTIONS: DeepPartial<LayoutOptions> = {
  fontSize: 15,
};

/**
 * `rightOffset` scaled 1.25× from library default (12 → 15).
 * `barSpacing` scaled 1.25× from library default (6 → 7.5, rounded up to 8).
 */
export const CHART_TIMESCALE_OPTIONS: DeepPartial<TimeScaleOptions> = {
  rightOffset: 15,
  barSpacing: 8,
};

/** Crosshair line widths stay at 1px for sharpness. No scaling. */
export const CHART_CROSSHAIR_LINE_WIDTH = 1;
