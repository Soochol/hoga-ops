import { occurrenceRows, resultKey } from './occurrenceRows';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/screener';
import { useScreenerPanelStore } from '../state/screenerPanel';
import { pruneExcludedRows, scanConditions, useOccurrenceExclusions } from './useOccurrenceExclusions';
import type { PanelScan } from '../state/screenerPanel';
import type { ScreenerExclusion } from '../api/screener';
import { resultsCsv } from './exportResults';

const scan: PanelScan = {
  savedId: null, savedName: null, savedUpdatedAtMs: null, scanKey: null,
  requestJson: JSON.stringify({ conditions: [{ id: 'v', type: 'trade_value_period', params: { lookback: 3, min_eok: 1 } }] }),
  scanStatus: 'ok', warnings: [], depthValues: null, scannedAtMs: 1, basis: 'eod', dataStale: false,
  rows: [{ code: '005930', name: '삼성전자', market: 'KOSPI', price: 100, trade_value_won: 1e8, change_pct: 0,
    occurrences: [
      { condition_id: 'v', condition_key: 'value', date: '2026-09-09' },
      { condition_id: 'v', condition_key: 'value', date: '2026-09-08' },
      { condition_id: 'h', condition_key: 'high', date: '2026-09-09' },
    ],
    history_matches: [{ condition_id: 'v', date: '2026-09-09', trade_value_won: 1e8 }],
  }],
};
const excluded: ScreenerExclusion = { id: '1', condition_key: 'value', code: '005930', stock_name: '삼성전자',
  date: '2026-09-09', condition: { id: 'old-id', type: 'trade_value_period', params: { lookback: 3, min_eok: 1 } }, created_at_ms: 1 };

describe('cached/in-flight occurrence filtering', () => {
  it('removes only the matching date/meaning and exports the remaining evidence', () => {
    const result = pruneExcludedRows(scan, [excluded]);
    expect(result.rows[0].occurrences).toEqual(scan.rows[0].occurrences!.slice(1));
    expect(result.rows[0].history_matches).toEqual([]);
    expect(result.dataStale).toBe(true);
    expect(scan.rows[0].occurrences).toHaveLength(3);
    const csv = resultsCsv(result, occurrenceRows(result.rows).map(resultKey), [], 1);
    expect(csv).toContain('2026-09-08');
    expect(csv).not.toContain('100000000원 (추정)');
  });
  it('removes the stock when one required condition has no remaining occurrences', () => {
    expect(pruneExcludedRows(scan, [excluded, { ...excluded, id: '2', date: '2026-09-08' }]).rows).toEqual([]);
  });
  it('preserves object identity when another stock or condition was excluded', () => {
    expect(pruneExcludedRows(scan, [{ ...excluded, code: '000660' }])).toBe(scan);
    expect(pruneExcludedRows(scan, [{ ...excluded, condition_key: 'other' }])).toBe(scan);
  });
  it('uses executed conditions and handles missing legacy requests without guessing', () => {
    expect(scanConditions(scan)[0].id).toBe('v');
    expect(scanConditions({ ...scan, requestJson: 'bad' })).toEqual([]);
    expect(scanConditions(null)).toEqual([]);
  });
});


afterEach(() => { cleanup(); vi.restoreAllMocks(); useScreenerPanelStore.setState({ lastScan: null }); });

function renderController() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  useScreenerPanelStore.setState({ lastScan: scan });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useOccurrenceExclusions(useScreenerPanelStore(s => s.lastScan)), { wrapper });
}

it('hydration prunes first then accepts the refreshed result and its latest evidence', async () => {
  vi.spyOn(api, 'listScreenerExclusions').mockResolvedValue({ schema_version: 1, exclusions: [excluded] });
  const refreshed = { ...pruneExcludedRows(scan, [excluded]).rows[0], price: 999 };
  vi.spyOn(api, 'runScan').mockResolvedValue({ status: 'ok', warnings: [], rows: [refreshed] });
  renderController();
  await waitFor(() => expect(useScreenerPanelStore.getState().lastScan?.rows[0].price).toBe(999));
  expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(false);
});

it('a committed exclusion remains known even if reloading the list fails', async () => {
  const list = vi.spyOn(api, 'listScreenerExclusions').mockResolvedValue({ schema_version: 1, exclusions: [] });
  vi.spyOn(api, 'excludeScreenerOccurrence').mockResolvedValue(excluded);
  vi.spyOn(api, 'runScan').mockResolvedValue({ status: 'ok', warnings: [], rows: pruneExcludedRows(scan, [excluded]).rows });
  const { result } = renderController();
  await waitFor(() => expect(result.current.ready).toBe(true));
  list.mockRejectedValue(new Error('network disconnected'));
  act(() => result.current.exclude('005930', '삼성전자', scan.rows[0].occurrences![0]));
  await waitFor(() => expect(result.current.exclusions).toEqual([excluded]));
  await waitFor(() => expect(result.current.busy).toBe(false));
  expect(useScreenerPanelStore.getState().lastScan?.rows[0].occurrences).toHaveLength(2);
});
