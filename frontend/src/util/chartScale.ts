/**
 * Static chart option overrides for the default density.
 *
 * Why this module exists: `lightweight-charts` renders to `<canvas>` and
 * its layout/text options do not inherit from CSS. The CSS single-dial
 * (`:root font-size`, mirrored by RENDERED_ROOT_PX in design-tokens.ts)
 * does not reach the canvas. The constants below derive from
 * RENDERED_ROOT_PX so a dial change propagates here automatically —
 * but charts read them at mount, so density changes still need a chart
 * remount. See DESIGN.md "Scale Factor" for the intentional scope
 * limitation.
 */
import { CrosshairMode } from 'lightweight-charts';
import type {
  CrosshairOptions,
  DeepPartial,
  LayoutOptions,
  TimeScaleOptions,
} from 'lightweight-charts';
import { RENDERED_ROOT_PX } from '../styles/design-tokens';

/** Default density multiplier (18px root / 16px base intent = 1.125). */
const DENSITY = RENDERED_ROOT_PX / 16;

/** Library default font is 12; scaled by the density dial (12 × 1.125 → 14). */
export const CHART_LAYOUT_OPTIONS: DeepPartial<LayoutOptions> = {
  fontSize: Math.round(12 * DENSITY),
};

/**
 * `rightOffset` scales from the library default 12 with the dial
 * (12 × 1.125 → 14 bars). `barSpacing` uses default spacing.
 */
export const CHART_TIMESCALE_OPTIONS: DeepPartial<TimeScaleOptions> = {
  rightOffset: Math.round(12 * DENSITY),
  barSpacing: 6,
};

/** Crosshair line widths stay at 1px for sharpness. No scaling. */
export const CHART_CROSSHAIR_LINE_WIDTH = 1;

/**
 * Crosshair behavior. `Normal` (= 0) lets the crosshair track the actual
 * mouse position; the library default (`Magnet` = 1) snaps the horizontal
 * line to the close of the candle under the cursor, which makes off-candle
 * price readouts feel wrong. We want exact mouse tracking — the price-axis
 * label then reflects the cursor's Y, not a snapped close.
 *
 * `CHART_CROSSHAIR_LINE_WIDTH` above stays a separate constant; line width
 * lives under `crosshair.vertLine` / `crosshair.horzLine` subfields and is
 * not part of this `mode`-only override.
 */
export const CHART_CROSSHAIR_OPTIONS: DeepPartial<CrosshairOptions> = {
  mode: CrosshairMode.Normal,
};
