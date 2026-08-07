import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCrossTabSync } from './crossTabSync';
import { useThemePrefsStore } from './themePrefs';
import { useLiveVenueStore } from './liveVenue';
import { LIVE_SETTINGS_KEY } from '../api/liveSettings';

const THEME_KEY = 'ui.themePreference.v1';
const VENUE_KEY = 'live.venue.v1';
const PING_KEY = 'live.settings.ping.v1';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/** 다른 탭의 쓰기 = 저장소가 먼저 바뀌고 이벤트가 뒤따른다. 순서를 지켜야 실제와
 *  같다 — 구독들은 event.newValue 가 아니라 저장소를 다시 읽는다. */
function otherTabWrites(key: string, value: string) {
  localStorage.setItem(key, value);
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
}

beforeEach(() => {
  localStorage.clear();
  useThemePrefsStore.setState({ themePreference: 'toss-light' });
  useLiveVenueStore.setState({ venue: 'KRX' });
});

describe('useCrossTabSync', () => {
  it('테마 선호를 다른 탭에서 받는다', () => {
    renderHook(() => useCrossTabSync(), { wrapper: wrapper(new QueryClient()) });

    otherTabWrites(THEME_KEY, JSON.stringify({ themePreference: 'obsidian' }));

    expect(useThemePrefsStore.getState().themePreference).toBe('obsidian');
  });

  it('거래소를 다른 탭에서 받는다', () => {
    renderHook(() => useCrossTabSync(), { wrapper: wrapper(new QueryClient()) });

    otherTabWrites(VENUE_KEY, JSON.stringify({ venue: 'NXT' }));

    expect(useLiveVenueStore.getState().venue).toBe('NXT');
  });

  it('LiveSettings 는 값을 받는 게 아니라 쿼리를 무효화한다', () => {
    // 서버가 단일 진실이라 핑에 담긴 문자열은 의미가 없다 — 다시 읽게만 만든다.
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useCrossTabSync(), { wrapper: wrapper(qc) });

    otherTabWrites(PING_KEY, '1-1');

    expect(invalidate).toHaveBeenCalledWith({ queryKey: LIVE_SETTINGS_KEY });
  });

  it('언마운트하면 세 구독을 모두 놓는다', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { unmount } = renderHook(() => useCrossTabSync(), { wrapper: wrapper(qc) });
    unmount();

    otherTabWrites(THEME_KEY, JSON.stringify({ themePreference: 'obsidian' }));
    otherTabWrites(VENUE_KEY, JSON.stringify({ venue: 'NXT' }));
    otherTabWrites(PING_KEY, '1-1');

    expect(useThemePrefsStore.getState().themePreference).toBe('toss-light');
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
