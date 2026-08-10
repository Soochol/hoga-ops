import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import type { StudyTab } from '../state/studyTabs';
import { useWarmStudyReferenceTabQueries } from './useWarmStudyReferenceTabQueries';
import { seedSymbolMaster, symbolHit } from '../live/seedSymbolMaster';

// 소스 선호는 이제 설정(`live_settings.krx_prefer_hogaplay`)에서 온다. 설정이 로딩 중이면
// `useOrderflowSourcePref()` 가 undefined 를 주고 쿼리가 비활성화되는데(콜드 마운트 차트
// 스왑 방지), 이 파일이 보는 것은 그 게이트가 아니므로 해소된 기본값으로 고정한다.
// 게이트 자체는 sourcePreference.test.ts 가 검증한다.
vi.mock("../state/sourcePreference", async (orig) => ({
  ...(await orig<typeof import("../state/sourcePreference")>()),
  useOrderflowSourcePref: () => "kiwoom_live",
}));


vi.mock('../api/client', () => ({
  apiCall: vi.fn(async (url: string) => {
    if (url.startsWith('/api/range')) {
      const code = new URL(`http://test.local${url}`).searchParams.get('code') ?? '005930';
      return {
        code,
        from_date: '20260616',
        to_date: '20260618',
        bucket_ms: 300_000,
        segments: [],
        candles: [],
        quote_ratio: { bucket_ms: 300_000, points: [] },
        fill_strength: { bucket_ms: 300_000, points: [] },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [],
        volume_distributions: [],
        investorPoints: [],
        ask_peaks: [],
        bid_peaks: [],
        broker_late_entries: [],
        program_trade: { points: [], source: 'kis_program_trade' },
        trade_volume_pocs: [],
      };
    }
    const code = new URL(`http://test.local${url}`).searchParams.get('code') ?? '005930';
    return { code, venue: 'KRX', candles: [], data_warnings: [] };
  }),
}));

import { apiCall } from '../api/client';

function save(id: string, code: string, label: string): StudyViewReference {
  return {
    schema_version: 2,
    id,
    name: `${label} 복기`,
    code,
    label,
    timeframe: '5m',
    range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
    viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
    memo: '',
    tags: [],
    created_at_ms: 1,
    updated_at_ms: 2,
  };
}

