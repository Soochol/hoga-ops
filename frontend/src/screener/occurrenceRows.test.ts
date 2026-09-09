import { expect, it } from 'vitest';
import { occurrenceRows, resultKey } from './occurrenceRows';
import { sortScreenerRows } from './sortResults';
import { resultsCsv } from './exportResults';
import type { ScreenerRow } from '../api/screener';
import type { PanelScan } from '../state/screenerPanel';

const row: ScreenerRow = {
  code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 100, change_pct: 1, trade_value_won: 1000,
  occurrences: [
    { condition_id: 'v', condition_key: 'key', date: '2021-08-12', history_match: {
      condition_id: 'v', date: '2021-08-12', volume: 19150647, maximum: 19150647, window_start: '2016-08-13', window_end: '2021-08-12' } },
    { condition_id: 'v', condition_key: 'key', date: '2021-08-11', history_match: {
      condition_id: 'v', date: '2021-08-11', volume: 18000000, maximum: 18000000, window_start: '2016-08-12', window_end: '2021-08-11' } },
  ],
};
it('uses independent keys and actual evidence for each date, including duplicate codes', () => {
  const rows = occurrenceRows([row]);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(resultKey)).size).toBe(2);
  expect(rows.map(r => r.history_matches?.[0])).toEqual(row.occurrences!.map(o => o.history_match));
  expect(sortScreenerRows(rows, { field: 'occurrence_date', direction: 'asc' }).map(r => r.occurrence_date))
    .toEqual(['2021-08-11', '2021-08-12']);
});
it('exports only the selected event and retains current quotes joined by code', () => {
  const scan: PanelScan = { rows: [row], savedId: null, savedName: null, savedUpdatedAtMs: null,
    scanKey: null, scanStatus: 'ok', warnings: [], depthValues: null, scannedAtMs: 0, basis: 'eod', dataStale: false };
  const rows = occurrenceRows([row]);
  const csv = resultsCsv(scan, [resultKey(rows[1])], [{ ...row, change_won: 0, price: 12345 }], 0);
  expect(csv).toContain('18000000주');
  expect(csv).not.toContain('19150647');
  expect(csv).toContain('"12345"');
  expect(csv.split('\r\n')).toHaveLength(3);
});
it('never invents occurrence dates for old stored scans', () => {
  const rows = occurrenceRows([{ ...row, occurrences: undefined }]);
  expect(rows).toHaveLength(1);
  expect(resultKey(rows[0])).toBe('000660');
  expect(rows[0].occurrence).toBeUndefined();
});
