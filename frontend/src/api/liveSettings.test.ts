import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from './client';

const BASE_SETTINGS = {
  schema_version: 1,
  storage_policy: 'ws_plus_rest' as const,
  program_trade_storage_enabled: false,
  kis_rest_bypass_enabled: false,
  heatmap_capture_enabled: true,
};

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

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

describe('usePatchLiveSettings — optimistic update', () => {
  it('flips the cache optimistically before the request resolves', async () => {
    const { usePatchLiveSettings, LIVE_SETTINGS_KEY } = await import('./liveSettings');
    let resolve!: (v: unknown) => void;
    vi.spyOn(client, 'apiCall').mockReturnValue(new Promise((r) => { resolve = r; }));
    const qc = new QueryClient();
    qc.setQueryData(LIVE_SETTINGS_KEY, BASE_SETTINGS);

    const { result } = renderHook(() => usePatchLiveSettings(), { wrapper: makeWrapper(qc) });
    act(() => { result.current.mutate({ heatmap_capture_enabled: false }); });

    // Cache reflects the patch while the PATCH is still in flight.
    await waitFor(() => {
      expect((qc.getQueryData(LIVE_SETTINGS_KEY) as { heatmap_capture_enabled: boolean }).heatmap_capture_enabled)
        .toBe(false);
    });
    resolve({ ...BASE_SETTINGS, heatmap_capture_enabled: false });
  });

  it('keeps the authoritative server value on success', async () => {
    const { usePatchLiveSettings, LIVE_SETTINGS_KEY } = await import('./liveSettings');
    // Server derives a field the patch did not send (ws_only forces program off).
    const server = {
      ...BASE_SETTINGS,
      storage_policy: 'ws_only' as const,
      program_trade_storage_enabled: false,
      heatmap_capture_enabled: false,
    };
    vi.spyOn(client, 'apiCall').mockResolvedValue(server);
    const qc = new QueryClient();
    qc.setQueryData(LIVE_SETTINGS_KEY, { ...BASE_SETTINGS, program_trade_storage_enabled: true });

    const { result } = renderHook(() => usePatchLiveSettings(), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ storage_policy: 'ws_only', heatmap_capture_enabled: false });
    });

    expect(qc.getQueryData(LIVE_SETTINGS_KEY)).toEqual(server);
  });

  it('rolls back to the previous value on error', async () => {
    const { usePatchLiveSettings, LIVE_SETTINGS_KEY } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockRejectedValue(new Error('boom'));
    const qc = new QueryClient();
    qc.setQueryData(LIVE_SETTINGS_KEY, BASE_SETTINGS);

    const { result } = renderHook(() => usePatchLiveSettings(), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ heatmap_capture_enabled: false }).catch(() => {});
    });

    // Optimistic false was rolled back to the original true.
    expect(qc.getQueryData(LIVE_SETTINGS_KEY)).toEqual(BASE_SETTINGS);
  });
});
