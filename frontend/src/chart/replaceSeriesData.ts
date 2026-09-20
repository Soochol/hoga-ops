import type { IChartApi } from 'lightweight-charts';
import { syncSeriesData, type SeriesDataSink } from './seriesDataDiff';

/** Clear stale hover indices before setData reindexes the shared time scale.
 * lwc 5.2 can synchronously hit-test another line's old render items during
 * replacement, throwing `Value is null` in SeriesBarColorer.Line.
 * Keep hover on value-only replacements; only a changed time grid needs a
 * reset. The next pointer move restores hover after a time-grid change.
 */
export function replaceSeriesData(
  chart: Partial<Pick<IChartApi, 'clearCrosshairPosition'>>,
  series: Pick<SeriesDataSink, 'setData'>,
  data: Parameters<SeriesDataSink['setData']>[0],
  previous?: readonly Parameters<SeriesDataSink['setData']>[0][number][] | null,
): void {
  const sameTimes = previous?.length === data.length
    && data.every((point, i) => point.time === previous[i].time);
  // Some lightweight chart adapters/test doubles expose only the subset they
  // use. Real IChartApi instances have this method; tolerate partial adapters.
  if (!sameTimes) chart.clearCrosshairPosition?.();
  series.setData(data);
}

/** Apply the incremental series diff while routing full replacements through
 * replaceSeriesData. This keeps lightweight-charts' crosshair away from a
 * transiently empty series without giving up cheap tail updates. */
export function syncChartSeriesData(
  chart: Partial<Pick<IChartApi, 'clearCrosshairPosition'>>,
  series: SeriesDataSink,
  previous: ReturnType<typeof syncSeriesData>,
  data: Parameters<SeriesDataSink['setData']>[0],
): ReturnType<typeof syncSeriesData> {
  return syncSeriesData({
    setData: (next) => replaceSeriesData(chart, series, next, previous),
    update: (point) => series.update(point),
  }, previous, data);
}
