import { expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  loadConfig: vi.fn(async () => ({ api_url: '' })),
  DEFAULT_CONFIG: { api_url: '' },
}));

import { createStudyView, deleteStudyView, getStudyViewSnapshot, listStudyViews, updateStudyView } from './studyViews';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/study-views/saves' && !init) {
      return new Response(JSON.stringify({ schema_version: 1, saves: [] }), { status: 200 });
    }
    if (path.endsWith('/snapshot')) {
      return new Response(JSON.stringify({ schema_version: 1, code: '005930' }), { status: 200 });
    }
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ id: 'view1', name: '저장뷰' }), { status: init?.method === 'POST' ? 201 : 200 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

it('calls study view endpoints', async () => {
  await expect(listStudyViews()).resolves.toEqual({ schema_version: 1, saves: [] });
  await expect(getStudyViewSnapshot('view1')).resolves.toMatchObject({ code: '005930' });
  await createStudyView({ name: '저장뷰' } as any);
  await updateStudyView('view1', { name: '수정' } as any);
  await deleteStudyView('view1');
  expect(globalThis.fetch).toHaveBeenCalledWith('/api/study-views/saves', expect.anything());
  expect(globalThis.fetch).toHaveBeenCalledWith('/api/study-views/saves/view1', expect.objectContaining({ method: 'PUT' }));
});
