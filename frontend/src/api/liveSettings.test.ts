import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from './client';

const BASE_SETTINGS = {
  schema_version: 1,
  rest_bypass_enabled: false,
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
      rest_bypass_enabled: false,
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

  it('patches only rest_bypass_enabled', async () => {
    const { patchLiveSettings } = await import('./liveSettings');
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      schema_version: 1,
      rest_bypass_enabled: true,
    });

    const result = await patchLiveSettings({ rest_bypass_enabled: true });

    expect(spy).toHaveBeenCalledWith('/api/live/settings', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ rest_bypass_enabled: true }),
    }));
    expect(result.rest_bypass_enabled).toBe(true);
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
      rest_bypass_enabled: true,  // 패치가 보내지 않은 서버-유도 필드
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

  /**
   * 탭 전역 설정. 이 설정의 진실은 **서버**라 값을 복제하지 않고 "다시 읽어라"는
   * 핑만 보낸다. 그래서 검사 대상은 저장된 문자열의 내용이 아니라
   * **매 PATCH 마다 값이 달라지는가**다 — 같은 값을 다시 쓰면 storage 이벤트가
   * 발생하지 않아, 두 번째 변경부터 다른 탭이 조용히 못 받는다.
   */
  it('성공한 PATCH 마다 매번 다른 핑 값을 쓴다 (같은 값이면 storage 이벤트가 안 뜬다)', async () => {
    const { usePatchLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockResolvedValue(BASE_SETTINGS);
    // ⚠ 시계를 **고정한다**. 안 그러면 두 PATCH 가 다른 ms 에 떨어지는 것만으로
    // 값이 갈려서, 카운터를 지워도 테스트가 통과한다(실측: 지웠을 때 같은 ms 라
    // 우연히 잡혔지만, 느린 머신에서는 조용히 위양성이 된다).
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const qc = new QueryClient();
    localStorage.clear();

    const { result } = renderHook(() => usePatchLiveSettings(), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ screener_depth_autocollect: true });
    });
    const first = localStorage.getItem('live.settings.ping.v1');
    await act(async () => {
      await result.current.mutateAsync({ screener_depth_autocollect: false });
    });
    const second = localStorage.getItem('live.settings.ping.v1');

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    // 이 파일엔 공용 afterEach 가 없다(각 테스트가 자기 spy 를 새로 만든다).
    // 고정 시계만은 명시적으로 되돌린다 — 뒤 테스트로 새면 진단이 어려워진다.
    vi.restoreAllMocks();
  });

  it('실패한 PATCH 는 핑을 쓰지 않는다', async () => {
    const { usePatchLiveSettings } = await import('./liveSettings');
    vi.spyOn(client, 'apiCall').mockRejectedValue(new Error('boom'));
    const qc = new QueryClient();
    localStorage.clear();

    const { result } = renderHook(() => usePatchLiveSettings(), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ screener_depth_autocollect: true }).catch(() => {});
    });

    // 서버가 안 받은 변경을 다른 탭에 알리면, 그 탭은 멀쩡한 캐시를 버리고
    // 같은 값을 다시 받아온다(무해하지만 거짓 신호다).
    expect(localStorage.getItem('live.settings.ping.v1')).toBeNull();
  });
});
