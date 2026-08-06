import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getHeatmap,
  addToHeatmapFolder,
  removeFromHeatmap,
  removeFromHeatmapFolder,
  moveHeatmapEntries,
  createHeatmapFolder,
  reorderHeatmapEntries,
  type HeatmapResponse,
} from './heatmap';

vi.mock('./client', () => ({
  apiCall: vi.fn(),
  apiAction: vi.fn(),
}));

import { apiCall, apiAction } from './client';

beforeEach(() => {
  vi.mocked(apiCall).mockReset();
  vi.mocked(apiAction).mockReset();
});

describe('heatmap api client (independent of watchlist, ADR-0068)', () => {
  it('getHeatmap hits /api/heatmap and carries capture markers + next run', async () => {
    // ADR-0142: 히트맵이 일일 캡처 대상이 되면서 두 필드가 생겼다. 마커는 code 키 맵이다
    // — entry 배열과 나란히 오지, entry 안에 들어오지 않는다.
    const fake: HeatmapResponse = {
      folders: [], entries: [],
      capture_markers: { '005930': '20260806' },
      next_run_at_ms: 1_754_000_000_000,
    };
    vi.mocked(apiCall).mockResolvedValueOnce(fake);
    const r = await getHeatmap();
    expect(apiCall).toHaveBeenCalledWith('/api/heatmap');
    expect(r).toEqual(fake);
    expect(r.capture_markers['005930']).toBe('20260806');
  });

  it('exposes no folder-less add (v3, ADR-0112 — the only add is folder-scoped)', async () => {
    const mod = await import('./heatmap');
    expect('addToHeatmap' in mod).toBe(false);
  });

  it('addToHeatmapFolder POSTs code to the folder member command', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ code: '005930', name: '삼성전자', folder_id: 'f_0000000a', order: 0 });
    await addToHeatmapFolder('005930', 'f_0000000a');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/heatmap/folders/f_0000000a/members');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ code: '005930' });
  });

  it('removeFromHeatmap DELETEs /api/heatmap/{code}', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await removeFromHeatmap('003490');
    expect(apiAction).toHaveBeenCalledWith(
      '/api/heatmap/003490',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('moveHeatmapEntries POSTs codes + from_folder_id + folder_id to /api/heatmap/move', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await moveHeatmapEntries(['005930', '003490'], 'f_0000000b', 'f_0000000a');
    const [path, init] = vi.mocked(apiAction).mock.calls[0];
    expect(path).toBe('/api/heatmap/move');
    expect(JSON.parse(init?.body as string)).toEqual({
      codes: ['005930', '003490'], from_folder_id: 'f_0000000b', folder_id: 'f_0000000a',
    });
  });

  it('removeFromHeatmapFolder DELETEs the folder-scoped member path', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await removeFromHeatmapFolder('003490', 'f_0000000a');
    expect(apiAction).toHaveBeenCalledWith(
      '/api/heatmap/folders/f_0000000a/members/003490',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('reorderHeatmapEntries PUTs folder_id + ordered_codes to /api/heatmap/reorder', async () => {
    vi.mocked(apiAction).mockResolvedValueOnce(undefined);
    await reorderHeatmapEntries('f_0000000a', ['000660', '005930']);
    const [path, init] = vi.mocked(apiAction).mock.calls[0];
    expect(path).toBe('/api/heatmap/reorder');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ folder_id: 'f_0000000a', ordered_codes: ['000660', '005930'] });
  });

  it('createHeatmapFolder POSTs name to /api/heatmap/folders', async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({ id: 'f_0000000a', name: '반도체', order: 0 });
    await createHeatmapFolder('반도체');
    const [path, init] = vi.mocked(apiCall).mock.calls[0];
    expect(path).toBe('/api/heatmap/folders');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ name: '반도체' });
  });

  it('exposes no capture catch-up endpoints (heatmap drives no captures)', async () => {
    const mod = await import('./heatmap');
    expect('catchupNow' in mod).toBe(false);
    expect('catchupAll' in mod).toBe(false);
  });
});
