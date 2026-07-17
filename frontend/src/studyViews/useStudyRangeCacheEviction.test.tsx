import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { StudyTab } from '../state/studyTabs';
import { useStudyRangeCacheEviction } from './useStudyRangeCacheEviction';

function tab(id: string, code: string): StudyTab {
  return {
    id,
    viewId: `view-${id}`,
    code,
    label: `${code} 복기`,
    name: `${code} 복기`,
    timeframe: '5m',
  };
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function seedRange(queryClient: QueryClient, code: string): unknown[] {
  const key = ['range', code, '20260616', '20260618', 600_000, 'hoga'];
  queryClient.setQueryData(key, { code });
  return key;
}

describe('useStudyRangeCacheEviction', () => {
  it('열린 탭에 없는 종목의 range 캐시만 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930');
    seedRange(queryClient, '000660');

    renderHook(() => useStudyRangeCacheEviction([tab('t1', '005930')]), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
    expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(0);
  });

  it('range 밖의 네임스페이스는 건드리지 않는다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '000660');
    queryClient.setQueryData(['live', 'past-candles', '000660'], { code: '000660' });

    renderHook(() => useStudyRangeCacheEviction([tab('t1', '005930')]), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueryData(['live', 'past-candles', '000660'])).toBeDefined();
  });

  it('옵저버가 살아 있는 쿼리는 탭에 없어도 남긴다', () => {
    const queryClient = new QueryClient();
    const observedKey = seedRange(queryClient, '000660');
    const observer = new QueryObserver(queryClient, {
      queryKey: observedKey,
      queryFn: () => ({ code: '000660' }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      renderHook(() => useStudyRangeCacheEviction([tab('t1', '005930')]), {
        wrapper: makeWrapper(queryClient),
      });

      expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('탭 셋의 code 구성이 바뀌면 새로 벗어난 종목을 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930');
    seedRange(queryClient, '000660');

    const { rerender } = renderHook(({ tabs }) => useStudyRangeCacheEviction(tabs), {
      wrapper: makeWrapper(queryClient),
      initialProps: { tabs: [tab('t1', '005930'), tab('t2', '000660')] },
    });
    expect(queryClient.getQueriesData({ queryKey: ['range'] })).toHaveLength(2);

    rerender({ tabs: [tab('t1', '005930')] });

    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
    expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(0);
  });

  it('탭이 하나도 없으면 관찰자 없는 range 캐시를 전부 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930');
    seedRange(queryClient, '000660');

    renderHook(() => useStudyRangeCacheEviction([]), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueriesData({ queryKey: ['range'] })).toHaveLength(0);
  });
});
