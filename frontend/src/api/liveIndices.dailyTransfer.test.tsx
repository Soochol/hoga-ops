import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from './client';
import { useLiveIndexCandles, type LiveIndexCandlesResponse } from './liveIndices';
import { restoreUsIndexDailyHistory } from './usIndexDailyTransfer';

const path = '/api/live/index-candles?index_id=SOX&timeframe=D&from=20261001&to=20261022';
const bar = (day: number, close = 105) => ({ trading_date: `202610${day}`, t_ms: Date.UTC(2026, 9, day),
  open: 100, high: 120, low: 90, close, volume: 321 });
const full = (): LiveIndexCandlesResponse => ({ index_id: 'SOX', timeframe: 'D', from: '20261001', to: '20261022',
  candles: [bar(20), bar(21), bar(22)], data_warnings: [], daily_history_revision: 'r1', daily_history_unchanged: false });
const tail = (close = 110): LiveIndexCandlesResponse => ({ ...full(), candles: [bar(22, close)], daily_history_unchanged: true });

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US index D history transfer', () => {
  it('fetches a full baseline and reconstructs each changed tail in the existing query cache', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(full()).mockResolvedValueOnce(tail());
    const { result } = renderHook(() => useLiveIndexCandles('SOX', 'D', '20261001', '20261022'), setup());
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(3));
    expect(spy.mock.calls[0][0]).toBe(path);
    await result.current.refetch();
    expect(spy.mock.calls[1][0]).toBe(`${path}&daily_history_revision=r1`);
    await waitFor(() => expect(result.current.data?.candles).toEqual([bar(20), bar(21), bar(22, 110)]));
    expect(result.current.data?.daily_history_revision).toBe('r1');
    expect(result.current.data?.daily_history_unchanged).toBe(false);
  });

  it('accepts full correction/rollover responses and uses their replacement revision', async () => {
    const corrected = { ...full(), daily_history_revision: 'r2', candles: [bar(20, 99), bar(21), bar(22), bar(23)] };
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(full()).mockResolvedValueOnce(corrected)
      .mockResolvedValueOnce({ ...corrected, daily_history_unchanged: true, candles: [bar(23, 115)] });
    const { result } = renderHook(() => useLiveIndexCandles('SOX', 'D', '20261001', '20261022'), setup());
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(3));
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.candles).toEqual(corrected.candles));
    await result.current.refetch();
    expect(spy.mock.calls[2][0]).toBe(`${path}&daily_history_revision=r2`);
    await waitFor(() => expect(result.current.data?.candles).toEqual([...corrected.candles.slice(0, -1), bar(23, 115)]));
  });

  it('does not reuse a revision across an index or range change', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => ({ ...full(),
      index_id: new URL(url, 'http://test').searchParams.get('index_id')!,
      from: new URL(url, 'http://test').searchParams.get('from')! }));
    const { result, rerender } = renderHook(({ id, from }: { id: 'SOX' | 'SP500'; from: string }) =>
      useLiveIndexCandles(id, 'D', from, '20261022'), { ...setup(), initialProps: { id: 'SOX' as 'SOX' | 'SP500', from: '20261001' } });
    await waitFor(() => expect(result.current.data?.index_id).toBe('SOX'));
    rerender({ id: 'SP500', from: '20261001' });
    await waitFor(() => expect(result.current.data?.index_id).toBe('SP500'));
    rerender({ id: 'SP500', from: '20260901' });
    await waitFor(() => expect(result.current.data?.from).toBe('20260901'));
    expect(spy.mock.calls).toHaveLength(3);
    expect(spy.mock.calls.every(([url]) => !url.includes('daily_history_revision='))).toBe(true);
  });

  it.each(['KOSPI', 'SOX'] as const)('%s weekly requests keep their existing shape', async id => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...full(), index_id: id, timeframe: 'W' });
    const { result } = renderHook(() => useLiveIndexCandles(id, 'W', '20261001', '20261022'), setup());
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(3));
    await result.current.refetch();
    expect(spy.mock.calls.every(([url]) => !url.includes('daily_history_revision='))).toBe(true);
  });

  it('retries an unusable tail once as a full request and supports an older server', async () => {
    const old = { ...full(), daily_history_revision: undefined };
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(full())
      .mockResolvedValueOnce({ ...tail(), daily_history_revision: 'wrong-baseline' }).mockResolvedValueOnce(old)
      .mockResolvedValueOnce(old);
    const { result } = renderHook(() => useLiveIndexCandles('SOX', 'D', '20261001', '20261022'), setup());
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(3));
    await result.current.refetch();
    expect(spy.mock.calls[2][0]).toBe(path);
    expect(result.current.data?.candles).toEqual(full().candles);
    await result.current.refetch();
    expect(spy.mock.calls[3][0]).toBe(path);
  });

  it('bounds recovery attempts and retains the last good plot on an invalid full retry', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(full())
      .mockResolvedValueOnce({ ...tail(), daily_history_revision: 'bad' }).mockResolvedValueOnce(tail());
    const { result } = renderHook(() => useLiveIndexCandles('SOX', 'D', '20261001', '20261022'), setup());
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(3));
    await result.current.refetch();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.candles).toEqual(full().candles);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('invalidates the transfer baseline when warning handling preserves additional cached rows', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(full()).mockResolvedValueOnce({
      ...full(), candles: [bar(22, 115)], data_warnings: [
        { reason: 'api_error', kind: 'vendor_api', is_failure: true, msg: 'partial history' },
      ],
    }).mockResolvedValueOnce(full());
    const { result } = renderHook(() => useLiveIndexCandles('SOX', 'D', '20261001', '20261022'), setup());
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(3));
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.daily_history_revision).toBeUndefined());
    expect(result.current.data?.candles).toEqual([bar(20), bar(21), bar(22, 115)]);
    await result.current.refetch();
    expect(spy.mock.calls[2][0]).toBe(path);
  });

  it('replaces the previous last row instead of unioning a removed or superseded provisional day', () => {
    const next = { ...tail(), candles: [bar(23)] };
    expect(restoreUsIndexDailyHistory(next, full(), 'r1')?.candles).toEqual([bar(20), bar(21), bar(23)]);
    expect(restoreUsIndexDailyHistory({ ...tail(), candles: [] }, full(), 'r1')?.candles).toEqual([bar(20), bar(21)]);
    expect(restoreUsIndexDailyHistory(tail(), undefined, 'r1')).toBeNull();
    expect(restoreUsIndexDailyHistory({ ...tail(), from: '20260901' }, full(), 'r1')).toBeNull();
    expect(restoreUsIndexDailyHistory({ ...tail(), index_id: 'SP500' }, full(), 'r1')).toBeNull();
    expect(restoreUsIndexDailyHistory({ ...tail(), candles: [bar(20)] }, full(), 'r1')).toBeNull();
  });
});
