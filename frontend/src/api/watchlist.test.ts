import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWatchlist,
  addMember,
  removeMember,
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
    const fake: WatchlistResponse = { folders: [], entries: [], memos: [], next_run_at_ms: 0 };
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
    // at 미전달은 명시적 null 로 나간다(addMemo 와 같은 관용구) — 키를 통째로 빼면
    // 백엔드 기본값에 기대게 되고, 그 기본값이 바뀌면 여기선 안 보인다.
    expect(JSON.parse(init?.body as string)).toEqual({ code: '003490', at: null });
  });

  it('addMember carries `at` (행 우클릭 "위에 종목 추가") in the body', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    await addMember('f_0000000a', '003490', 2);
    const [, init] = vi.mocked(apiCall).mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ code: '003490', at: 2 });
  });

  it('addMember sends at:0 as 0, not null', async () => {
    // `at ?? null` 이 아니라 `at || null` 이면 0(맨 위 삽입)이 조용히 "맨 아래" 가 된다.
    vi.mocked(apiCall).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    await addMember('f_0000000a', '003490', 0);
    const [, init] = vi.mocked(apiCall).mock.calls[0];
    expect(JSON.parse(init?.body as string).at).toBe(0);
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
