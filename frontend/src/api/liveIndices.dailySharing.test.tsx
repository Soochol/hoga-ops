import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import * as client from './client';
import { isLiveIndexId } from '../live/liveInstrument';
import { useLiveIndexCandles, type LiveIndexCandlesResponse } from './liveIndices';

const broad = '20261001';
const narrow = '20261020';
const to = '20261022';
const key = (from: string) => ['live', 'index-candles', 'SOX', 'D', from, to];
function response(url: string): LiveIndexCandlesResponse {
  const p = new URL(url, 'http://test').searchParams;
  const from = p.get('from')!;
  const indexId = p.get('index_id');
  if (!indexId || !isLiveIndexId(indexId)) throw new Error('Invalid fixture index');
  return { index_id: indexId, timeframe: 'D', from, to: p.get('to')!,
    candles: [1, 19, 20, 21, 22].filter(day => `202610${String(day).padStart(2, '0')}` >= from).map(day => ({
      trading_date: `202610${String(day).padStart(2, '0')}`, t_ms: Date.UTC(2026, 9, day + 1),
      open: day, high: day, low: day, close: day, volume: 0,
    })), data_warnings: [], daily_history_revision: `revision-${from}`,
    minute_metadata: { market_timezone: 'America/New_York', source: 'kis', history_scope: 'latest_snapshot',
      delay_status: 'unverified', session_scope: 'regular', available_from_ms: null, available_to_ms: null,
      last_successful_check_at_ms: null, refresh_status: 'normal', messages: [], refresh_interval_ms: 2000 } };
}
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T15:00:00Z'));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}
async function tick(ms = 10) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('US index daily query sharing', () => {
  it.each(['broad-first', 'narrow-first'] as const)('converges staggered %s observers and disposes their polling', async order => {
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => response(url));
    const env = setup();
    const first = renderHook(() => useLiveIndexCandles('SOX', 'D', order === 'broad-first' ? broad : narrow, to), env);
    await tick(710);
    const second = renderHook(() => useLiveIndexCandles('SOX', 'D', order === 'broad-first' ? narrow : broad, to), env);
    await tick();
    const small = order === 'broad-first' ? second : first;
    expect(small.result.current.data?.candles.map(row => row.close)).toEqual([20, 21, 22]);
    expect(env.qc.getQueryData<LiveIndexCandlesResponse>(key(broad))?.candles).toHaveLength(5);
    const before = spy.mock.calls.length;
    await tick(6000);
    expect(spy.mock.calls.slice(before)).toHaveLength(3);
    expect(small.result.current.data?.from).toBe(narrow);
    expect(small.result.current.data?.daily_history_revision).toBeUndefined();
    expect(spy.mock.calls.slice(before).every(([url]) => url.includes(`from=${broad}`) && url.includes(`daily_history_revision=revision-${broad}`))).toBe(true);
    (order === 'broad-first' ? first : second).unmount();
    const afterOwner = spy.mock.calls.length;
    await tick(4000);
    expect(spy.mock.calls.slice(afterOwner)).toHaveLength(2);
    small.unmount();
    const afterLast = spy.mock.calls.length;
    await tick(6000);
    expect(spy).toHaveBeenCalledTimes(afterLast);
    env.qc.clear();
  });

  it('keeps confirmed consumers on a partial source and retains its 503 backoff', async () => {
    let partial = false;
    let fail = false;
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => {
      if (fail) throw new Error('503');
      const data = response(url);
      return partial ? { ...data, candles: data.candles.slice(-1), data_warnings: [
        { batch: 'history', reason: 'api_error', kind: 'vendor_api', is_failure: true, msg: 'partial history' },
      ] } : data;
    });
    const env = setup();
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    const large = renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    partial = true;
    await act(async () => { await large.result.current.refetch(); });
    await tick();
    expect(small.result.current.data?.data_warnings).toHaveLength(1);
    expect(small.result.current.data?.candles.map(row => row.close)).toEqual([20, 21, 22]);
    expect(env.qc.getQueryCache().find({ queryKey: key(narrow) })?.getObserversCount()).toBe(0);
    fail = true;
    await act(async () => { await large.result.current.refetch(); });
    await tick();
    expect(small.result.current.isError).toBe(true);
    const before = spy.mock.calls.length;
    await tick(59_000);
    expect(spy).toHaveBeenCalledTimes(before);
    await tick(1000);
    expect(spy).toHaveBeenCalledTimes(before + 1);
    expect(spy.mock.calls.at(-1)?.[0]).toContain(`from=${broad}`);
    env.qc.clear();
  });

  it('ignores inactive and pending sources, and does not join their failed partial history', async () => {
    const env = setup();
    const wideUrl = `/api/live/index-candles?index_id=SOX&timeframe=D&from=${broad}&to=${to}`;
    env.qc.setQueryData(key(broad), response(wideUrl));
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => response(url));
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    expect(spy.mock.calls[0][0]).toContain(`from=${narrow}`);
    let finish: ((data: LiveIndexCandlesResponse) => void) | undefined;
    spy.mockImplementation(url => url.includes(`from=${broad}`) ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(response(url)));
    env.qc.removeQueries({ queryKey: key(broad) });
    const large = renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    expect(small.result.current.data?.candles).toHaveLength(3);
    expect(env.qc.getQueryCache().find({ queryKey: key(narrow) })?.getObserversCount()).toBe(1);
    await act(async () => { finish?.({ ...response(wideUrl), data_warnings: [{ batch: 'history', reason: 'api_error', kind: 'vendor_api', is_failure: true, msg: 'partial' }] }); });
    await tick();
    expect(env.qc.getQueryCache().find({ queryKey: key(narrow) })?.getObserversCount()).toBe(1);
    spy.mockRejectedValue(new Error('503'));
    await act(async () => { await large.result.current.refetch(); });
    await tick();
    expect(small.result.current.isError).toBe(false);
    env.qc.clear();
  });

  it('settles a cached range extension immediately without widening a pending placeholder', async () => {
    const env = setup();
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => response(url));
    renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    const view = renderHook(({ from }) => useLiveIndexCandles('SOX', 'D', from, to), { ...env, initialProps: { from: narrow } });
    await tick();
    const before = spy.mock.calls.length;
    view.rerender({ from: '20261019' });
    await tick();
    expect(spy).toHaveBeenCalledTimes(before);
    expect(view.result.current.data?.from).toBe('20261019');
    expect(view.result.current.data?.candles.map(row => row.close)).toEqual([19, 20, 21, 22]);
    spy.mockImplementation(() => new Promise(() => {}));
    view.rerender({ from: '20260901' });
    await tick();
    expect(view.result.current.isPlaceholderData).toBe(true);
    expect(view.result.current.data?.from).toBe(broad);
    expect(spy.mock.calls.at(-1)?.[0]).toContain('from=20260901');
    expect(spy.mock.calls.at(-1)?.[0]).not.toContain('daily_history_revision');
    env.qc.clear();
  });

  it('does not transfer confirmation to a replacement query with partial raw data', async () => {
    const env = setup();
    let partial = false;
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => {
      const data = response(url);
      return partial && url.includes(`from=${broad}`) ? { ...data, data_warnings: [
        { batch: 'history', reason: 'api_error', kind: 'vendor_api', is_failure: true, msg: 'new incomplete source' },
      ] } : data;
    });
    const large = renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    large.unmount();
    partial = true;
    act(() => { env.qc.removeQueries({ queryKey: key(broad), exact: true }); });
    renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    await act(async () => { await small.result.current.refetch(); });
    expect(spy.mock.calls.at(-1)?.[0]).toContain(`from=${narrow}`);
    expect(small.result.current.data?.data_warnings).toEqual([]);
    env.qc.clear();
  });

  it('preserves the previous plot while a disjoint range is pending', async () => {
    const env = setup();
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => response(url));
    const view = renderHook(({ from, end }) => useLiveIndexCandles('SOX', 'D', from, end), {
      ...env, initialProps: { from: broad, end: to },
    });
    await tick();
    const previous = view.result.current.data;
    spy.mockImplementation(() => new Promise(() => {}));
    view.rerender({ from: '20260901', end: '20260930' });
    await tick();
    expect(view.result.current.isPlaceholderData).toBe(true);
    expect(view.result.current.data?.from).toBe(broad);
    expect(view.result.current.data?.candles).toEqual(previous?.candles);
    env.qc.clear();
  });

  it('supports a legacy source with only minimal daily metadata', async () => {
    const env = setup();
    vi.spyOn(client, 'apiCall').mockImplementation(async url => ({ ...response(url),
      daily_metadata: { refresh_status: 'normal', latest_bar_date: to },
    }));
    renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    expect(small.result.current.data?.candles.map(row => row.close)).toEqual([20, 21, 22]);
    expect(small.result.current.data?.from).toBe(narrow);
    expect(small.result.current.data?.daily_metadata?.latest_bar_date).toBe(to);
    expect(small.result.current.isError).toBe(false);
    env.qc.clear();
  });

  it.each([
    { reason: 'missing coverage', missing: [{ start: broad, end: narrow }] },
    { reason: 'truncated history', truncated: true },
    { reason: 'partial refresh', refresh_status: 'partial' },
    { reason: 'unconfigured source', refresh_status: 'unconfigured' },
    { reason: 'failed source', refresh_status: 'error' },
  ])('does not newly adopt a source with $reason', async incomplete => {
    const env = setup();
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => ({ ...response(url),
      ...(url.includes(`from=${broad}`) ? { daily_metadata: { refresh_status: 'normal', ...incomplete } } : {}),
    }));
    renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    await act(async () => { await small.result.current.refetch(); });
    expect(spy.mock.calls.at(-1)?.[0]).toContain(`from=${narrow}`);
    expect(small.result.current.data?.candles).toHaveLength(3);
    env.qc.clear();
  });

  it('keeps one bounded partial walk for joined consumers', async () => {
    const env = setup();
    let partial = false;
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => ({ ...response(url), minute_metadata: undefined,
      daily_metadata: { refresh_status: partial ? 'partial' : 'normal',
        completed: [{ start: broad, end: to }], missing: partial ? [{ start: broad, end: '20261019' }] : [], truncated: partial },
    }));
    const large = renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    partial = true;
    await act(async () => { await large.result.current.refetch(); });
    await tick(20_000);
    expect(spy).toHaveBeenCalledTimes(8);
    expect(spy.mock.calls.every(([url]) => url.includes(`from=${broad}`))).toBe(true);
    expect(small.result.current.data?.daily_metadata).toMatchObject({
      refresh_status: 'partial', completed: [{ start: narrow, end: to }], missing: [], truncated: true,
    });
    env.qc.clear();
  });

  it('ignores a disabled covering observer even when its raw cache is healthy', async () => {
    const env = setup();
    const data = response(`/api/live/index-candles?index_id=SOX&timeframe=D&from=${broad}&to=${to}`);
    renderHook(() => useQuery({ queryKey: key(broad), initialData: data, enabled: false }), env);
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => response(url));
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', narrow, to), env);
    await tick();
    expect(spy.mock.calls[0][0]).toContain(`from=${narrow}`);
    expect(small.result.current.data?.candles).toHaveLength(3);
    env.qc.clear();
  });

  it.each(['20261021', null])('preserves completed-history metadata with a provisional candle and latest date %s', async latest => {
    const env = setup();
    vi.spyOn(client, 'apiCall').mockImplementation(async url => ({ ...response(url), daily_metadata: {
      refresh_status: 'normal', latest_bar_date: latest, completed: [{ start: broad, end: '20261021' }], missing: [],
    } }));
    renderHook(() => useLiveIndexCandles('SOX', 'D', broad, to), env);
    await tick();
    const small = renderHook(() => useLiveIndexCandles('SOX', 'D', to, to), env);
    await tick();
    expect(small.result.current.data?.candles.map(row => row.close)).toEqual([22]);
    expect(small.result.current.data?.daily_metadata).toMatchObject({ latest_bar_date: null, completed: [] });
    env.qc.clear();
  });

  it('keeps expansion placeholders honest and shares VIX only with the same exact end', async () => {
    const env = setup();
    let finish: ((data: LiveIndexCandlesResponse) => void) | undefined;
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async url => response(url));
    const view = renderHook(({ from }) => useLiveIndexCandles('VIX', 'D', from, to), { ...env, initialProps: { from: narrow } });
    await tick();
    spy.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    view.rerender({ from: broad });
    await tick();
    expect(view.result.current.isPlaceholderData).toBe(true);
    expect(view.result.current.data?.from).toBe(narrow);
    await act(async () => { finish?.(response(`/api/live/index-candles?index_id=VIX&timeframe=D&from=${broad}&to=${to}`)); });
    await tick();
    expect(view.result.current.data?.candles).toHaveLength(5);
    spy.mockImplementation(async url => response(url));
    const vix = renderHook(() => useLiveIndexCandles('VIX', 'D', narrow, to), env);
    renderHook(() => useLiveIndexCandles('VIX', 'D', narrow, '20261021'), env);
    await tick();
    expect(vix.result.current.data?.candles).toHaveLength(3);
    await act(async () => { await vix.result.current.refetch(); });
    expect(spy.mock.calls.at(-1)?.[0]).toContain(`index_id=VIX&timeframe=D&from=${broad}`);
    expect(spy.mock.calls.filter(([url]) => url.includes('to=20261022'))).toHaveLength(3);
    env.qc.clear();
  });
});
