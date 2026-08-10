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

/** Default density multiplier (16px root / 16px base intent = 1.0 as of 2026-08-07; was 1.125). */
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
 * (12 × 1.0 → 12 bars as of 2026-08-07; was 14 at the 1.125× dial).
 * `barSpacing` uses default spacing.
 */
export const CHART_TIMESCALE_OPTIONS: DeepPartial<TimeScaleOptions> = {
  rightOffset: Math.round(12 * DENSITY),
  barSpacing: 6,
};

/** Crosshair line widths stay at 1px for sharpness. No scaling. */
export const CHART_CROSSHAIR_LINE_WIDTH = 1;

/**
 * Crosshair behavior + axis-label chip color.
 *
 * `mode`: `Normal` (= 0) lets the crosshair track the actual mouse position;
 * the library default (`Magnet` = 1) snaps the horizontal line to the close of
 * the candle under the cursor, which makes off-candle price readouts feel
 * wrong. We want exact mouse tracking — the price-axis label then reflects the
 * cursor's Y, not a snapped close.
 *
 * `labelBackgroundColor`: this is a FUNCTION, not the `mode`-only constant it
 * used to be, because the chip color must come from the live theme. A module
 * constant resolves once at app boot (see this file's header) and would freeze
 * whichever theme happened to be active then. Callers pass a token resolved at
 * chart-mount time; `LiveChartRoot`'s `viewKey` carries a theme segment, so a
 * theme swap remounts the chart and re-resolves this for free.
 *
 * Why the caller must pass `--accent`: lightweight-charts defaults both labels
 * to `#131722` (TradingView's dark background) regardless of theme. Measured
 * against our chart background that is 1.04:1 on Obsidian and **1.00:1 on Toss
 * Dark** — the chip is literally indistinguishable from the canvas behind it,
 * so the readout reads as bare text floating over the axis ticks. That readout
 * is not decorative: DESIGN.md's 2026-05-23 decision turned OFF
 * `priceLineVisible` / `lastValueVisible` on every series precisely because
 * "analysts read latest values via crosshair", making these labels the only
 * value-readout surface on the chart. `--accent` is the fix DESIGN.md already
 * prescribes — it names crosshair an approved accent context twice (the token
 * table's "UI states only (buttons, focus, crosshair, active tab, primary
 * CTAs)" and the 2026-08-07 entry's "accent 는 솔리드 채움"). Measured chip
 * contrast: Obsidian 10.0:1, Toss Dark 4.8:1, Ledger 5.9:1, Toss Light 3.7:1.
 *
 * ⚠ The label's TEXT color cannot be set — lightweight-charts derives it from
 * the background's grayscale (`.199r + .687g + .114b > 160 ? black : white`).
 * All four theme accents land on the side `--accent-fg` intends, but that is a
 * verified coincidence, not something we control. Changing an accent token
 * means re-checking that threshold.
 *
 * ⚠ Toss themes only: the accent blue sits ΔE 17.3 from `--price-down` blue.
 * DESIGN.md accepts that overlap and its re-review trigger is worded around
 * exactly this surface ("파란 크로스헤어가 파란 하락 잔량 위에 겹쳐 읽기
 * 어려우면"). Before this change the risk was theoretical — nothing on the
 * crosshair was accent-colored. It is now real for the label chips.
 *
 * The crosshair LINE stays on the library default grey (`#9598A1`) — DESIGN.md
 * would put it on accent too, but a brass dashed line spanning the whole chart
 * is a far larger visual change than a chip, so it was deliberately left out of
 * this fix (user decision, 2026-08-10) rather than smuggled in with it.
 *
 * `CHART_CROSSHAIR_LINE_WIDTH` above stays a separate constant; line width
 * lives under the same `vertLine` / `horzLine` subfields but is applied by the
 * drawing layer, not here.
 */
export function chartCrosshairOptions(
  labelBackgroundColor: string,
): DeepPartial<CrosshairOptions> {
  return {
    mode: CrosshairMode.Normal,
    // Both axes, or the fix is half-applied: vertLine carries the TIME axis
    // label, horzLine the PRICE axis label.
    vertLine: { labelBackgroundColor },
    horzLine: { labelBackgroundColor },
  };
}
