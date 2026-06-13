import { type LiveTimeframe, isCalendarTimeframe } from '../state/livePage';
import { PANE_SPECS, type BoundPaneSpec } from '../chart/paneSpecs';
import {
  INVESTOR_FOREIGN_SPEC,
  INVESTOR_INSTITUTION_SPEC,
} from '../chart/projectors/investorNet';

/** Indicator toggles that gate which panes mount. The two investor flags are
 *  required (default off); the rest are optional and default ON when omitted
 *  (volume + the three hoga panes were always-on before they became togglable). */
export type PaneToggles = {
  foreignNet: boolean;
  institutionNet: boolean;
  volumeEnabled?: boolean;
  quoteTotalsEnabled?: boolean;
  ratioEnabled?: boolean;
  fillStrengthEnabled?: boolean;
};

const NO_TOGGLES: PaneToggles = { foreignNet: false, institutionNet: false };

const isMinute = (tf: LiveTimeframe): boolean => !isCalendarTimeframe(tf);

/** A pane's mount gate: does this pane mount at this timeframe under these
 *  toggles? */
type PaneGate = (tf: LiveTimeframe, t: PaneToggles) => boolean;

/**
 * Declarative gate per pane — the single source of "which panes, gated how".
 * Adding a togglable pane = its `PANE_SPECS` entry (or an append in `GATED`) +
 * one gate here; no `PaneToggles` plumbing branch, no hand-built cache key.
 *
 * The two domain rules are gates, not control flow:
 *  - **Calendar/minute split (ADR-0041)**: the three hoga panes have no source
 *    data on D/W/M (`/live` never calls `/api/range` there), so they gate on
 *    `isMinute`. Candle + volume carry no timeframe gate.
 *  - **Investor panes are D-only (ADR-0055)**: daily-anchored points (09:00)
 *    wouldn't align to W/M aggregate segments, so they gate on `tf === 'D'`.
 *
 * Unlisted panes (candle) default to always-on.
 */
const GATE_BY_NAME: Partial<Record<string, PaneGate>> = {
  volume: (_tf, t) => t.volumeEnabled !== false,
  'quote-totals': (tf, t) => isMinute(tf) && t.quoteTotalsEnabled !== false,
  ratio: (tf, t) => isMinute(tf) && t.ratioEnabled !== false,
  'fill-strength': (tf, t) => isMinute(tf) && t.fillStrengthEnabled !== false,
};

/**
 * The ordered candidate list: canonical `PANE_SPECS` plus the investor panes
 * appended in canonical order (foreign before institution). `paneSpecsForTimeframe`
 * keeps a pane iff its gate passes — gating, not membership, decides what mounts,
 * so canonical order is preserved with no hole left by an absent pane.
 */
const GATED: ReadonlyArray<{ spec: BoundPaneSpec; gate: PaneGate }> = [
  ...PANE_SPECS.map((spec) => ({ spec, gate: GATE_BY_NAME[spec.name] ?? ((): boolean => true) })),
  { spec: INVESTOR_FOREIGN_SPEC, gate: (tf, t): boolean => tf === 'D' && t.foreignNet },
  { spec: INVESTOR_INSTITUTION_SPEC, gate: (tf, t): boolean => tf === 'D' && t.institutionNet },
];

/**
 * Reference-stability cache keyed by the actual output determinant — the set
 * of kept pane names. Same kept set → same frozen array, so `RangeSeriesPane`'s
 * spec-keyed reconciliation doesn't churn. The key is DERIVED from the kept
 * specs (not hand-built from toggle bits), so a new pane or toggle can never
 * silently collide on a stale key. The all-base (minute, all-on) entry is
 * seeded with `PANE_SPECS` itself so that common case keeps `=== PANE_SPECS`
 * identity (callers/tests rely on it).
 */
const ALL_BASE_KEY = PANE_SPECS.map((s) => s.name).join(',');
const paneCache = new Map<string, readonly BoundPaneSpec[]>([[ALL_BASE_KEY, PANE_SPECS]]);

/**
 * Pick the pane spec list to mount in `LiveChartRoot` for a given
 * **LiveTimeframe** + indicator toggles. Each pane's gate decides whether it
 * mounts; the result is memoized by its kept-name set.
 */
export function paneSpecsForTimeframe(
  tf: LiveTimeframe,
  toggles: PaneToggles = NO_TOGGLES,
): readonly BoundPaneSpec[] {
  const kept = GATED.filter((g) => g.gate(tf, toggles)).map((g) => g.spec);
  const key = kept.map((s) => s.name).join(',');
  const cached = paneCache.get(key);
  if (cached) return cached;
  const frozen = Object.freeze(kept) as readonly BoundPaneSpec[];
  paneCache.set(key, frozen);
  return frozen;
}
