import { describe, expect, it } from 'vitest';
import type { LineData, Time } from 'lightweight-charts';
import { rangeBundleFixture } from '../../tests/fixtures/rangeBundle';
import { buildChartBundle } from '../live/buildLiveBundle';
import { regularSessionOpenMs } from '../live/liveDateTime';
import { createVirtualAxis } from '../util/virtualAxis';
import { projectCandle } from './projectors/candle';
import { maskIntradayLineGaps, withIntradayWhitespace } from './intradayWhitespace';
import { TRANSPARENT } from './util/auctionHide';

const minute = 60_000;
const dates = ['20250324', '20250507', '20251001'];
const sessions = dates.map(date => ({ date, session_open_ms: regularSessionOpenMs(date), session_close_ms: regularSessionOpenMs(date) + 4 * minute }));
const candle = (ts_ms: number) => ({ ts_ms, open: 100, high: 102, low: 99, close: 101, vol_a: 10, vol_b: 20 });
const axis = createVirtualAxis(sessions.map(s => ({ date: s.date, sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms })));

describe('disk intraday whitespace', () => {
  it.each([1, 3])('preserves empty sessions and intraday holes at %i minute resolution', bucket => {
    const bundle = rangeBundleFixture({ bucket_ms: bucket * minute, timeline_sessions: sessions,
      candles: [candle(sessions[0].session_open_ms), candle(sessions[2].session_open_ms + 3 * minute)] });
    const projected = projectCandle(bundle, axis);
    const data = withIntradayWhitespace(projected, bundle, axis);
    expect(data.filter(p => 'close' in p)).toHaveLength(2);
    expect(data.filter(p => 'close' in p)).toEqual(projected);
    expect(data).toHaveLength(bucket === 1 ? 15 : 6);
    const blankDay = data.filter(p => axis.toReal(Number(p.time) * 1000) >= sessions[1].session_open_ms
      && axis.toReal(Number(p.time) * 1000) <= sessions[1].session_close_ms);
    expect(blankDay).toHaveLength(bucket === 1 ? 5 : 2);
    expect(blankDay.every(p => Object.keys(p).join() === 'time')).toBe(true);
    expect(data.every((p, i) => i === 0 || Number(data[i - 1].time) < Number(p.time))).toBe(true);
    expect(bundle.candles).toHaveLength(2);
  });

  it('has a navigable grid even when the entire response is empty', () => {
    const bundle = rangeBundleFixture({ candles: [], timeline_sessions: sessions });
    expect(withIntradayWhitespace([], bundle, axis)).toHaveLength(15);
    expect(withIntradayWhitespace([], bundle, axis).every(p => !('open' in p))).toBe(true);
  });

  it('does not change the normal chart time grid', () => {
    const data = [{ time: 1 as Time, value: 100 }];
    const bundle = rangeBundleFixture({});
    expect(withIntradayWhitespace(data, bundle, axis)).toBe(data);
    expect(maskIntradayLineGaps(data, bundle, axis)).toBe(data);
  });

  it('hides line connectors and indicator values across missing candle buckets', () => {
    const open = sessions[0].session_open_ms;
    const bundle = rangeBundleFixture({ timeline_sessions: sessions, candles: [candle(open), candle(open + 3 * minute), candle(open + 4 * minute)] });
    const data: LineData<Time>[] = [0, 1, 3, 4].map(m => ({ time: axis.toVirtual(open + m * minute) / 1000 as Time, value: 100 + m }));
    const masked = maskIntradayLineGaps(data, bundle, axis);
    expect(masked.map(p => p.value)).toEqual([100, 103, 104]);
    expect(masked[0].color).toBe(TRANSPARENT);
    expect(masked[1].color).toBeUndefined();
    expect(data[0].color).toBeUndefined(); // immutable cached projection
  });

  it('keeps time-only sessions separate from real captured segments and candles', () => {
    const input = { code: '034020', todayDate: '20251001', todaySession: { open_ms: sessions[2].session_open_ms, close_ms: sessions[2].session_close_ms },
      pastBundle: null, kisCandles: [candle(sessions[0].session_open_ms)], bucketMs: minute, hasTodayObSignal: false,
      timelineDates: dates, sessionBoundsForDate: (date: string) => ({ open_ms: regularSessionOpenMs(date), close_ms: regularSessionOpenMs(date) + 4 * minute }) };
    const bundle = buildChartBundle(input);
    expect(bundle.segments.map(s => s.date)).toEqual(['20250324']);
    expect(bundle.timeline_sessions?.map(s => s.date)).toEqual(dates);
    expect(bundle.candles).toBe(input.kisCandles);
  });
});
