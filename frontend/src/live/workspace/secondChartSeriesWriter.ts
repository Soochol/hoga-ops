import type { ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { SecondBar } from '../../api/secondAggregates';
import type { VirtualAxis } from '../../util/virtualAxis';
import { movingAverageSeconds } from './secondAggregateProjectors';

type Series = { candles: ISeriesApi<'Candlestick'>; volume: ISeriesApi<'Histogram'>; ma: ISeriesApi<'Line'> };
const PERIOD = 20;
const sameBar = (a: SecondBar, b: SecondBar) => a === b || a.t_ms === b.t_ms
  && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

/** Replace structural changes; update the tail and late corrections in place.
 * Existing day projections must stay fixed before historical updates are safe.
 */
export function createSecondChartSeriesWriter(series: Series) {
  let previous: readonly SecondBar[] = [];
  let previousAxis: VirtualAxis | null = null;
  return (bars: readonly SecondBar[], axis: VirtualAxis) => {
    if (bars === previous && axis === previousAxis) return;
    const projected = (ms: number) => axis.toVirtual(ms) / 1000 as UTCTimestamp;
    const { upColor, downColor } = series.candles.options();
    const candle = (b: SecondBar) => ({ time: projected(b.t_ms), open: b.open, high: b.high, low: b.low, close: b.close });
    const volume = (b: SecondBar) => ({ time: projected(b.t_ms), value: b.volume, color: b.close >= b.open ? upColor : downColor });
    let reset = !previous.length || bars.length < previous.length || !previousAxis
      || previousAxis.segments.some((s, i) => {
        const next = axis.segments[i];
        return !next || s.date !== next.date || s.sessionOpenMs !== next.sessionOpenMs || s.virtualStart !== next.virtualStart;
      });
    const changes: number[] = [];
    if (!reset) {
      for (let i = 0; i < previous.length; i++) {
        if (previous[i].t_ms !== bars[i].t_ms) { reset = true; break; }
        if (!sameBar(previous[i], bars[i])) changes.push(i);
      }
      // A wholesale correction is cheaper as one replacement than many updates.
      if (changes.length > 64) reset = true;
    }
    if (reset) {
      series.candles.setData(bars.map(candle));
      series.volume.setData(bars.map(volume));
      series.ma.setData(movingAverageSeconds(bars, PERIOD).map(p => ({ ...p, time: projected(Number(p.time) * 1000) })));
    } else {
      for (let i = previous.length; i < bars.length; i++) changes.push(i);
      const affectedMa = new Set<number>();
      for (const i of changes) {
        const historical = i < previous.length - 1;
        series.candles.update(candle(bars[i]), historical);
        series.volume.update(volume(bars[i]), historical);
        for (let j = Math.max(PERIOD - 1, i); j < Math.min(bars.length, i + PERIOD); j++) affectedMa.add(j);
      }
      for (const i of [...affectedMa].sort((a, b) => a - b)) {
        let total = 0;
        for (let j = i - PERIOD + 1; j <= i; j++) total += bars[j].close;
        series.ma.update({ time: projected(bars[i].t_ms), value: total / PERIOD }, i < previous.length - 1);
      }
    }
    previous = bars;
    previousAxis = axis;
  };
}
