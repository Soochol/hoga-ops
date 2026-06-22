import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWatchlist,
  addMember,
  removeMember,
  removeFromWatchlist,
  setFolderCaptureEnabled,
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
    const fake: WatchlistResponse = { folders: [], entries: [], next_run_at_ms: 0 };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await getWatchlist();
    expect(apiCall).toHaveBeenCalledWith('/api/watchlist');
    expect(r).toEqual(fake);
  });

  it('addMember POSTs code to /folders/{fid}/members', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    await addMember('f_0000000a', '003490');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/watchlist/folders/f_0000000a/members');
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

  it('removeMember DELETEs /folders/{fid}/members/{code}', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await removeMember('f_0000000a', '005930');
    expect(apiAction).toHaveBeenCalledWith(
      '/api/watchlist/folders/f_0000000a/members/005930',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('sets folder capture flag', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      id: 'f_0000000a',
      name: '스윙',
      order: 0,
      capture_enabled: true,
    });

    const result = await setFolderCaptureEnabled('f_0000000a', true);

    expect(apiCall).toHaveBeenCalledWith('/api/watchlist/folders/f_0000000a/capture', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capture_enabled: true }),
    });
    expect(result.capture_enabled).toBe(true);
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
    const fake: EnqueueResponse = { enqueued: [], deduped: [], blocked: [] };
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
