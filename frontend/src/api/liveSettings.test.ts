import { describe, expect, it, vi } from 'vitest';
import * as client from './client';

describe('liveSettings api', () => {
  it('gets live settings', async () => {
    const { getLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
    });

    await getLiveSettings();

    expect(client.apiCall).toHaveBeenCalledWith('/api/live/settings');
  });

  it('patches live storage policy', async () => {
    const { patchLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'rest_only',
      program_trade_storage_enabled: true,
      kis_rest_bypass_enabled: false,
    });

    const result = await patchLiveSettings({
      storage_policy: 'rest_only',
      program_trade_storage_enabled: true,
    });

    expect(client.apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_policy: 'rest_only',
        program_trade_storage_enabled: true,
      }),
    });
    expect(result.storage_policy).toBe('rest_only');
    expect(result.program_trade_storage_enabled).toBe(true);
  });

  it('patches only kis_rest_bypass_enabled', async () => {
    const { patchLiveSettings } = await import('./liveSettings');
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: true,
    });

    const result = await patchLiveSettings({ kis_rest_bypass_enabled: true });

    expect(spy).toHaveBeenCalledWith('/api/live/settings', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ kis_rest_bypass_enabled: true }),
    }));
    expect(result.kis_rest_bypass_enabled).toBe(true);
  });
});
