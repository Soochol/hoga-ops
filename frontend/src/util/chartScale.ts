/**
 * Static chart option overrides for the default density.
 *
 * Why this module exists: `lightweight-charts` renders to `<canvas>` and
 * its layout/text options do not inherit from CSS. The CSS single-dial
 * (`:root font-size`, mirrored by RENDERED_ROOT_PX in design-tokens.ts)
 * does not reach the canvas. Most constants below derive from
 * RENDERED_ROOT_PX so a dial change propagates here automatically —
 * but charts read them at mount, so density changes still need a chart
 * remount. See DESIGN.md "Scale Factor" for the intentional scope
 * limitation.
 *
 * Exception: `CHART_LAYOUT_OPTIONS.fontSize` is pinned, not derived — see the
 * note on that constant.
 */
import { CrosshairMode } from 'lightweight-charts';
import type {
  CrosshairOptions,
  DeepPartial,
  LayoutOptions,
  TimeScaleOptions,
} from 'lightweight-charts';
import { CANVAS_FONT_STACK, RENDERED_ROOT_PX } from '../styles/design-tokens';

/** Default density multiplier (18px root / 16px base intent = 1.125). */
const DENSITY = RENDERED_ROOT_PX / 16;

/**
 * Canvas text options for the chart.
 *
 * `fontFamily` must be set explicitly — omitting it leaves lightweight-charts on
 * its own default stack (`-apple-system, …, Roboto, Ubuntu, sans-serif`), which
 * is how the price/time axis kept rendering in the OS font through two app-wide
 * font migrations.
 *
 * `fontSize` deliberately stays at the library default 12 — NOT the
 * density-derived `Math.round(12 * DENSITY)` = 14 this module would otherwise
 * imply. Reason: until 2026-07-21 this whole object was spread at the wrong
 * nesting level and silently ignored, so 12 is what the product has always
 * actually shipped. Switching to 14 coarsens the price-axis tick grid
 * (5,000원 → 10,000원 steps), which is a density decision, not a font one —
 * deferred to its own A/B rather than smuggled in with a typeface change.
 * See DESIGN.md "Scale Factor" for why the canvas sits outside the dial.
 */
export const CHART_LAYOUT_OPTIONS: DeepPartial<LayoutOptions> = {
  fontSize: 12,
  fontFamily: CANVAS_FONT_STACK,
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
