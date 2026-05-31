import { create } from 'zustand';
import type { ISeriesApi } from 'lightweight-charts';

type MaSeries = ISeriesApi<'Line'>;

/** Shared registry of MA slot line series, keyed by slot id. PaneLegendOverlay
 *  reads it to match `param.seriesData` entries to a slot (id → series → value),
 *  so the legend shows the SAME value the chart draws (no recompute). */
interface MaRegistry {
  series: ReadonlyMap<string, MaSeries>;
  register: (id: string, s: MaSeries) => void;
  unregister: (id: string) => void;
}

export const useMaSeriesRegistry = create<MaRegistry>((set, get) => ({
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
