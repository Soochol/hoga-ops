import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useInventoryRecapture } from './useInventoryRecapture';

// SSE stub — useCaptureQueue subscribes on mount; jsdom has no EventSource.
vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setupFetch(addItemsResp: unknown = { enqueued: [{}], deduped: [] }, status = 201) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
    const s = String(url);
    if (s.includes('/api/captures/items') && !s.includes('/retry')) {
      return { ok: status < 400, status, json: async () => addItemsResp } as Response;
    }
    if (s.includes('/api/captures/queue')) {
      return { ok: true, status: 200, json: async () => ({
        active: [], queued: [], done: [], paused: false, max_concurrent: 3,
      })} as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('useInventoryRecapture', () => {
  it('sends force_retry=true and the given dates', async () => {
    const fetchMock = setupFetch();
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => { await result.current.recapture('005930', ['20260520', '20260521']); });

    const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/captures/items'));
    expect(calls.length).toBe(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ code: '005930', dates: ['20260520', '20260521'], force_retry: true });
  });

  it('sets success status with enqueued + skipped counts', async () => {
    setupFetch({
      enqueued: [{ item_id: 'a' }, { item_id: 'b' }],
      deduped: [{ code: '005930', date: '20260520', reason: 'already_in_queue' }],
    });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => { await result.current.recapture('005930', ['20260520', '20260521', '20260522']); });

    await waitFor(() => {
      expect(result.current.status).toEqual({ kind: 'success', enqueued: 2, skipped: 1 });
    });
  });

  it('auto-clears success status after 4 seconds', async () => {
    vi.useFakeTimers();
    setupFetch({ enqueued: [{ item_id: 'a' }], deduped: [] });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    // advanceTimersByTimeAsync flushes both timers AND microtasks — required
    // because react-query's mutation lifecycle resolves through Promise.then.
    await act(async () => {
      const p = result.current.recapture('005930', ['20260520']);
      await vi.advanceTimersByTimeAsync(0);
      await p;
    });
    expect(result.current.status?.kind).toBe('success');

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(result.current.status).toBeNull();
  });

  it('sets error status on API failure and does NOT auto-clear', async () => {
    vi.useFakeTimers();
    setupFetch({ detail: { code: 'krx_credentials_missing', message: 'no creds' } }, 503);
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

    await act(async () => {
      const p = result.current.recapture('005930', ['20260520']).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await p;
    });
    expect(result.current.status?.kind).toBe('error');

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current.status?.kind).toBe('error');
  });
});
