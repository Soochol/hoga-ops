import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { StudyTab } from '../state/studyTabs';
import { useWarmStudyReferenceTabQueries } from './useWarmStudyReferenceTabQueries';

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
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });
    useLivePageStore.setState({
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
        viewTimeframes: {},
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
    await waitFor(() => expect(result.current['tab-a']).toBe('ready'));
    expect(result.current['tab-b']).toBe('ready');
    expect(result.current['tab-c']).toBe('idle');
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
        viewTimeframes: {},
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
        viewTimeframes: {},
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
});
