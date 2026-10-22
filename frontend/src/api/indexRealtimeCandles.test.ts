import { describe, expect, it } from 'vitest';
import { appendIndexPrice, overlayIndexCandles, type IndexRealtimeSession } from './indexRealtimeCandles';
import type { LiveIndexCandlesResponse } from './liveIndices';
import type { LiveIndexId } from '../live/liveInstrument';
import type { LiveTimeframe } from '../state/livePage';

const at = (clock: string, date = '2026-10-22') => Date.parse(`${date}T${clock}+09:00`);
const response = (tf: LiveTimeframe = '1m', overrides: Partial<LiveIndexCandlesResponse> = {}): LiveIndexCandlesResponse => ({
  index_id: 'KOSPI', timeframe: tf, from: '20261001', to: '20261022', data_warnings: [],
  candles: [{ t_ms: at('10:00:00'), open: 100, high: 105, low: 95, close: 101, volume: 321 }], ...overrides,
});
function ticks(...observations: [string, number][]): IndexRealtimeSession {
  let state: IndexRealtimeSession | undefined;
  for (const [clock, value] of observations) {
    const t_ms = at(clock);
    state = appendIndexPrice(state, 'KOSPI', { t_ms, value }, t_ms);
  }
  return state!;
}

describe('observed domestic index prices', () => {
  it('keeps timestamped price samples independent of REST and other indices', () => {
    const state = ticks(['10:00:01', 103], ['10:00:02', 108]);
    expect(state.minutes).toHaveLength(1);
    expect(state.minutes[0].samples).toHaveLength(2);
    expect(appendIndexPrice(state, 'KOSPI', { t_ms: at('10:00:02'), value: 108 }, at('10:00:02'))).toBe(state);
    expect(appendIndexPrice(state, 'KOSPI', { t_ms: at('10:00:01'), value: 99 }, at('10:00:02'))).toBe(state);
    expect(overlayIndexCandles(response('1m', { index_id: 'KOSDAQ' }), state, 0).candles[0].close).toBe(101);
  });

  it.each([
    { t_ms: at('10:00:00') }, { value: 100 }, { value: 0, t_ms: at('10:00:00') },
    { value: NaN, t_ms: at('10:00:00') }, { value: 100, t_ms: Infinity },
    { value: 100, t_ms: at('08:59:59') }, { value: 100, t_ms: at('15:30:01') },
    { value: 100, t_ms: at('10:00:00', '2026-10-24') },
  ])('ignores invalid, breadth-only, weekend and off-session samples %j', tick => {
    expect(appendIndexPrice(undefined, 'KOSPI', tick, tick.t_ms ?? at('10:00:00'))).toBeUndefined();
  });

  it('rejects stale, previous-day and future samples', () => {
    expect(appendIndexPrice(undefined, 'KOSPI', { t_ms: at('10:00:00'), value: 100 }, at('10:04:00'))).toBeUndefined();
    expect(appendIndexPrice(undefined, 'KOSPI', { t_ms: at('15:30:00', '2026-10-21'), value: 100 }, at('10:00:00'))).toBeUndefined();
    expect(appendIndexPrice(undefined, 'KOSPI', { t_ms: at('10:02:00'), value: 100 }, at('10:00:00'))).toBeUndefined();
  });

  it.each(['KRX100', 'KRX300', 'SP500'] as LiveIndexId[])('%s never uses a guessed realtime code', id => {
    expect(appendIndexPrice(undefined, id, { t_ms: at('10:00:00'), value: 100 }, at('10:00:00'))).toBeUndefined();
  });

  it('bounds each minute to one sample per second and resets on the next observed trading day', () => {
    let state = ticks(['10:00:01', 100]);
    for (let ms = 1; ms < 1000; ms++) {
      state = appendIndexPrice(state, 'KOSPI', { t_ms: at('10:00:01') + ms, value: 100 + ms }, at('10:00:02'))!;
    }
    expect(state.minutes[0].samples).toHaveLength(1);
    const nextDay = at('09:00:01', '2026-10-23');
    const next = appendIndexPrice(state, 'KOSPI', { t_ms: nextDay, value: 110 }, nextDay)!;
    expect(next.date).toBe('20261023');
    expect(next.minutes).toHaveLength(1);
  });
});

