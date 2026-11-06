import { describe, expect, it } from 'vitest';
import { calendarJumpSource, calendarPeriodStart, calendarQueryStatus, exactCalendarTarget, lastObservedDailyDate } from './calendarJump';
import { canReceiveTimeframeJump, domesticStockCode, type JumpReceiver } from '../chart/timeframeJump';
import type { LiveVenueOption } from '../state/liveVenue';
import type { CalendarTimeframe } from '../state/livePage';

const ms = (date: string, hour = 9) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+09:00`).getTime();
const source = calendarJumpSource({ range: { fromMs: ms('2026-03-30'), toMs: ms('2026-04-05', 23) },
  timeframe: 'W', code: '005930', venue: 'UN', source: 'vendor', sourceKey: 'source', cutoffDate: '20261107' });
const identity = { code: source.code, from: source.from, to: source.to, source: source.source, venue: source.venue, timeframe: 'D' } satisfies Parameters<typeof calendarQueryStatus>[0]['identity'];
const data = { code: source.code, from: source.from, to: source.to, venue: source.venue,
  candles: [], cached_batches: [], fresh_batches: [], data_warnings: [] };

describe('period-end daily observation', () => {
  it('maps a cross-month week to its last observed day and original monthly candle', () => {
    const date = lastObservedDailyDate(source, [{ t_ms: ms('2026-04-03') }, { t_ms: ms('2026-03-30') }, { t_ms: ms('2026-04-06') }]);
    expect(date).toBe('20260403');
    expect(exactCalendarTarget([{ ts_ms: ms('2026-03-02') }, { ts_ms: ms('2026-04-01') }], date ?? '', 'M')).toBe(ms('2026-04-01'));
  });
  it('uses the previous week when a month-end holiday has no daily candle', () => {
    expect(exactCalendarTarget([{ ts_ms: ms('2026-08-24') }, { ts_ms: ms('2026-08-31') }], '20260828', 'W')).toBe(ms('2026-08-24'));
    expect(exactCalendarTarget([{ ts_ms: ms('2026-08-31') }], '20260828', 'W')).toBeNull();
  });
  it('uses KST month and Monday boundaries across the year', () => {
    expect(calendarPeriodStart(ms('2027-01-01'), 'W')).toBe('20261228');
    expect(calendarPeriodStart(ms('2027-01-01'), 'M')).toBe('20270101');
    expect(exactCalendarTarget([{ ts_ms: ms('2026-12-28') }], '20270101', 'W')).toBe(ms('2026-12-28'));
  });
  it('clamps ongoing periods by the source cutoff date, including an NXT pre-09 anchor', () => {
    const ongoing = calendarJumpSource({ ...source, range: { fromMs: ms('2026-11-02'), toMs: ms('2026-11-04', 8) },
      timeframe: 'W', cutoffDate: '20261104' });
    expect(ongoing.to).toBe('20261104');
    expect(lastObservedDailyDate(ongoing, [{ t_ms: ms('2026-11-04') }, { t_ms: ms('2026-11-05') }])).toBe('20261104');
    expect(lastObservedDailyDate(source, [])).toBeNull();
  });
});

describe('exact query validation', () => {
  const args = { identity, data, isPlaceholderData: false, isPending: false, error: null };
  it('rejects placeholders, wrong echo, venue, timeframe, code and source', () => {
    expect(calendarQueryStatus({ ...args, isPlaceholderData: true })).toEqual({ kind: 'pending' });
    const changes: Array<{ from?: string; to?: string; code?: string; venue?: LiveVenueOption; timeframe?: 'W'; source?: 'screener_daily' }> = [{ from: '20260329' }, { to: '20260406' }, { code: '000660' }, { venue: 'KRX' }, { timeframe: 'W' }, { source: 'screener_daily' }];
    for (const change of changes) {
      expect(calendarQueryStatus({ ...args, data: { ...data, ...change } }).kind).toBe('failed');
    }
  });
  it('distinguishes empty success, HTTP error and partial warnings', () => {
    expect(calendarQueryStatus(args)).toEqual({ kind: 'ready', from: source.from, to: source.to });
    expect(calendarQueryStatus({ ...args, error: new Error('offline') }).kind).toBe('failed');
    expect(calendarQueryStatus({ ...args, data: { ...data, data_warnings: [{ batch: '1', reason: 'transport_error', msg: 'partial' }] } }).kind).toBe('failed');
  });
});

describe('actual receiver matrix', () => {
  const frames: CalendarTimeframe[] = ['D', 'W', 'M'];
  it.each(frames)('checks all calendar targets from %s', timeframe => {
    const origin = { windowId: 'source', group: 1, code: '005930', timeframe };
    for (const tf of frames) {
      const target = { windowId: 'target', group: 1, code: '005930', stockCode: '005930', timeframe: tf };
      expect(canReceiveTimeframeJump({ origin, sourceStockCode: '005930', target, allowCrossSymbol: true }))
        .toBe(timeframe !== 'D' && timeframe !== tf);
    }
  });
  it('accepts legacy domestic stock and excludes other actual symbols, groups and same window', () => {
    expect(domesticStockCode({ code: '005930', name: '삼성전자' })).toBe('005930');
    expect(domesticStockCode({ kind: 'index', code: '005930', name: 'index' })).toBeNull();
    const origin = { windowId: 'source', group: 1, code: '005930', timeframe: 'M' } satisfies Parameters<typeof canReceiveTimeframeJump>[0]['origin'];
    const target = { windowId: 'target', group: 1, code: '005930', stockCode: '005930', timeframe: 'D' } satisfies JumpReceiver;
    for (const change of [{ windowId: 'source' }, { group: 2 }, { stockCode: '000660' }, { stockCode: null }, { usInstrument: true }]) {
      expect(canReceiveTimeframeJump({ origin, sourceStockCode: '005930', target: { ...target, ...change }, allowCrossSymbol: true })).toBe(false);
    }
  });
});
