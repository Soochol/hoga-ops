import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCaptureQueue, useCaptureQueueSync, CAPTURE_QUEUE_QUERY_KEY, patchQueueItem } from './useCaptureQueue';
import type { QueueItem, QueueSnapshot, PushEvent } from '../api/types';

// vi.mock factory is hoisted to top of file — declare subscribers state via
// vi.hoisted so it's available inside the factory and outside (for fireSse).
const sseState = vi.hoisted(() => {
  const subs: { current: ((e: PushEvent) => void)[] } = { current: [] };
  return { subs };
});

vi.mock('../api/eventStream', () => ({
  subscribeToCaptureEvents: (cb: (e: PushEvent) => void) => {
    sseState.subs.current.push(cb);
    return () => {
      sseState.subs.current = sseState.subs.current.filter((s) => s !== cb);
    };
  },
}));

function fireSse(e: PushEvent) {
  act(() => { sseState.subs.current.forEach((s) => s(e)); });
}

function makeWrapper(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const QUEUED_ITEM: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'queued', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
  attempt: 1,
};

beforeEach(() => {
  sseState.subs.current = [];
  vi.restoreAllMocks();
});

describe('patchQueueItem (pure)', () => {
  it('updates the matching item across active/queued/done', () => {
    const snap: QueueSnapshot = { active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 };
    const next = patchQueueItem(snap, 'i1', { phase: 'capturing', progress: { pages_done: 1, events_seen: 10, frontier_ms: 0, estimate_pct: 5, elapsed_ms: 100 } });
    expect(next.queued[0].phase).toBe('capturing');
    expect(next.queued[0].progress?.pages_done).toBe(1);
  });

  it('returns prior unchanged when item_id missing', () => {
    const snap: QueueSnapshot = { active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 };
    const next = patchQueueItem(snap, 'nope', { phase: 'capturing' });
    expect(next).toBe(snap);
  });
});

describe('useCaptureQueue SSE multiplex', () => {
  it('capture_progress patches the matching item in cache', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.queue?.queued).toHaveLength(1));

    fireSse({
      type: 'capture_progress', item_id: 'i1', code: '005930', date: '20260518', phase: 'capturing',
      progress: { pages_done: 5, events_seen: 100, frontier_ms: 0, estimate_pct: 30, elapsed_ms: 1000 },
    });

    const snap = qc.getQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY);
    expect(snap?.queued[0].progress?.pages_done).toBe(5);
    expect(snap?.queued[0].phase).toBe('capturing');
  });

  it('capture_finished invalidates the queue query (triggers refetch)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    fireSse({
      type: 'capture_finished', item_id: 'i1', code: '005930', date: '20260518',
      phase: 'done', result: null, error: null, skip_reason: null,
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('연속 capture_finished 를 한 번의 refetch 로 접는다 (O(N^2) 방지)', async () => {
    // GET /queue 는 done 버킷 전체를 돌려주고 _done 은 계속 자란다. 완료 1건마다
    // 무효화하면 N 건 백필이 크기 1,2,...,N 인 응답을 N 번 받아 전송량이 O(N^2)
    // 가 된다. 동시 워커의 완료는 거의 동시에 도착하므로 짧은 창으로 접힌다.
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    for (let i = 0; i < 8; i++) {
      fireSse({
        type: 'capture_finished', item_id: `i${i}`, code: '005930', date: '20260518',
        phase: 'done', result: null, error: null, skip_reason: null,
      });
    }

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
    // 창이 닫히고도 추가 발사가 없어야 한다.
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock.mock.calls.length - before).toBe(1);
  });

  it('접기 창이 지난 뒤의 완료는 다시 refetch 한다', async () => {
    // 접기가 "한 번만 하고 마는" 것이 되어선 안 된다 — 창마다 최신 상태를 받아야 한다.
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    const fire = (id: string) => fireSse({
      type: 'capture_finished', item_id: id, code: '005930', date: '20260518',
      phase: 'done', result: null, error: null, skip_reason: null,
    });

    fire('a');
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 400));
    fire('b');
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 2));
  });

  it('capture_queued + capture_queue_paused + capture_queue_resumed all invalidate', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    fireSse({ type: 'capture_queued', items: [QUEUED_ITEM] });
    fireSse({ type: 'capture_queue_paused', reason: 'cookie_expired', message: 'expired' });
    fireSse({ type: 'capture_queue_resumed', reason: 'user_resume' });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before + 3));
  });
});

describe('useCaptureQueue capture_dismissed handling', () => {
  const failedSnap = (): QueueSnapshot => ({
    active: [],
    queued: [],
    done: [
      {
        item_id: 'f1', code: '005930', date: '20260520', phase: 'failed',
        force_retry: false, pause_origin: false, enqueued_at_ms: 1,
        started_at_ms: null, progress: null, result: null, error: null,
        skip_reason: null, attempt: 1,
      },
      {
        item_id: 'f2', code: '005930', date: '20260521', phase: 'failed',
        force_retry: false, pause_origin: false, enqueued_at_ms: 1,
        started_at_ms: null, progress: null, result: null, error: null,
        skip_reason: null, attempt: 1,
      },
    ],
    paused: false, max_concurrent: 3,
  });

  it('removes item_ids from active/queued/done buckets when capture_dismissed arrives', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/queue')) {
        return { ok: true, status: 200, json: async () => failedSnap() } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.queue).toBeDefined());
    expect(result.current.queue?.done.length).toBe(2);

    fireSse({ type: 'capture_dismissed', item_ids: ['f1'] });

    await waitFor(() => expect(result.current.queue?.done.length).toBe(1));
    expect(result.current.queue?.done[0].item_id).toBe('f2');
  });
});

describe('useCaptureQueue retryItems mutation', () => {
  it('exposes retryItems mutation that posts to /items/retry', async () => {
    let postedBody: unknown = null;
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.includes('/items/retry')) {
        postedBody = JSON.parse(String(init?.body));
        return {
          ok: true, status: 201,
          json: async () => ({ enqueued: [], skipped: [] }),
        } as Response;
      }
      if (s.includes('/queue')) {
        return {
          ok: true, status: 200,
          json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => { useCaptureQueueSync(); return useCaptureQueue(); }, { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.queue).toBeDefined());
    act(() => { result.current.retryItems.mutate({ item_ids: ['f1', 'f2'] }); });

    await waitFor(() => expect(postedBody).toEqual({ item_ids: ['f1', 'f2'] }));
  });
});
