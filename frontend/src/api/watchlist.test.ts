import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  type WatchlistResponse,
} from './watchlist';

vi.mock('./client', () => ({
  apiCall: vi.fn(),
  apiAction: vi.fn(),
}));

import { apiCall, apiAction } from './client';

beforeEach(() => {
  vi.mocked(apiCall).mockReset();
  vi.mocked(apiAction).mockReset();
});

describe('watchlist api client', () => {
  it('getWatchlist hits /api/watchlist', async () => {
    const fake: WatchlistResponse = { entries: [], next_run_at_ms: 0 };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await getWatchlist();
    expect(apiCall).toHaveBeenCalledWith('/api/watchlist');
    expect(r).toEqual(fake);
  });

  it('addToWatchlist POSTs JSON body with the code', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    await addToWatchlist('003490');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ code: '003490' });
  });

  it('removeFromWatchlist DELETEs /api/watchlist/{code}', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await removeFromWatchlist('003490');
    expect(apiAction).toHaveBeenCalledWith(
      '/api/watchlist/003490',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

import {
  catchupNow,
  catchupAll,
  type EnqueueResponse,
  type ManualCatchupAllResponse,
} from './watchlist';

describe('watchlist manual catch-up', () => {
  it('catchupNow POSTs to /api/watchlist/{code}/catchup', async () => {
    const fake: EnqueueResponse = { enqueued: [], deduped: [] };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await catchupNow('003490');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist/003490/catchup');
    expect(init?.method).toBe('POST');
    expect(r).toEqual(fake);
  });

  it('catchupAll POSTs to /api/watchlist/catchup', async () => {
    const fake: ManualCatchupAllResponse = { results: [] };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await catchupAll();
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist/catchup');
    expect(init?.method).toBe('POST');
    expect(r).toEqual(fake);
  });
});
