import type { ISeriesApi } from 'lightweight-charts';
import type { PaneId } from '../../chart/drawing/types';
import type { SeriesLegendMeta } from '../../chart/RangeSeriesPane';
import { createWindowScopedRegistry } from './windowScopedRegistry';

/** One legend cell bound to a live chart series: the series handle plus its
 *  colocated `SeriesLegendMeta` (label/color/format). `PaneLegendOverlay` reads
 *  the value back through `readSeriesValue(series, param.seriesData)` so the
 *  legend shows the SAME value the chart draws (no recompute / drift). */
export type LegendSeriesEntry = { series: ISeriesApi<any>; meta: SeriesLegendMeta };

/** Registry of pane legend series, keyed by **(창, `PaneId`)**. Registered by
 *  `RangeSeriesPane`'s series-lifecycle effect for every pane whose spec
 *  declares legend metadata. Only the dynamic series+meta live here; the
 *  pane-level toggle/title are static and read from the spec by the overlay.
 *  Registry presence == pane mounted, so the legend never re-derives "is this
 *  pane on" from toggle state — the mount gate (`paneSpecsForTimeframe`) stays
 *  the single source. Separate from the `paneSeries` (primary-only) registry
 *  that DrawingOverlay's coordinate math depends on — kept untouched here.
 *
 *  `PaneId` 는 창마다 같은 고정 문자열('candle'·'volume' …)이라 창 스코프가 없으면
 *  창끼리 서로 덮어쓴다 — `createWindowScopedRegistry` 주석 참조. */
export const usePaneLegendRegistry = createWindowScopedRegistry<PaneId, LegendSeriesEntry[]>();
