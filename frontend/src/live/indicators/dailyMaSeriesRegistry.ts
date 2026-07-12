import { create } from 'zustand';
import type { ISeriesApi } from 'lightweight-charts';

type DailyMaSeries = ISeriesApi<'Line'>;

/** Shared registry of daily-MA slot line series, keyed by slot id — the daily
 *  mirror of `maSeriesRegistry`. PaneLegendOverlay reads it to resolve each
 *  slot's value at the cursor (id → series → value), so the legend shows the
 *  SAME day-stepped projection the chart draws (no recompute). */
interface DailyMaRegistry {
  series: ReadonlyMap<string, DailyMaSeries>;
  register: (id: string, s: DailyMaSeries) => void;
  unregister: (id: string) => void;
}

export const useDailyMaSeriesRegistry = create<DailyMaRegistry>((set, get) => ({
  series: new Map(),
  register: (id, s) => {
    const m = new Map(get().series);
    m.set(id, s);
    set({ series: m });
  },
  unregister: (id) => {
    if (!get().series.has(id)) return;
    const m = new Map(get().series);
    m.delete(id);
    set({ series: m });
  },
}));
