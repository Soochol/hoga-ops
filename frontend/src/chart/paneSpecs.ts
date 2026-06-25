import type { PaneSpec } from './RangeSeriesPane';
import type { PaneId } from './drawing/types';
import { CANDLE_SPEC } from './projectors/candle';
import { VOLUME_SPEC } from './projectors/volume';
import { RATIO_SPEC } from './projectors/ratio';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';
import { PROGRAM_TRADE_SPEC } from './projectors/programTrade';

/**
 * A `PaneSpec` whose `name` is a typed `PaneId` literal. Members of
 * `PANE_SPECS` must satisfy this — it makes the ADR-0028 "stable
 * persistence id" invariant mechanically enforced by the type system
 * rather than relying on social convention.
 *
 * Specs that mount inside an existing pane (candle-pane overlays etc.)
 * remain plain `PaneSpec` because their `name` is not a persistence key.
 */
export type BoundPaneSpec<Ctx = any> = PaneSpec<Ctx> & { name: PaneId };

/**
 * Master registry of `PaneSpec`s rendered by ChartStage in paneIndex
 * order. `setStretchFactor(spec.stretch)` is applied after mount.
 *
 * Index = paneIndex. Reordering this array reorders chart panes;
 * lightweight-charts v5 auto-clamps a requested `paneIndex` to the
 * next-available index, so the ordering invariant lives in this
 * array's position, not in JSX.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  STABLE PERSISTENCE IDS — DO NOT RENAME a spec's `name`
 * ──────────────────────────────────────────────────────────────────────
 * Each spec's `name` is the stable persistence key under which user
 * Drawings store their pane binding (see `drawing/types.ts::PaneId` and
 * ADR-0028). The `BoundPaneSpec` type above makes this mechanical:
 * renaming a spec to a string outside the `PaneId` union fails to
 * compile here. Reordering this array is safe (drawings reference by
 * name, not index). Adding a new pane: append a new literal to
 * `PaneId` in types.ts and use it as the `name` of the new spec.
 */
export const PANE_SPECS: BoundPaneSpec[] = [
  CANDLE_SPEC,         // paneIndex 0
  VOLUME_SPEC,         // paneIndex 1
  QUOTE_TOTALS_SPEC,   // paneIndex 2
  RATIO_SPEC,          // paneIndex 3
  FILL_STRENGTH_SPEC,  // paneIndex 4
  PROGRAM_TRADE_SPEC,  // paneIndex 5
];

export const PANE_STRETCH = PANE_SPECS.map((s) => s.stretch);
