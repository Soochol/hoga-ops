import { type LiveTimeframe, isCalendarTimeframe } from '../state/livePage';
import { PANE_SPECS, type BoundPaneSpec } from '../chart/paneSpecs';
import { CANDLE_SPEC } from '../chart/projectors/candle';
import { VOLUME_SPEC } from '../chart/projectors/volume';

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

/**
 * Pick the pane spec list to mount in `LiveChartRoot` for a given
 * **LiveTimeframe**. Returns the same array reference across calls (so the
 * `RangeSeriesPane` useEffect deps that include `spec` don't churn).
 */
export function paneSpecsForTimeframe(tf: LiveTimeframe): readonly BoundPaneSpec[] {
  return isCalendarTimeframe(tf) ? CALENDAR_PANE_SPECS : PANE_SPECS;
}
