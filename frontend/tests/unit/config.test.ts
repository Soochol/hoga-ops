import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns parsed config on 200', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ api_url: 'http://x:9000' }),
    } as Response);
    expect(await loadConfig()).toEqual({ api_url: 'http://x:9000' });
  });

  it('falls back to default on failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('boom'));
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('falls back to default on malformed shape', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ api_url: 123 }),
    } as Response);
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});