function tab(id: string, viewId: string, code: string, label: string): StudyTab {
  return {
    id,
    viewId,
    code,
    label,
    name: label,
    timeframe: '5m',
  };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useWarmStudyReferenceTabQueries', () => {
  beforeEach(() => {
    vi.mocked(apiCall).mockClear();
    useLiveVenueStore.setState({ venue: 'KRX' });
    // 쿼리 키를 정하는 지표는 전역 1세트이고, **어느 버킷**인지는 차트 창의 봉이
    // 정한다(#904) — 창 밖 소비자도 같은 조합을 읽어야 "켰는데 안 보임"이 안 난다.
    const chartId = useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
    useStudyWorkspaceStore.getState().setChartTimeframe(chartId, '5m');
    useLivePageStore.setState({ indicatorsByTimeframe: {} });
    useLivePageStore.getState().patchIndicatorsAt('5m', {
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it('observes the active tab and activated inactive tabs, but skips never-activated tabs', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [
      save('view-a', '005930', '삼성전자'),
      save('view-b', '000660', 'SK하이닉스'),
      save('view-c', '035420', 'NAVER'),
    ];
    const tabs = [
      tab('tab-a', 'view-a', '005930', '삼성전자'),
      tab('tab-b', 'view-b', '000660', 'SK하이닉스'),
      tab('tab-c', 'view-c', '035420', 'NAVER'),
    ];

    const { result } = renderHook(
      () => useWarmStudyReferenceTabQueries({
        tabs,
        activeTabId: 'tab-a',
        activatedTabIds: ['tab-b'],
        saves,
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('code=005930'))).toBe(true);
      expect(urls.some((url) => url.includes('code=000660'))).toBe(true);
    });
    const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('code=035420'))).toBe(false);
    expect(urls.some((url) => url.includes('broker_late_entry_start_hhmm=1000'))).toBe(true);
    await waitFor(() => expect(result.current['tab-a']).toBe('ready'));
    expect(result.current['tab-b']).toBe('ready');
    expect(result.current['tab-c']).toBe('idle');
  });

  it('warms with the tab timeframe, never the save timeframe', async () => {
    // "열 때 기본 시간봉" override로 tab.timeframe(3m) ≠ save.timeframe(5m)인 탭.
    // save 쪽(bucket 300000)으로 fetch하면 즉시 버려질 번들을 한 벌 더 받는 회귀.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자')];
    const overriddenTab = { ...tab('tab-a', 'view-a', '005930', '삼성전자'), timeframe: '3m' as const };

    renderHook(
      () => useWarmStudyReferenceTabQueries({
        tabs: [overriddenTab],
        activeTabId: 'tab-a',
        activatedTabIds: [],
        saves,
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('bucket_ms=180000'))).toBe(true);
    });
    const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('bucket_ms=300000'))).toBe(false);
  });

  it('drops removed tabs from the status map', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자'), save('view-b', '000660', 'SK하이닉스')];
    const initialTabs = [
      tab('tab-a', 'view-a', '005930', '삼성전자'),
      tab('tab-b', 'view-b', '000660', 'SK하이닉스'),
    ];

    const { result, rerender } = renderHook(
      ({ tabs }) => useWarmStudyReferenceTabQueries({
        tabs,
        activeTabId: 'tab-a',
        activatedTabIds: ['tab-b'],
        saves,
      }),
      {
        wrapper: wrapper(client),
        initialProps: { tabs: initialTabs },
      },
    );

    await waitFor(() => expect(result.current['tab-b']).not.toBe('idle'));

    rerender({ tabs: [initialTabs[0]] });

    expect(result.current['tab-b']).toBeUndefined();
  });

  it('keeps the previous active tab request alive after switching tabs', async () => {
    const signals = new Map<string, AbortSignal>();
    vi.mocked(apiCall).mockImplementation(async (url: string, init?: RequestInit) => {
      const code = new URL(`http://test.local${url}`).searchParams.get('code') ?? '';
      if (!signals.has(code) && init?.signal instanceof AbortSignal) {
        signals.set(code, init.signal);
      }
      return new Promise(() => undefined);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자'), save('view-b', '000660', 'SK하이닉스')];
    const tabs = [
      tab('tab-a', 'view-a', '005930', '삼성전자'),
      tab('tab-b', 'view-b', '000660', 'SK하이닉스'),
    ];

    const { rerender } = renderHook(
      ({ activeTabId, activatedTabIds }) => useWarmStudyReferenceTabQueries({
        tabs,
        activeTabId,
        activatedTabIds,
        saves,
      }),
      {
        wrapper: wrapper(client),
        initialProps: { activeTabId: 'tab-a', activatedTabIds: [] as string[] },
      },
    );

    await waitFor(() => expect(signals.get('005930')).toBeInstanceOf(AbortSignal));

    rerender({ activeTabId: 'tab-b', activatedTabIds: ['tab-a'] });

    await waitFor(() => expect(signals.get('000660')).toBeInstanceOf(AbortSignal));
    expect(signals.get('005930')?.aborted).toBe(false);
  });

  it('탭마다 **그 종목의** 유효 venue 로 조회한다', async () => {
    // 활성 탭 하나로 해석하면 다른 종목의 워밍이 엉뚱한 venue 로 나가 캐시 키가
    // 어긋난다 — 재fetch 를 막으려던 워밍이 정확히 재fetch 를 만든다.
    useLiveVenueStore.setState({ venue: 'UN' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(client, [symbolHit('005930', true), symbolHit('000660', false)]);
    const saves = [
      save('view-a', '005930', '삼성전자'),
      save('view-b', '000660', 'SK하이닉스'),
    ];
    const tabs = [
      tab('tab-a', 'view-a', '005930', '삼성전자'),
      tab('tab-b', 'view-b', '000660', 'SK하이닉스'),
    ];

    renderHook(
      () => useWarmStudyReferenceTabQueries({
        tabs,
        activeTabId: 'tab-a',
        activatedTabIds: ['tab-b'],
        saves,
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      // NXT 상장 종목은 선택값(UN) 그대로.
      expect(urls.some((u) => u.includes('code=005930') && u.includes('venue=UN'))).toBe(true);
      // 미상장 종목은 KRX 로 강등된다 — UN 요청이 **한 건도** 나가면 안 된다
      // (백엔드에 `kiwoom_live/UN/` 이 없어 빈 200 이 온다).
      expect(urls.some((u) => u.includes('code=000660') && u.includes('venue=KRX'))).toBe(true);
      expect(urls.some((u) => u.includes('code=000660') && u.includes('venue=UN'))).toBe(false);
    });
  });

});
