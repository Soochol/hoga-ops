import type { PaneSpec } from './RangeSeriesPane';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { VOLUME_SPEC } from './projectors/volume';

/**
 * Master registry of `PaneSpec`s rendered by ChartStage in paneIndex
 * order. `setStretchFactor(spec.stretch)` is applied after mount.
 *
 * Index = paneIndex. Reordering this array reorders chart panes;
 * lightweight-charts v5 auto-clamps a requested `paneIndex` to the
 * next-available index, so the ordering invariant lives in this
 * array's position, not in JSX.
 *
 * Migration is in progress (spec docs/superpowers/specs/2026-05-23-range-series-pane-design.md):
 * panes flip from hand-mounted components to RangeSeriesPane+spec one
 * commit at a time. Until the migration completes, this registry is
 * partial and ChartStage uses explicit `paneIndex` props on each
 * `<RangeSeriesPane>` rather than reading positions from this array.
 */
export const PANE_SPECS: PaneSpec<any>[] = [
  // pane 0 (candle) — still hand-mounted
  VOLUME_SPEC,
  // pane 2 (ratio) — still hand-mounted
  QUOTE_TOTALS_SPEC,
  // pane 4 (fill-strength) — still hand-mounted
];
