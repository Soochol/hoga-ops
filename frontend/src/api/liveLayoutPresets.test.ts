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
  createLiveLayoutPreset,
  deleteLiveLayoutPreset,
  listLiveLayoutPresets,
  updateLiveLayoutPreset,
} from './liveLayoutPresets';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/live-layout-presets' && !init) {
      return new Response(JSON.stringify({ schema_version: 1, presets: [] }), { status: 200 });
    }
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ id: 'p1', name: '단타용' }), {
      status: init?.method === 'POST' ? 201 : 200,
    });
  }) as never;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

it('calls live layout preset endpoints', async () => {
  const fetchMock = vi.mocked(globalThis.fetch);

  await expect(listLiveLayoutPresets()).resolves.toEqual({ schema_version: 1, presets: [] });
  expect(fetchMock.mock.calls[0][0]).toBe('/api/live-layout-presets');
  expect(fetchMock.mock.calls[0][1]).toBeUndefined();

  fetchMock.mockClear();
  const body = { name: '단타용', payload: {} } as never;
  await createLiveLayoutPreset(body);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/live-layout-presets');
  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }));

  fetchMock.mockClear();
  await updateLiveLayoutPreset('p1', body);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/live-layout-presets/p1');
  expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'PUT' }));

  fetchMock.mockClear();
  await deleteLiveLayoutPreset('p1');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/live-layout-presets/p1',
    expect.objectContaining({ method: 'DELETE' }),
  );
});
