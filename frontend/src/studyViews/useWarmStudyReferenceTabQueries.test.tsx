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


// ⚠ 이 구현은 `beforeEach` 가 매번 다시 심는다(`resetApiCall`). `mockClear()` 는 호출
// 기록만 지우고 **구현은 남기므로**, 어느 테스트가 apiCall 을 "영원히 pending" 으로
// 덮어쓰면 그 뒤 테스트로 샌다. 워밍이 순차가 된 뒤로는 그 누출이 곧 교착이다 —
// 앞 탭이 끝나야 다음 탭이 열리는데 앞 탭이 영영 안 끝난다.
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

/** 위 `vi.mock` 팩토리와 같은 응답. 구현을 갈아치우는 테스트가 있으므로 매번 되돌린다. */
function resetApiCall() {
  vi.mocked(apiCall).mockImplementation(async (url: string) => {
    const code = new URL(`http://test.local${url}`).searchParams.get('code') ?? '005930';
    if (url.startsWith('/api/range')) {
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
    return { code, venue: 'KRX', candles: [], data_warnings: [] };
  });
}

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
    resetApiCall();
    useLiveVenueStore.setState({ venue: 'KRX' });
    // 쿼리 키를 정하는 지표는 **`/study` 세트**이고(ADR-0146), 어느 버킷인지는
    // 차트 창의 봉이 정한다(#904) — 창 밖 소비자도 같은 조합을 읽어야
    // "켰는데 안 보임"이 안 난다.
    const chartId = useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
    useStudyWorkspaceStore.getState().setChartTimeframe(chartId, '5m');
    useLivePageStore.setState({ indicatorsByTimeframe: {}, studyIndicatorsByTimeframe: {} });
    useLivePageStore.getState().patchIndicatorsScoped('study', '5m', {
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it("resolves each tab's indicators from that tab's timeframe, not the focused window's", async () => {
    // 지표 프로필은 `'minute' | 'D' | 'W' | 'M'` 네 개뿐이라(`profileKeyForTimeframe`)
    // 분봉끼리는 어차피 같은 값이다 — **캘린더 봉이 섞여야** 갈린다. 그래서 포커스
    // 창을 일봉으로 두고 탭은 5분봉으로 둔다. 이 어긋남이 이 테스트의 조건 전부다.
    const chartId = useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
    useStudyWorkspaceStore.getState().setChartTimeframe(chartId, 'D');
    useLivePageStore.getState().patchIndicatorsScoped('study', 'D', { depthHeatmapEnabled: true });
    useLivePageStore.getState().patchIndicatorsScoped('study', '5m', { depthHeatmapEnabled: false });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자')];
    const tabs = [tab('tab-a', 'view-a', '005930', '삼성전자')];  // timeframe: '5m'

    renderHook(
      () => useWarmStudyReferenceTabQueries({
        tabs,
        activeTabId: 'tab-a',
        activatedTabIds: [],
        saves,
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('mode=sidecar'))).toBe(true);
    });

    const sidecar = vi.mocked(apiCall).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('mode=sidecar'));
    // 버킷은 탭의 봉(5분)이다. 지표도 **같은 봉**에서 나와야 활성 경로와 키가 맞는다.
    expect(sidecar.every((url) => url.includes('bucket_ms=300000'))).toBe(true);
    expect(sidecar.some((url) => url.includes('depth_heatmap_enabled=true'))).toBe(false);
    expect(sidecar.every((url) => url.includes('depth_heatmap_enabled=false'))).toBe(true);
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
    // 워밍이 순차라 tab-b 는 tab-a 가 끝난 **뒤에** 열린다 — 같은 커밋에 둘 다
    // ready 이던 시절의 단언은 이제 경합이다.
    await waitFor(() => expect(result.current['tab-b']).toBe('ready'));
    expect(result.current['tab-c']).toBe('idle');
  });

  it('활성 탭이 끝나기 전에는 비활성 탭 워밍을 한 건도 발사하지 않는다', async () => {
    // 백엔드가 사실상 직렬이라(동시 요청은 서로를 그 수만큼 늦춘다) 워밍이 활성
    // 화면과 대역폭을 다투면 안 된다. 활성 탭 요청을 손으로 붙잡아 두고, 그동안
    // 비활성 탭이 정말 조용한지 본다.
    const passthrough = vi.mocked(apiCall).getMockImplementation()!;
    const gates: Array<() => void> = [];
    vi.mocked(apiCall).mockImplementation(async (url: string, init?: RequestInit) => {
      const code = new URL(`http://test.local${url}`).searchParams.get('code');
      if (code === '005930') await new Promise<void>((resolve) => gates.push(resolve));
      return passthrough(url, init);
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자'), save('view-b', '000660', 'SK하이닉스')];
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

    // 활성 탭은 즉시 나간다 — 순차화가 활성 화면까지 늦추면 고치려던 것을 악화시킨다.
    await waitFor(() => expect(gates.length).toBeGreaterThan(0));
    const beforeRelease = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
    expect(beforeRelease.some((url) => url.includes('code=005930'))).toBe(true);
    expect(beforeRelease.some((url) => url.includes('code=000660'))).toBe(false);

    for (const open of gates) open();

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('code=000660'))).toBe(true);
    });
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

  it('warmTimeframe 이 오면 탭 봉 대신 그 봉으로 워밍한다 (창이 봉의 소유자)', async () => {
    // `/study` 는 포커스 창의 봉을 넘긴다(#1326). 탭을 눌러도 창 봉이 안 바뀌므로
    // 활성 전환의 실제 키가 창 봉(15m)이다. 탭이 든 저장 봉(5m)으로 워밍하면 받아
    // 놓고 즉시 버리는 번들이 된다 — 위 테스트가 막는 회귀가 이 축에서 재발한다.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자')];

    renderHook(
      () => useWarmStudyReferenceTabQueries({
        tabs: [tab('tab-a', 'view-a', '005930', '삼성전자')],  // timeframe: '5m'
        activeTabId: 'tab-a',
        activatedTabIds: [],
        saves,
        warmTimeframe: '15m',
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('bucket_ms=900000'))).toBe(true);
    });
    const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('bucket_ms=300000'))).toBe(false);
  });

  it('지표를 `/study` 세트에서 푼다 — `/live` 것으로 풀면 활성 전환 키와 어긋난다', async () => {
    // 워밍은 `/study` 에서만 돈다. `/live` 세트로 풀면 활성 전환의 실제 키와 달라
    // 받아 놓은 번들을 즉시 버린다(위 warmTimeframe 회귀의 지표 축 판, ADR-0146).
    useLivePageStore.getState().patchIndicatorsScoped('study', '5m', {
      depthHeatmapEnabled: true,
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const saves = [save('view-a', '005930', '삼성전자')];

    renderHook(
      () => useWarmStudyReferenceTabQueries({
        tabs: [tab('tab-a', 'view-a', '005930', '삼성전자')],  // timeframe: '5m'
        activeTabId: 'tab-a',
        activatedTabIds: [],
        saves,
        warmTimeframe: '5m',
      }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => {
      const urls = vi.mocked(apiCall).mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('mode=sidecar'))).toBe(true);
    });

    const sidecar = vi.mocked(apiCall).mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('mode=sidecar'));
    // `/live` 5m 버킷은 히트맵이 꺼져 있다(beforeEach) — true 가 나온다는 것은
    // 값이 `/study` 세트에서 왔다는 뜻이다.
    expect(sidecar.every((url) => url.includes('depth_heatmap_enabled=true'))).toBe(true);
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

  it('스토어가 뭐든 모든 탭을 KRX 로 워밍한다 (ADR-0144)', async () => {
    // 워밍 venue 가 활성 경로와 다르면 탭 전환에서 캐시가 안 맞아 재fetch 된다 —
    // 워밍이 막으려던 것을 정확히 만든다. 양쪽이 같은 상수를 읽으므로 종목이 달라도
    // (NXT 상장 005930 · 미상장 000660) 요청은 전부 KRX 다.
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
      expect(urls.some((u) => u.includes('code=005930') && u.includes('venue=KRX'))).toBe(true);
      expect(urls.some((u) => u.includes('code=000660') && u.includes('venue=KRX'))).toBe(true);
      // 선택값(UN)이 **한 건도** 새어 나가면 안 된다.
      expect(urls.some((u) => u.includes('venue=UN'))).toBe(false);
      expect(urls.some((u) => u.includes('venue=NXT'))).toBe(false);
    });
  });

});