describe('realtime candle tail with REST correction', () => {
  it('moves the last close and observed extremes while preserving REST open, volume and turnover', () => {
    const rest = response();
    rest.candles[0].trade_value_won = 12345;
    const next = overlayIndexCandles(rest, ticks(['10:00:11', 110], ['10:00:12', 90], ['10:00:13', 107]), at('10:00:10'));
    expect(next.candles[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 107, volume: 321, trade_value_won: 12345 });
    expect(rest.candles[0].close).toBe(101);
  });

  it('starts a new observed candle and leaves missing minutes empty', () => {
    const next = overlayIndexCandles(response(), ticks(['10:01:01', 108], ['10:01:02', 109], ['10:03:01', 111]), at('10:00:10'));
    expect(next.candles.map(c => c.t_ms)).toEqual([at('10:00:00'), at('10:01:00'), at('10:03:00')]);
    expect(next.candles[1]).toMatchObject({ open: 108, high: 109, low: 108, close: 109, volume: 0 });
  });

  it.each(['3m', '5m', '15m', '60m', '120m', '240m'] as const)('%s uses the same epoch-aligned buckets as the provider', tf => {
    const size = Number(tf.slice(0, -1)) * 60000;
    const start = Math.floor(at('10:00:01') / size) * size;
    const rest = response(tf, { candles: [{ ...response().candles[0], t_ms: start }] });
    const next = overlayIndexCandles(rest, ticks(['10:00:01', 110]), at('10:00:00'));
    expect(next.candles).toHaveLength(1);
    expect(next.candles[0]).toMatchObject({ t_ms: start, open: 100, close: 110, volume: 321 });
  });

  it('uses a late REST response for completed bars while keeping ticks received during that request', () => {
    const state = ticks(['10:00:12', 110], ['10:01:11', 120]);
    const rest = response('1m', { candles: [response().candles[0], {
      t_ms: at('10:01:00'), open: 112, high: 113, low: 111, close: 112, volume: 20,
    }] });
    const next = overlayIndexCandles(rest, state, at('10:01:10'));
    expect(next.candles[0]).toBe(rest.candles[0]); // old provisional high is corrected
    expect(next.candles[1]).toMatchObject({ open: 112, high: 120, close: 120, volume: 20 });
    const authoritative = overlayIndexCandles(rest, state, at('10:01:20'));
    expect(authoritative).toBe(rest);
  });

  it.each(['D', 'W', 'M'] as const)('%s preserves the provider period anchor and open', tf => {
    const rest = response(tf, { candles: [{ ...response().candles[0], t_ms: at('09:00:00', '2026-10-19') }] });
    if (tf === 'D') rest.candles[0].t_ms = at('09:00:00');
    const next = overlayIndexCandles(rest, ticks(['10:00:11', 110]), at('10:00:10'));
    expect(next.candles).toHaveLength(1);
    expect(next.candles[0]).toMatchObject({ t_ms: rest.candles[0].t_ms, open: 100, close: 110, volume: 321 });
  });

  it('starts today without overwriting the previous daily candle', () => {
    const rest = response('D', { candles: [{ ...response().candles[0], t_ms: at('09:00:00', '2026-10-21') }] });
    const next = overlayIndexCandles(rest, ticks(['10:00:01', 110]), at('10:00:00'));
    expect(next.candles[0]).toBe(rest.candles[0]);
    expect(next.candles[1]).toMatchObject({ t_ms: at('09:00:00'), open: 110, close: 110, volume: 0 });
  });

  it('keeps past-only ranges and other markets untouched', () => {
    const state = ticks(['10:00:11', 110]);
    const historical = response('1m', { to: '20261021' });
    expect(overlayIndexCandles(historical, state, 0)).toBe(historical);
    const us = response('1m', { index_id: 'SP500' });
    expect(overlayIndexCandles(us, { ...state, indexId: 'SP500' }, 0)).toBe(us);
  });
});
