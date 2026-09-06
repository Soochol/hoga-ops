import type { Candle } from '../../api/types';
import type { LineData, Time, WhitespaceData } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { LivePastDailyCandle } from '../../api/livePastDailyCandles';
import { selectSource, type MASource } from './movingAverage';
import { computeDailyMaByDate } from './dailyMovingAverage';

export type MaData = (LineData<Time> | WhitespaceData<Time>)[];
type Config = { id: string; enabled: boolean; period: number; source: MASource };
type Position = { time: Time; date: string | undefined };

/** 입력 원소는 불변. 같은 축의 미변경 캔들은 세션/좌표/날짜를 다시 찾지 않는다. */
function geometry(withDates: boolean) {
  let axisRef: VirtualAxis | undefined;
  let input: readonly Candle[] | undefined;
  let cache = new WeakMap<Candle, Position | null>();
  let result: { candles: Candle[]; positions: Position[] } = { candles: [], positions: [] };
  return (candles: readonly Candle[], axis: VirtualAxis) => {
    if (axisRef === axis && input === candles) return result;
    if (axisRef !== axis) cache = new WeakMap();
    axisRef = axis;
    input = candles;
    result = { candles: [], positions: [] };
    for (const candle of candles) {
      let position = cache.get(candle);
      if (position === undefined) {
        position = axis.contains(candle.ts_ms) ? {
          time: (axis.toVirtual(candle.ts_ms) / 1000) as Time,
          date: withDates ? axis.segments[axis.findByReal(candle.ts_ms)]?.date : undefined,
        } : null;
        cache.set(candle, position);
      }
      if (position) {
        result.candles.push(candle);
        result.positions.push(position);
      }
    }
    return result;
  };
}

/** 원본 SMA와 같은 덧셈/뺄셈 순서를 유지하도록 각 prefix의 이동합을 보존한다. */
export function createMovingAverageProjection() {
  const prepare = geometry(false);
  type Entry = { axis: VirtualAxis; period: number; source: MASource; candles: readonly Candle[]; values: number[]; sums: number[]; data: MaData };
  const entries = new Map<string, Entry>();
  return (candles: readonly Candle[], axis: VirtualAxis, configs: readonly Config[]): Map<string, MaData> => {
    const enabled = configs.filter(c => c.enabled);
    const ids = new Set(enabled.map(c => c.id));
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
    const out = new Map<string, MaData>();
    if (enabled.length === 0) return out;
    const projected = prepare(candles, axis);
    for (const cfg of enabled) {
      const previous = entries.get(cfg.id);
      const reusable = previous?.axis === axis && previous.period === cfg.period && previous.source === cfg.source;
      let start = 0;
      if (reusable) {
        while (start < previous.candles.length && start < projected.candles.length
          && previous.candles[start] === projected.candles[start]) start += 1;
        if (start === previous.candles.length && start === projected.candles.length) {
          out.set(cfg.id, previous.data);
          continue;
        }
      }
      const values = reusable ? previous.values : [];
      const sums = reusable ? previous.sums : [];
      const data: MaData = reusable ? previous.data.slice(0, start) : [];
      let sum = start > 0 ? sums[start - 1] : 0;
      for (let i = start; i < projected.candles.length; i += 1) {
        const value = selectSource(projected.candles[i], cfg.source);
        values[i] = value;
        sum += value;
        if (cfg.period > 0 && i >= cfg.period) sum -= values[i - cfg.period];
        sums[i] = sum;
        const sma = cfg.period <= 0 || i < cfg.period - 1 ? null : cfg.period === 1 ? value : sum / cfg.period;
        const time = projected.positions[i].time;
        data.push(sma === null ? { time } : { time, value: sma });
      }
      values.length = sums.length = projected.candles.length;
      entries.set(cfg.id, { axis, period: cfg.period, source: cfg.source, candles: projected.candles, values, sums, data });
      out.set(cfg.id, data);
    }
    return out;
  };
}

/** 날짜별 값이 바뀐 날짜의 점만 다시 만든다. 오늘 MA는 오늘 분봉 전체에 적용한다. */
export function createDailyMovingAverageProjection() {
  const prepare = geometry(true);
  type Entry = { daily: readonly LivePastDailyCandle[]; period: number; source: MASource; today: string; close: number | null; values: Map<string, number>; positions: Position[]; data: MaData };
  const entries = new Map<string, Entry>();
  return (candles: readonly Candle[], axis: VirtualAxis, configs: readonly Config[], daily: readonly LivePastDailyCandle[], today: string, close: number | null): Map<string, MaData> => {
    const enabled = configs.filter(c => c.enabled);
    const ids = new Set(enabled.map(c => c.id));
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
    const out = new Map<string, MaData>();
    if (enabled.length === 0) return out;
    const { positions } = prepare(candles, axis);
    for (const cfg of enabled) {
      const previous = entries.get(cfg.id);
      const values = previous?.daily === daily && previous.period === cfg.period && previous.source === cfg.source
        && previous.today === today && previous.close === close ? previous.values
        : computeDailyMaByDate(daily, cfg.period, cfg.source, today, close);
      const data = positions.map((position, i) => {
        const value = position.date === undefined ? undefined : values.get(position.date);
        const oldValue = position.date === undefined ? undefined : previous?.values.get(position.date);
        if (previous?.positions[i] === position && Object.is(value, oldValue)) return previous.data[i];
        return value == null ? { time: position.time } : { time: position.time, value };
      });
      entries.set(cfg.id, { daily, period: cfg.period, source: cfg.source, today, close, values, positions, data });
      out.set(cfg.id, data);
    }
    return out;
  };
}
