/**
 * 소스 선호 훅 — 설정에서 파생하고, **로딩 중에는 undefined** 다.
 *
 * undefined 게이트가 이 파일의 요점이다. 기본값으로 메우면 옵션을 켜 둔 사용자가
 * 콜드 마운트마다 kiwoom 키로 한 번 조회하고 hogaplay 키로 다시 조회해서 차트가
 * 눈에 띄게 갈아끼워진다(`source_pref` 가 쿼리 키에 들어간다).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

// ⚠ `getLiveSettings` 를 spy 해도 안 먹는다 — `useLiveSettings` 의 `queryFn` 이 같은
// 모듈 안의 함수를 **내부 참조**로 잡고 있어서 export 객체를 바꿔도 우회된다.
// `apiCall` 은 `liveSettings.ts` 가 다른 모듈에서 import 하므로 ESM live binding 으로
// 교체가 먹는다. 이 파일이 모킹 지점을 `apiCall` 로 잡은 이유다.
import * as apiClient from '../api/client';
import {
  HOGAPLAY_SOURCE_PREF,
  ORDERFLOW_SOURCE_PREF,
  useOrderflowSourcePref,
} from './sourcePreference';

const SETTINGS = {
  schema_version: 1,
  rest_bypass_enabled: false,
  screener_depth_autocollect: false,
  krx_prefer_hogaplay: false,
};

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function freshQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useOrderflowSourcePref', () => {
  it('설정이 로딩 중이면 undefined — 호출부가 쿼리를 막을 수 있게', () => {
    // 해소되지 않는 promise: 로딩 상태를 붙잡아 둔다.
    vi.spyOn(apiClient, 'apiCall').mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useOrderflowSourcePref(), { wrapper: wrap(freshQc()) });

    expect(result.current).toBeUndefined();
  });

  it('토글이 꺼져 있으면 기본 사다리 토큰', async () => {
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue(SETTINGS);

    const { result } = renderHook(() => useOrderflowSourcePref(), { wrapper: wrap(freshQc()) });

    await waitFor(() => expect(result.current).toBe(ORDERFLOW_SOURCE_PREF));
  });

  it('토글이 켜져 있으면 백엔드가 인식하는 옵트인 토큰을 보낸다', async () => {
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });

    const { result } = renderHook(() => useOrderflowSourcePref(), { wrapper: wrap(freshQc()) });

    await waitFor(() => expect(result.current).toBe(HOGAPLAY_SOURCE_PREF));
  });

  it('옵트인 토큰은 정확히 "hogaplay" — 백엔드 ordered_sources 와의 계약', () => {
    // 백엔드는 이 문자열만 인식하고 나머지는 전부 기본 사다리로 수렴시킨다
    // (`hoga/api/sources.py::ordered_sources`). 오타가 나면 조용히 기본값이 되므로
    // 값 자체를 못 박는다.
    expect(HOGAPLAY_SOURCE_PREF).toBe('hogaplay');
  });
});
