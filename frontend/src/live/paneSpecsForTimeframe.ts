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

// Volume-off variant for calendar frames — frozen once so the returned
// reference stays stable across renders (RangeSeriesPane's spec-keyed effect
// doesn't churn on an unchanged toggle). Dropping the volume pane is safe for
// drawing pane-binding because chartCoordinates now resolves pane index at
// runtime (getPane().paneIndex()), so panes below volume self-correct when it's
// removed.
const CALENDAR_PANE_SPECS_NO_VOLUME: readonly BoundPaneSpec[] = Object.freeze(
  CALENDAR_PANE_SPECS.filter((s) => s.name !== 'volume'),
) as readonly BoundPaneSpec[];

export type PaneToggles = {
  foreignNet: boolean;
  institutionNet: boolean;
  /** Volume pane mount. Omitted/true → mounted; false → removed entirely
   *  (matches the investor panes' on/off behavior, not an empty stripe). */
  volumeEnabled?: boolean;
  /** 총잔량 pane mount. 누락/true → mount; false → 제거. */
  quoteTotalsEnabled?: boolean;
  /** 호가비 pane mount. 누락/true → mount; false → 제거. */
  ratioEnabled?: boolean;
  /** 체결강도 pane mount. 누락/true → mount; false → 제거. */
  fillStrengthEnabled?: boolean;
};

const NO_TOGGLES: PaneToggles = { foreignNet: false, institutionNet: false };

// 분봉 pane 조합 캐시 — 동일 토글 조합은 동일(frozen) 배열을 반환해
// RangeSeriesPane의 spec-keyed reconciliation이 churn하지 않게 한다.
// (반환 배열은 어떤 dep 배열에도 안 들어가 load-bearing은 아니나, 기존
//  frozen 관행과 일관성·미래 방어 목적.)
const minutePaneCache = new Map<string, readonly BoundPaneSpec[]>();

function minutePanes(
  volumeOn: boolean, qtOn: boolean, ratioOn: boolean, fillOn: boolean,
): readonly BoundPaneSpec[] {
  const key = `${volumeOn ? 1 : 0}${qtOn ? 1 : 0}${ratioOn ? 1 : 0}${fillOn ? 1 : 0}`;
  const cached = minutePaneCache.get(key);
  if (cached) return cached;
  const drop = new Set<string>();
  if (!volumeOn) drop.add('volume');
  if (!qtOn) drop.add('quote-totals');
  if (!ratioOn) drop.add('ratio');
  if (!fillOn) drop.add('fill-strength');
  // All panes on → return PANE_SPECS directly to preserve reference identity
  // (existing tests rely on toBe(PANE_SPECS) for the default all-on case).
  const built: readonly BoundPaneSpec[] = drop.size === 0
    ? PANE_SPECS
    : Object.freeze(PANE_SPECS.filter((s) => !drop.has(s.name))) as readonly BoundPaneSpec[];
  minutePaneCache.set(key, built);
  return built;
}

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
    return minutePanes(
      volumeOn,
      toggles.quoteTotalsEnabled !== false,
      toggles.ratioEnabled !== false,
      toggles.fillStrengthEnabled !== false,
    );
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
