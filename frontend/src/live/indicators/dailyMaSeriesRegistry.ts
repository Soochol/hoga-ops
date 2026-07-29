import type { ISeriesApi } from 'lightweight-charts';
import { createWindowScopedRegistry } from './windowScopedRegistry';

type DailyMaSeries = ISeriesApi<'Line'>;

/** Registry of daily-MA slot line series, keyed by **(창, slot id)** — the daily
 *  mirror of `maSeriesRegistry`. PaneLegendOverlay reads it to resolve each
 *  slot's value at the cursor (id → series → value), so the legend shows the
 *  SAME day-stepped projection the chart draws (no recompute).
 *
 *  창 스코프가 필요한 이유는 `createWindowScopedRegistry` 주석 참조. */
export const useDailyMaSeriesRegistry = createWindowScopedRegistry<string, DailyMaSeries>();
