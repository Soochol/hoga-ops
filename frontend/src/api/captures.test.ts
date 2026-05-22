import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import {
  addItems,
  getQueue,
  cancelItem,
  cancelAll,
  resumeQueue,
  dismissDone,
} from './captures';
import { apiUrl, __resetConfigForTests } from './client';

beforeAll(async () => {
  __resetConfigForTests();
  const primer = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ api_url: 'http://test.local' }),
  } as Response);
  await apiUrl('/');
  primer.mockRestore();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe('captures queue api', () => {
  it('addItems POSTs to /api/captures/items and returns EnqueueResponse', async () => {
    const f = mockFetch({ enqueued: [], deduped: [] }, true, 201);
    await addItems({ code: '005930', dates: ['20260520'], force_retry: false });
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('/api/captures/items');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      code: '005930',
      dates: ['20260520'],
      force_retry: false,
    });
  });

  it('addItems throws an Error with .code on 400 today_too_early', async () => {
    mockFetch(
      { detail: { code: 'today_too_early', message: 'pre-18', dates: ['20260522'] } },
      false,
      400,
    );
    try {
      await addItems({ code: '005930', dates: ['20260522'], force_retry: false });
      throw new Error('expected addItems to reject');
    } catch (err) {
      const e = err as { code?: string; status?: number };
      expect(e.code).toBe('today_too_early');
      expect(e.status).toBe(400);
    }
  });

  it('getQueue returns QueueSnapshot', async () => {
    mockFetch({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 });
    const snap = await getQueue();
    expect(snap.max_concurrent).toBe(3);
  });

  it('cancelItem POSTs to /items/:id/cancel; accepts 409 silently', async () => {
    const f = mockFetch({}, false, 409);
    await cancelItem('item-xyz');
    expect(f.mock.calls[0][0]).toContain('/items/item-xyz/cancel');
  });

  it('cancelAll, resumeQueue, dismissDone hit their routes', async () => {
    const f = mockFetch({});
    await cancelAll();
    await resumeQueue();
    await dismissDone();
    const urls = f.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/api/captures/cancel-all');
    expect(urls[1]).toContain('/api/captures/queue/resume');
    expect(urls[2]).toContain('/api/captures/done');
    expect(f.mock.calls[2][1]?.method).toBe('DELETE');
  });
});
