import { describe, expect, it } from 'vitest';
import type { StockDate } from '../api/types';
import { sortDates, nextSortState } from './sortDates';

const row = (
  date: string,
  overrides: Partial<StockDate> = {},
): StockDate => ({
  date,
  code: '005930',
  name: '삼성전자',
  regular_session_open_ms: 0,
  regular_session_close_ms: 0,
  data_window_first_ms: 0,
  data_window_last_ms: 0,
  price_min: 0,
  price_max: 0,
  captured_at: 1_000,
  total_volume: 10_000,
  pages_collected: 100,
  file_size_bytes: 1_000_000,
  today_open: 70_000,
  today_high: 71_000,
  today_low: 69_000,
  today_close: 70_500,
  disk_state: 'complete',
  ...overrides,
});

const baseRows: StockDate[] = [
  row('20260522', { total_volume: 30, today_close: 72_000, captured_at: 3_000, pages_collected: 30, file_size_bytes: 3_000, disk_state: 'complete' }),
  row('20260521', { total_volume: 10, today_close: 70_000, captured_at: 1_000, pages_collected: 10, file_size_bytes: 1_000, disk_state: 'invalid' }),
  row('20260520', { total_volume: 20, today_close: 71_000, captured_at: 2_000, pages_collected: 20, file_size_bytes: 2_000, disk_state: 'source_partial' }),
];

describe('sortDates', () => {
  it('returns input as-is when sort is null', () => {
    const out = sortDates(baseRows, null);
    expect(out.map(r => r.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('sorts by volume desc', () => {
    const out = sortDates(baseRows, { key: 'volume', dir: 'desc' });
    expect(out.map(r => r.total_volume)).toEqual([30, 20, 10]);
  });

  it('sorts by volume asc', () => {
    const out = sortDates(baseRows, { key: 'volume', dir: 'asc' });
    expect(out.map(r => r.total_volume)).toEqual([10, 20, 30]);
  });

  it('sorts by state desc using Disk State Severity (invalid first, complete last)', () => {
    const out = sortDates(baseRows, { key: 'state', dir: 'desc' });
    expect(out.map(r => r.disk_state)).toEqual(['invalid', 'source_partial', 'complete']);
  });

  it('sorts by state asc using Disk State Severity (complete first)', () => {
    const out = sortDates(baseRows, { key: 'state', dir: 'asc' });
    expect(out.map(r => r.disk_state)).toEqual(['complete', 'source_partial', 'invalid']);
  });

  it('sorts by date asc (string compare on YYYYMMDD)', () => {
    const out = sortDates(baseRows, { key: 'date', dir: 'asc' });
    expect(out.map(r => r.date)).toEqual(['20260520', '20260521', '20260522']);
  });

  it('sorts by captured timestamp desc', () => {
    const out = sortDates(baseRows, { key: 'captured', dir: 'desc' });
    expect(out.map(r => r.captured_at)).toEqual([3_000, 2_000, 1_000]);
  });

  it('sorts by ohlc using today_close', () => {
    const out = sortDates(baseRows, { key: 'ohlc', dir: 'desc' });
    expect(out.map(r => r.today_close)).toEqual([72_000, 71_000, 70_000]);
  });

  it('sorts by pages and size', () => {
    const byPages = sortDates(baseRows, { key: 'pages', dir: 'desc' });
    expect(byPages.map(r => r.pages_collected)).toEqual([30, 20, 10]);
    const bySize = sortDates(baseRows, { key: 'size', dir: 'desc' });
    expect(bySize.map(r => r.file_size_bytes)).toEqual([3_000, 2_000, 1_000]);
  });

  it('breaks ties by date desc when sort key is not date', () => {
    const tied: StockDate[] = [
      row('20260520', { total_volume: 100 }),
      row('20260522', { total_volume: 100 }),
      row('20260521', { total_volume: 100 }),
    ];
    const out = sortDates(tied, { key: 'volume', dir: 'desc' });
    expect(out.map(r => r.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('does not apply secondary date sort when sort key is date itself', () => {
    const out = sortDates(baseRows, { key: 'date', dir: 'desc' });
    expect(out.map(r => r.date)).toEqual(['20260522', '20260521', '20260520']);
  });

  it('does not mutate the input array', () => {
    const original = [...baseRows];
    sortDates(baseRows, { key: 'volume', dir: 'asc' });
    expect(baseRows.map(r => r.date)).toEqual(original.map(r => r.date));
  });
});

describe('nextSortState', () => {
  it('null + click goes to desc', () => {
    expect(nextSortState(null, 'volume')).toEqual({ key: 'volume', dir: 'desc' });
  });

  it('desc + same key goes to asc', () => {
    expect(nextSortState({ key: 'volume', dir: 'desc' }, 'volume')).toEqual({ key: 'volume', dir: 'asc' });
  });

  it('asc + same key goes to null (unsorted)', () => {
    expect(nextSortState({ key: 'volume', dir: 'asc' }, 'volume')).toBeNull();
  });

  it('any state + different key jumps to that key desc', () => {
    expect(nextSortState({ key: 'volume', dir: 'asc' }, 'state')).toEqual({ key: 'state', dir: 'desc' });
    expect(nextSortState({ key: 'volume', dir: 'desc' }, 'date')).toEqual({ key: 'date', dir: 'desc' });
    expect(nextSortState(null, 'ohlc')).toEqual({ key: 'ohlc', dir: 'desc' });
  });
});
