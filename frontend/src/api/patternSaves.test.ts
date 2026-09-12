import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetConfigForTests } from './client';
import { deletePatternSave } from './screener';

vi.mock('../config', () => ({
  loadConfig: async () => ({ api_url: 'http://test' }),
  resolveApiUrl: (config: { api_url: string }, path: string) => `${config.api_url}${path}`,
}));

beforeEach(() => __resetConfigForTests());
afterEach(() => vi.restoreAllMocks());

it('accepts the server empty 204 response as a successful pattern save deletion', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await expect(deletePatternSave('saved-pattern')).resolves.toBeUndefined();
  expect(fetchSpy).toHaveBeenCalledWith('http://test/api/screener/pattern-saves/saved-pattern', { method: 'DELETE' });
});

it('preserves deletion failure so the caller does not remove a save that still exists', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(
    { detail: { code: 'write_failed', message: '삭제하지 못했습니다' } }, { status: 500 },
  ));
  await expect(deletePatternSave('saved-pattern')).rejects.toMatchObject({
    status: 500, code: 'write_failed', message: '삭제하지 못했습니다',
  });
});
