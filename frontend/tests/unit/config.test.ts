import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => { (globalThis as any).fetch = vi.fn(); });

  it('returns parsed config on 200', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ api_url: 'http://x:9000' }),
    });
    expect(await loadConfig()).toEqual({ api_url: 'http://x:9000' });
  });

  it('falls back to default on failure', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await loadConfig()).toEqual(DEFAULT_CONFIG);
  });
});
