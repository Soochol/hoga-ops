import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from './client';

const BASE_SETTINGS = {
  schema_version: 1,
  kis_rest_bypass_enabled: false,
  screener_depth_autocollect: false,
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
    });

    await getLiveSettings();

    expect(client.apiCall).toHaveBeenCalledWith('/api/live/settings');
  });

  it('patches screener depth autocollect', async () => {
    const { patchLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      schema_version: 1,
      kis_rest_bypass_enabled: false,
      screener_depth_autocollect: true,
    });

    const result = await patchLiveSettings({ screener_depth_autocollect: true });

    expect(client.apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screener_depth_autocollect: true }),
    });
    expect(result.screener_depth_autocollect).toBe(true);
  });

  it('patches only kis_rest_bypass_enabled', async () => {
    const { patchLiveSettings } = await import('./liveSettings');
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      schema_version: 1,
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
    act(() => { result.current.mutate({ screener_depth_autocollect: true }); });

    // Cache reflects the patch while the PATCH is still in flight.
    await waitFor(() => {
      expect((qc.getQueryData(LIVE_SETTINGS_KEY) as { screener_depth_autocollect: boolean }).screener_depth_autocollect)
        .toBe(true);
    });
    resolve({ ...BASE_SETTINGS, screener_depth_autocollect: true });
  });

  it('keeps the authoritative server value on success', async () => {
    const { usePatchLiveSettings, LIVE_SETTINGS_KEY } = await import('./liveSettings');
    // Server may derive fields the patch did not send — server value wins.
    const server = {
      ...BASE_SETTINGS,
      kis_rest_bypass_enabled: true,  // 패치가 보내지 않은 서버-유도 필드
    };
    vi.spyOn(client, 'apiCall').mockResolvedValue(server);
    const qc = new QueryClient();
    qc.setQueryData(LIVE_SETTINGS_KEY, { ...BASE_SETTINGS, screener_depth_autocollect: true });

    const { result } = renderHook(() => usePatchLiveSettings(), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ screener_depth_autocollect: false });
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
      await result.current.mutateAsync({ screener_depth_autocollect: true }).catch(() => {});
    });

    // Optimistic true was rolled back to the original false.
    expect(qc.getQueryData(LIVE_SETTINGS_KEY)).toEqual(BASE_SETTINGS);
  });
});
