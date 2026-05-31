// Pane Legend — pure row model.
//
// `buildLegendRows` turns the live indicator store snapshot + cursor-resolved
// values into the rows the `PaneLegendOverlay` renders, one per chart pane.
// Keeping it pure (values arrive as a Map / scalars, not a live chart) makes
// the gating rules — MA master off, daily-only investor panes — unit-testable
// without a chart instance. The component owns the impure value extraction
// (`readSeriesValue` below) and feeds the result in.

import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { LiveTimeframe, LiveMAConfig } from '../state/livePage';

/** One moving-average slot's legend cell: swatch color + period + value. */
export type LegendMAValue = {
  id: string;
  color: string;
  period: number;
  value: number | null;
};

/**
 * A single pane's legend row. The candle pane aggregates every enabled MA
 * slot (one row, many swatches) and carries the shared hide flag; the other
 * panes each show a single labelled value.
 */
export type LegendRow =
  | { paneId: 'candle'; kind: 'ma'; mas: LegendMAValue[]; hidden: boolean }
  | { paneId: 'volume'; kind: 'single'; label: string; value: number | null }
  | { paneId: 'investor-foreign'; kind: 'single'; label: string; value: number | null }
  | { paneId: 'investor-institution'; kind: 'single'; label: string; value: number | null };

export type BuildLegendRowsInput = {
  timeframe: LiveTimeframe;
  movingAverages: ReadonlyArray<LiveMAConfig>;
  /** MA master toggle. When off the overlay clears the series, so a row would
   *  read all-null on an invisible line — suppress it instead. */
  movingAverageEnabled: boolean;
  movingAverageHidden: boolean;
  /** slot id → value at cursor (or latest). Missing id → the cell shows "—". */
  maValues: ReadonlyMap<string, number>;
  volumeEnabled: boolean;
  volumeValue: number | null;
  foreignNetEnabled: boolean;
  foreignValue: number | null;
  institutionNetEnabled: boolean;
  institutionValue: number | null;
};

export function buildLegendRows(input: BuildLegendRowsInput): LegendRow[] {
  const rows: LegendRow[] = [];

  // Candle pane — one row aggregating every enabled MA slot. Gated on the
  // master toggle (see field doc) so an invisible line never leaves an empty
  // "—" row behind.
  if (input.movingAverageEnabled) {
    const mas: LegendMAValue[] = input.movingAverages
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        color: m.color,
        period: m.period,
        value: input.maValues.get(m.id) ?? null,
      }));
    if (mas.length > 0) {
      rows.push({ paneId: 'candle', kind: 'ma', mas, hidden: input.movingAverageHidden });
    }
  }

  // Volume pane is mounted on every timeframe (minute + calendar).
  if (input.volumeEnabled) {
    rows.push({ paneId: 'volume', kind: 'single', label: '거래량', value: input.volumeValue });
  }

  // Investor panes are daily-only (ADR-0055) — W/M aggregate candles into
  // week/month segments, so the daily-anchored points wouldn't align.
  // Mirror `paneSpecsForTimeframe`'s `tf === 'D'` gate exactly.
  if (input.timeframe === 'D') {
    if (input.foreignNetEnabled) {
      rows.push({
        paneId: 'investor-foreign',
        kind: 'single',
        label: '외국인 순매수량',
        value: input.foreignValue,
      });
    }
    if (input.institutionNetEnabled) {
      rows.push({
        paneId: 'investor-institution',
        kind: 'single',
        label: '기관 순매수량',
        value: input.institutionValue,
      });
    }
  }

  return rows;
}

/**
 * The cursor-tracked value for a series: the data point under the crosshair
 * when `seriesData` (from `param.seriesData`) holds it, otherwise the series'
 * latest data point. Whitespace points (no `value`) and absent series resolve
 * to null so the legend shows "—".
 *
 * Pure over the chart API objects — pass a `{ data() }` stub to unit-test.
 */
export function readSeriesValue(
  series: ISeriesApi<SeriesType> | undefined,
  seriesData: ReadonlyMap<ISeriesApi<SeriesType>, unknown> | null,
): number | null {
  if (!series) return null;
  if (seriesData) {
    const atCursor = pointValue(seriesData.get(series));
    if (atCursor !== null) return atCursor;
  }
  const data = series.data();
  return pointValue(data.length > 0 ? data[data.length - 1] : undefined);
}

function pointValue(point: unknown): number | null {
  if (point && typeof point === 'object' && 'value' in point) {
    const v = (point as { value: unknown }).value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
