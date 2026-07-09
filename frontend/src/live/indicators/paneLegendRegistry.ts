import { create } from 'zustand';
import type { ISeriesApi } from 'lightweight-charts';
import type { PaneId } from '../../chart/drawing/types';
import type { SeriesLegendMeta } from '../../chart/RangeSeriesPane';

/** One legend cell bound to a live chart series: the series handle plus its
 *  colocated `SeriesLegendMeta` (label/color/format). `PaneLegendOverlay` reads
 *  the value back through `readSeriesValue(series, param.seriesData)` so the
 *  legend shows the SAME value the chart draws (no recompute / drift). */
export type LegendSeriesEntry = { series: ISeriesApi<any>; meta: SeriesLegendMeta };

/** Shared registry of pane legend series, keyed by `PaneId`. Registered by
 *  `RangeSeriesPane`'s series-lifecycle effect for every pane whose spec
 *  declares legend metadata. Only the dynamic series+meta live here; the
 *  pane-level toggle/title are static and read from the spec by the overlay.
 *  Registry presence == pane mounted, so the legend never re-derives "is this
 *  pane on" from toggle state — the mount gate (`paneSpecsForTimeframe`) stays
 *  the single source. Separate from the `paneSeries` (primary-only) registry
 *  that DrawingOverlay's coordinate math depends on — kept untouched here. */
interface PaneLegendRegistry {
  panes: ReadonlyMap<PaneId, LegendSeriesEntry[]>;
  register: (paneId: PaneId, entries: LegendSeriesEntry[]) => void;
  unregister: (paneId: PaneId) => void;
}

export const usePaneLegendRegistry = create<PaneLegendRegistry>((set, get) => ({
  panes: new Map(),
  register: (paneId, entries) => {
    const m = new Map(get().panes);
    m.set(paneId, entries);
    set({ panes: m });
  },
  unregister: (paneId) => {
    if (!get().panes.has(paneId)) return;
    const m = new Map(get().panes);
    m.delete(paneId);
    set({ panes: m });
  },
}));
