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

export type InvestorPaneToggles = { foreignNet: boolean; institutionNet: boolean };

const NO_INVESTOR: InvestorPaneToggles = { foreignNet: false, institutionNet: false };

/**
 * Pick the pane spec list to mount in `LiveChartRoot` for a given
 * **LiveTimeframe**. Minute frames always get the full `PANE_SPECS`; calendar
 * frames (D/W/M) get candle + volume. The opt-in foreign / institution net-buy
 * panes are appended in canonical order — but only on **'D'** (ADR-0055):
 * investor points are daily-anchored (09:00), whereas W/M aggregate candles
 * into week/month segments, so daily points wouldn't align (they'd be filtered
 * by `axis.contains`, rendering a near-empty pane). W/M therefore show no
 * investor pane even with the toggles on.
 *
 * Each individual spec is a module-level constant (stable ref), so when the
 * toggles are unchanged `RangeSeriesPane`'s `spec`-keyed effect doesn't churn.
 * lightweight-charts v5 clamps an out-of-range `paneIndex` to the next slot and
 * auto-removes a pane once its last series is gone, so appending/removing these
 * specs mounts and tears down the panes cleanly; returning canonical order keeps
 * foreign above institution regardless of which toggled on first.
 */
export function paneSpecsForTimeframe(
  tf: LiveTimeframe,
  investor: InvestorPaneToggles = NO_INVESTOR,
): readonly BoundPaneSpec[] {
  if (!isCalendarTimeframe(tf)) return PANE_SPECS;
  // Investor panes are daily-only; W/M aggregate candles so daily points
  // wouldn't align to their segments.
  const investorAllowed = tf === 'D';
  if (!investorAllowed || (!investor.foreignNet && !investor.institutionNet)) {
    return CALENDAR_PANE_SPECS;
  }
  const extra: BoundPaneSpec[] = [];
  if (investor.foreignNet) extra.push(INVESTOR_FOREIGN_SPEC);
  if (investor.institutionNet) extra.push(INVESTOR_INSTITUTION_SPEC);
  return [...CALENDAR_PANE_SPECS, ...extra];
}
