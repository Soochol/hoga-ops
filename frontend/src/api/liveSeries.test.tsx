import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveSeries } from './liveSeries';
import * as client from './client';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveSeries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFakeWebSocket();
    resetWs();
    vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
  });
  afterEach(() => { resetWs(); });

  it('fetches initial series and exposes empty buffers before any WebSocket frames', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      date: '20260527',
      session_open_ms: 1000,
      session_close_ms: null,
      is_open: true,
      snapshots: [],
      trades: [],
      brokers: [],
      programs: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    expect(result.current.ob).toEqual([]);
    expect(result.current.trade).toEqual([]);
    expect(result.current.broker).toEqual([]);
    expect(result.current.program).toEqual([]);
  });

  it('subscribes over WebSocket and appends code-tagged snapshots by kind', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [], programs: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '005930' });
    act(() => {
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'ob', total_bid_qty: 999 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'trade', trades: [] } });
      sock.message({
        ch: 'live',
        code: '005930',
        data: {
          t_ms: 101,
          kind: 'program',
          venue: 'KRX',
          net_qty: 20,
          net_amount: 2_000_000,
        },
      });
    });
    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.trade).toHaveLength(1);
    expect(result.current.broker).toHaveLength(0);
    expect(result.current.program).toHaveLength(1);
  });

  it('hydrates from initial series.snapshots/trades/brokers', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      date: '20260527',
      session_open_ms: 1000,
      session_close_ms: null,
      is_open: true,
      snapshots: [{ t_ms: 50 }, { t_ms: 60 }],
      trades: [{ t_ms: 50 }],
      brokers: [],
      programs: [{ t_ms: 70, kind: 'program', net_qty: 10, net_amount: 1_000_000 }],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.ob).toHaveLength(2));
    expect(result.current.trade).toHaveLength(1);
    expect(result.current.program).toHaveLength(1);
  });

  it('ignores a stale initial series payload for a previous code', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      date: '20260527',
      session_open_ms: 1000,
      session_close_ms: null,
      is_open: true,
      snapshots: [{ t_ms: 50, kind: 'ob', total_ask_qty: 12345 }],
      trades: [{ t_ms: 50, kind: 'trade', trades: [] }],
      brokers: [{ t_ms: 50, kind: 'broker', broker: 'stale' }],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('000660', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.initial).toBeUndefined();
    expect(result.current.ob).toEqual([]);
    expect(result.current.trade).toEqual([]);
    expect(result.current.broker).toEqual([]);
  });

  it('unsubscribes the code on unmount', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    unmount();
    expect(sock.parsedSent()).toContainEqual({ action: 'unsubscribe', code: '005930' });
  });

  it('filters ob/trade by the selected venue at the source (KRX drops NXT-tagged frames)', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    act(() => {
      // KRX 태그·무태그(=KRX)는 통과, NXT 태그는 KRX 선택에서 소스에서 배제된다.
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'ob', venue: 'KRX', total_bid_qty: 1 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 101, kind: 'ob', venue: 'NXT', total_bid_qty: 2 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 102, kind: 'trade', venue: 'NXT', trades: [] } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 103, kind: 'trade', trades: [] } });
    });
    // ob: KRX 태그 1건만(NXT 배제). trade: 무태그 1건만(NXT 배제).
    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.ob[0]).toMatchObject({ venue: 'KRX' });
    expect(result.current.trade).toHaveLength(1);
  });
});
