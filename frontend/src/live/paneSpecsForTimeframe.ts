import { type LiveTimeframe, isCalendarTimeframe } from '../state/livePage';
import { PANE_SPECS, type BoundPaneSpec } from '../chart/paneSpecs';
import { CANDLE_SPEC } from '../chart/projectors/candle';
import { VOLUME_SPEC } from '../chart/projectors/volume';
import {
  INVESTOR_FOREIGN_SPEC,
  INVESTOR_INSTITUTION_SPEC,
} from '../chart/projectors/investorNet';

/**
 * Module-frozen "calendar" pane set: D/W/M timeframes mount only candle +
 * volume because the three hoga panes (RatioPane, QuoteTotalsPane,
 * FillStrength) have no source data outside the minute timeframes — `/live`
 * never calls `/api/range` for D/W/M (see useLiveBundle's `enableRange`
 * gate). Empty stripes squeezed the candle pane vertically; removing them
 * also restores the candle's apparent horizontal width under `fitContent`.
 *
 * See ADR-0041 — `/live` calendar timeframes mount candle + volume only.
 */
const CALENDAR_PANE_SPECS: readonly BoundPaneSpec[] = Object.freeze([
  CANDLE_SPEC,
  VOLUME_SPEC,
]) as readonly BoundPaneSpec[];

// Volume-off variants, frozen once so the returned reference stays stable
// across renders (RangeSeriesPane's spec-keyed effect doesn't churn on an
// unchanged toggle). Dropping the volume pane is safe for drawing pane-binding
// because chartCoordinates now resolves pane index at runtime (getPane().
// paneIndex()), so panes below volume self-correct when it's removed.
const PANE_SPECS_NO_VOLUME: readonly BoundPaneSpec[] = Object.freeze(
  PANE_SPECS.filter((s) => s.name !== 'volume'),
) as readonly BoundPaneSpec[];
const CALENDAR_PANE_SPECS_NO_VOLUME: readonly BoundPaneSpec[] = Object.freeze(
  CALENDAR_PANE_SPECS.filter((s) => s.name !== 'volume'),
) as readonly BoundPaneSpec[];

export type PaneToggles = {
  foreignNet: boolean;
  institutionNet: boolean;
  /** Volume pane mount. Omitted/true → mounted; false → removed entirely
   *  (matches the investor panes' on/off behavior, not an empty stripe). */
  volumeEnabled?: boolean;
};

const NO_TOGGLES: PaneToggles = { foreignNet: false, institutionNet: false };

/**
 * Pick the pane spec list to mount in `LiveChartRoot` for a given
 * **LiveTimeframe**. Minute frames always get `PANE_SPECS`; calendar frames
 * (D/W/M) get candle + volume. Two opt-in adjustments:
 *
 *  - `volumeEnabled === false` removes the volume pane on every timeframe
 *    (the popover ✕ / toggle should hide the pane, not leave an empty stripe).
 *  - foreign / institution net-buy panes are appended in canonical order, but
 *    only on **'D'** (ADR-0055): investor points are daily-anchored (09:00),
 *    whereas W/M aggregate candles into week/month segments, so daily points
 *    wouldn't align (they'd be filtered by `axis.contains`).
 *
 * Each spec is a module-level constant (stable ref) and the four base arrays
 * are frozen, so an unchanged toggle returns the SAME array reference and
 * `RangeSeriesPane`'s `spec`-keyed effect doesn't churn. lightweight-charts v5
 * clamps an out-of-range `paneIndex` and auto-removes a pane once its last
 * series is gone, so appending/removing specs mounts and tears down panes
 * cleanly; canonical order keeps volume above the investor panes regardless of
 * toggle order.
 */
export function paneSpecsForTimeframe(
  tf: LiveTimeframe,
  toggles: PaneToggles = NO_TOGGLES,
): readonly BoundPaneSpec[] {
  const volumeOn = toggles.volumeEnabled !== false; // default true
  if (!isCalendarTimeframe(tf)) {
    return volumeOn ? PANE_SPECS : PANE_SPECS_NO_VOLUME;
  }
  const base = volumeOn ? CALENDAR_PANE_SPECS : CALENDAR_PANE_SPECS_NO_VOLUME;
  // Investor panes are daily-only; W/M aggregate candles so daily points
  // wouldn't align to their segments.
  const investorAllowed = tf === 'D';
  if (!investorAllowed || (!toggles.foreignNet && !toggles.institutionNet)) {
    return base;
  }
  const extra: BoundPaneSpec[] = [];
  if (toggles.foreignNet) extra.push(INVESTOR_FOREIGN_SPEC);
  if (toggles.institutionNet) extra.push(INVESTOR_INSTITUTION_SPEC);
  return [...base, ...extra];
}
