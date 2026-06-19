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
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    expect(result.current.ob).toEqual([]);
    expect(result.current.trade).toEqual([]);
    expect(result.current.broker).toEqual([]);
  });

  it('subscribes over WebSocket and appends code-tagged snapshots by kind', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '005930' });
    act(() => {
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'ob', total_bid_qty: 999 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'trade', trades: [] } });
    });
    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.trade).toHaveLength(1);
    expect(result.current.broker).toHaveLength(0);
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
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.ob).toHaveLength(2));
    expect(result.current.trade).toHaveLength(1);
  });

  it('unsubscribes the code on unmount', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    unmount();
    expect(sock.parsedSent()).toContainEqual({ action: 'unsubscribe', code: '005930' });
  });
});
