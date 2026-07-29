import type { ISeriesApi } from 'lightweight-charts';
import { createWindowScopedRegistry } from './windowScopedRegistry';

type MaSeries = ISeriesApi<'Line'>;

/** Registry of MA slot line series, keyed by **(창, slot id)**. PaneLegendOverlay
 *  reads it to match `param.seriesData` entries to a slot (id → series → value),
 *  so the legend shows the SAME value the chart draws (no recompute).
 *
 *  슬롯 id(`'ma-1'` …)는 창마다 같은 고정 문자열이라 창 스코프 없이는 차트 창이
 *  둘 이상일 때 서로 덮어쓰고 지운다 — 근거와 재렌더 이점은
 *  `createWindowScopedRegistry` 주석 참조. */
export const useMaSeriesRegistry = createWindowScopedRegistry<string, MaSeries>();
