import { expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  loadConfig: vi.fn(async () => ({ api_url: '' })),
  DEFAULT_CONFIG: { api_url: '' },
  resolveApiUrl: (config: { api_url: string }, path: string) =>
    `${config.api_url}${path.startsWith('/') ? path : `/${path}`}`,
  resolveWsUrl: (config: { api_url: string }, path: string) =>
    `${config.api_url.replace(/^http/, 'ws')}${path.startsWith('/') ? path : `/${path}`}`,
}));

import {
  createStudyView,
  deleteStudyView,
  getStudyView,
  getStudyViewSnapshot,
  listStudyViews,
  updateStudyView,
} from './studyViews';

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
  const fetchMock = vi.mocked(globalThis.fetch);

  await expect(listStudyViews()).resolves.toEqual({ schema_version: 1, saves: [] });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/study-views/saves');
  expect(fetchMock.mock.calls[0][1]).toBeUndefined();

  fetchMock.mockClear();

  await expect(getStudyViewSnapshot('view1')).resolves.toMatchObject({ code: '005930' });
  expect(fetchMock).toHaveBeenCalledWith('/api/study-views/saves/view1/snapshot', undefined);

  fetchMock.mockClear();

  await expect(getStudyView('view1')).resolves.toMatchObject({ id: 'view1' });
  expect(fetchMock).toHaveBeenCalledWith('/api/study-views/saves/view1', undefined);

  fetchMock.mockClear();

  const createBody = { name: '저장뷰' };
  await createStudyView(createBody as any);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/study-views/saves');
  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }));
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(createBody);

  fetchMock.mockClear();

  const updateBody = { name: '수정' };
  await updateStudyView('view1', updateBody as any);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/study-views/saves/view1');
  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
  }));
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(updateBody);

  fetchMock.mockClear();

  await deleteStudyView('view1');
  expect(fetchMock).toHaveBeenCalledWith('/api/study-views/saves/view1', expect.objectContaining({ method: 'DELETE' }));
});
