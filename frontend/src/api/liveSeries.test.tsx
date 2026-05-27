import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveSeries } from './liveSeries';
import * as client from './client';

// Minimal EventSource stub
class StubEventSource {
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState = 1;
  closed = false;
  constructor(url: string) {
    this.url = url;
    activeStubs.add(this);
  }
  close() {
    this.closed = true;
    activeStubs.delete(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}
const activeStubs = new Set<StubEventSource>();

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveSeries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    activeStubs.clear();
    (globalThis as any).EventSource = StubEventSource;
  });
  afterEach(() => {
    activeStubs.forEach((s) => s.close());
    activeStubs.clear();
  });

  it('fetches initial series and exposes empty buffers before any SSE', async () => {
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

  it('subscribes to SSE and appends incoming snapshots by kind', async () => {
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

    // Wait for EventSource to be created (useEffect after render)
    await waitFor(() => expect(activeStubs.size).toBe(1));
    const es = Array.from(activeStubs)[0]!;
    expect(es.url).toContain('/api/live/stream?code=005930');

    act(() => {
      es.emit({ t_ms: 100, kind: 'ob', total_bid_qty: 999 });
      es.emit({ t_ms: 100, kind: 'trade', trades: [] });
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

  it('closes the EventSource when code changes or component unmounts', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(activeStubs.size).toBe(1));
    const es = Array.from(activeStubs)[0]!;
    expect(es.closed).toBe(false);
    unmount();
    expect(es.closed).toBe(true);
  });
});
