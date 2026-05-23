import type { PaneSpec } from './RangeSeriesPane';
import { CANDLE_SPEC } from './projectors/candle';
import { VOLUME_SPEC } from './projectors/volume';
import { RATIO_SPEC } from './projectors/ratio';
import { QUOTE_TOTALS_SPEC } from './projectors/quoteTotals';
import { FILL_STRENGTH_SPEC } from './projectors/fillStrength';

/**
 * Master registry of `PaneSpec`s rendered by ChartStage in paneIndex
 * order. `setStretchFactor(spec.stretch)` is applied after mount.
 *
 * Index = paneIndex. Reordering this array reorders chart panes;
 * lightweight-charts v5 auto-clamps a requested `paneIndex` to the
 * next-available index, so the ordering invariant lives in this
 * array's position, not in JSX.
 */
export const PANE_SPECS: PaneSpec<any>[] = [
  CANDLE_SPEC,         // paneIndex 0
  VOLUME_SPEC,         // paneIndex 1
  RATIO_SPEC,          // paneIndex 2
  QUOTE_TOTALS_SPEC,   // paneIndex 3
  FILL_STRENGTH_SPEC,  // paneIndex 4
];

export const PANE_STRETCH = PANE_SPECS.map((s) => s.stretch);
