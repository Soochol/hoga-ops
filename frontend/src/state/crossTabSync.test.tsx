import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCrossTabSync } from './crossTabSync';
import { useThemePrefsStore } from './themePrefs';
import { useLiveVenueStore } from './liveVenue';
import { useLivePageStore } from './livePage';
import { useChartPrefsStore } from './chartPrefs';
import { INDICATORS_V2_STORAGE_KEY } from './indicatorSettingsV2';
import { CHART_PREFS_KEY } from './chartPrefsPersistence';
import { LIVE_SETTINGS_KEY } from '../api/liveSettings';

const THEME_KEY = 'ui.themePreference.v1';
const VENUE_KEY = 'live.venue.v1';
const PING_KEY = 'live.settings.ping.v1';
const INDICATORS_KEY = INDICATORS_V2_STORAGE_KEY;

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

  it('보조지표를 다른 탭에서 받는다 — 버킷·레이아웃·ambient 투영이 함께 온다', () => {
    useLivePageStore.setState({
      indicatorsByTimeframe: {},
      indicatorTimeframe: '1m',
      askPeakEnabled: false,
      paneStretch: {},
    });
    renderHook(() => useCrossTabSync(), { wrapper: wrapper(new QueryClient()) });

    otherTabWrites(INDICATORS_KEY, JSON.stringify({
      paneOrder: [],
      paneStretch: { volume: 3 },
      byTimeframe: { minute: { askPeakEnabled: true } },
    }));

    const s = useLivePageStore.getState();
    expect(s.indicatorsByTimeframe.minute).toEqual({ askPeakEnabled: true });
    expect(s.paneStretch).toMatchObject({ volume: 3 });
    // 투영까지 갱신되지 않으면 화면은 옛 값을 계속 그린다(ambient=1m→minute).
    expect(s.askPeakEnabled).toBe(true);
  });

  it('지표 재수화는 저장소를 **되쓰지 않는다** — 왕복이 멈춘다', () => {
    renderHook(() => useCrossTabSync(), { wrapper: wrapper(new QueryClient()) });
    const payload = JSON.stringify({
      paneOrder: [], paneStretch: {}, byTimeframe: { minute: { askPeakEnabled: true } },
    });
    otherTabWrites(INDICATORS_KEY, payload);
    // 이 탭이 같은 키를 다시 썼다면 저장소 문자열이 바뀌었을 것이다(정규화 결과가
    // 원본과 다르므로). 되쓰기가 있으면 상대 탭이 또 이벤트를 받아 핑퐁이 된다.
    expect(localStorage.getItem(INDICATORS_KEY)).toBe(payload);
  });

  it('차트 prefs(「지표」 모달의 호가 동작설정)도 다른 탭에서 받는다', () => {
    useChartPrefsStore.setState({ indicatorModalByTimeframe: {}, ratioOutlierFilterEnabled: true });
    renderHook(() => useCrossTabSync(), { wrapper: wrapper(new QueryClient()) });

    otherTabWrites(CHART_PREFS_KEY, JSON.stringify({
      indicatorModalByTimeframe: { minute: { ratioOutlierFilterEnabled: false } },
    }));

    expect(useChartPrefsStore.getState().ratioOutlierFilterEnabled).toBe(false);
  });

  it('언마운트하면 구독을 모두 놓는다', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    useLivePageStore.setState({ indicatorsByTimeframe: {} });
    const { unmount } = renderHook(() => useCrossTabSync(), { wrapper: wrapper(qc) });
    unmount();

    otherTabWrites(THEME_KEY, JSON.stringify({ themePreference: 'obsidian' }));
    otherTabWrites(VENUE_KEY, JSON.stringify({ venue: 'NXT' }));
    otherTabWrites(PING_KEY, '1-1');
    otherTabWrites(INDICATORS_KEY, JSON.stringify({
      paneOrder: [], paneStretch: {}, byTimeframe: { minute: { askPeakEnabled: true } },
    }));

    expect(useThemePrefsStore.getState().themePreference).toBe('toss-light');
    expect(useLiveVenueStore.getState().venue).toBe('KRX');
    expect(useLivePageStore.getState().indicatorsByTimeframe).toEqual({});
    expect(invalidate).not.toHaveBeenCalled();
  });
});
