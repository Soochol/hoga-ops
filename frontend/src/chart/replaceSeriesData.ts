import type { IChartApi } from 'lightweight-charts';
import type { SeriesDataSink } from './seriesDataDiff';

/** Clear stale hover indices before setData reindexes the shared time scale.
 * lwc 5.2 can synchronously hit-test another line's old render items during
 * replacement, throwing `Value is null` in SeriesBarColorer.Line.
 * Keep hover on value-only replacements; only a changed time grid needs a
 * reset. The next pointer move restores hover after a time-grid change.
 */
export function replaceSeriesData(
  chart: Pick<IChartApi, 'clearCrosshairPosition'>,
  series: Pick<SeriesDataSink, 'setData'>,
  data: Parameters<SeriesDataSink['setData']>[0],
  previous?: readonly Parameters<SeriesDataSink['setData']>[0][number][] | null,
): void {
  const sameTimes = previous?.length === data.length
    && data.every((point, i) => point.time === previous[i].time);
  if (!sameTimes) chart.clearCrosshairPosition();
  series.setData(data);
}
