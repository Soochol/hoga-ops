import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from './client';
import { useLiveIndexCandles, type LiveIndexCandlesResponse } from './liveIndices';
import { applySectorTick } from './sectorTickOverlay';
import type { LiveIndexId } from '../live/liveInstrument';

const at = (clock: string) => Date.parse(`2026-10-22T${clock}+09:00`);
const snapshot = (id: LiveIndexId = 'KOSPI'): LiveIndexCandlesResponse => ({
  index_id: id, timeframe: '1m', from: '20261001', to: '20261022', data_warnings: [],
  candles: [{ t_ms: at('10:00:00'), open: 100, high: 105, low: 95, close: 101, volume: 321 }],
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const tick = (clock: string, value: number) => act(() => applySectorTick(qc, {
    type: 'market_sector_tick', sectors: { '001': { t_ms: at(clock), value } },
  }));
  return { qc, wrapper, tick };
}

describe('index candles using the existing market WS channel', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(at('10:00:10')));
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('updates independently of the market quote baseline without another API request', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(snapshot());
    const { qc, wrapper, tick } = setup();
    const { result } = renderHook(() => useLiveIndexCandles('KOSPI', '1m', '20261001', '20261022'), { wrapper });
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(101));
    tick('10:00:11', 110);
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(110));
    expect(result.current.data?.candles[0].volume).toBe(321);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(['market-index-quotes'])).toBeUndefined();
    expect(qc.getQueryData<LiveIndexCandlesResponse>(['live', 'index-candles', 'KOSPI', '1m', '20261001', '20261022'])?.candles[0].close).toBe(101);
  });

  it('keeps prices received during a slow REST request and uses REST corrections on the completed bar', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(snapshot());
    const { wrapper, tick } = setup();
    const { result } = renderHook(() => useLiveIndexCandles('KOSPI', '1m', '20261001', '20261022'), { wrapper });
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(101));
    let finish!: (data: LiveIndexCandlesResponse) => void;
    spy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(Date.now).mockReturnValue(at('10:01:10'));
    let pending!: ReturnType<typeof result.current.refetch>;
    act(() => { pending = result.current.refetch(); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    tick('10:01:11', 120);
    await waitFor(() => expect(result.current.data?.candles.at(-1)?.close).toBe(120));
    await act(async () => {
      finish({ ...snapshot(), candles: [{ ...snapshot().candles[0], close: 103 }, {
        t_ms: at('10:01:00'), open: 103, high: 104, low: 102, close: 103, volume: 50,
      }] });
      await pending;
    });
    await waitFor(() => expect(result.current.data?.candles.at(-1)?.volume).toBe(50));
    expect(result.current.data?.candles.at(-1)?.close).toBe(120);
    expect(result.current.data?.candles[0].close).toBe(103);
  });

  it('keeps the same realtime tail across network failure and clears it when the subject changes', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(snapshot());
    const { wrapper, tick } = setup();
    const { result, rerender } = renderHook(({ id }: { id: LiveIndexId }) => useLiveIndexCandles(id, '1m', '20261001', '20261022'),
      { wrapper, initialProps: { id: 'KOSPI' as LiveIndexId } });
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(101));
    tick('10:00:11', 110);
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(110));
    spy.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.data?.candles[0].close).toBe(110);
    spy.mockResolvedValueOnce(snapshot('KOSDAQ'));
    rerender({ id: 'KOSDAQ' });
    await waitFor(() => expect(result.current.data?.index_id).toBe('KOSDAQ'));
    expect(result.current.data?.candles[0].close).toBe(101);
  });
});
