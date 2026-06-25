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
});
