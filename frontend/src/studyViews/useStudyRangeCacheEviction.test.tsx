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

function seedRange(queryClient: QueryClient, code: string, bucketMs = 600_000): unknown[] {
  const key = ['range', code, '20260616', '20260618', bucketMs, 'hoga'];
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

describe('useStudyRangeCacheEviction — 봉 축 (#801 멀티 차트 창)', () => {
  const MIN_1 = 60_000;
  const MIN_5 = 300_000;
  const MIN_10 = 600_000;

  it('활성 종목에서 열린 창 어디에도 없는 봉의 번들을 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930', MIN_5);
    seedRange(queryClient, '005930', MIN_10);

    renderHook(
      () => useStudyRangeCacheEviction([tab('t1', '005930')], '005930', ['10m']),
      { wrapper: makeWrapper(queryClient) },
    );

    // 탭 봉(5m)과 열린 창 봉(10m)은 남고, 그 밖은 없다.
    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(2);

    renderHook(
      () => useStudyRangeCacheEviction([tab('t1', '005930')], '005930', ['1m']),
      { wrapper: makeWrapper(queryClient) },
    );
    // 이제 10m 은 어디에도 없다 → 축출. 5m 은 탭 봉이라 생존.
    const left = queryClient.getQueriesData({ queryKey: ['range', '005930'] });
    expect(left).toHaveLength(1);
    expect((left[0][0] as unknown[])[4]).toBe(MIN_5);
  });

  it('캘린더 봉 창은 1분봉 번들을 지킨다 — D/W/M 은 1m 을 받아 집계한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930', MIN_1);

    renderHook(
      () => useStudyRangeCacheEviction([tab('t1', '005930')], '005930', ['D']),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
  });

  it('다른 탭 종목은 봉 축으로 좁히지 않는다 — 그 탭이 어떤 봉을 열지 모른다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '000660', MIN_1);

    renderHook(
      () => useStudyRangeCacheEviction(
        [tab('t1', '005930'), tab('t2', '000660')], '005930', ['10m'],
      ),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(1);
  });

  it('활성 종목을 안 주면 봉 축이 꺼진다 — 종목 규칙만 돈다(기존 동작)', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930', MIN_10);

    renderHook(() => useStudyRangeCacheEviction([tab('t1', '005930')]), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
  });

  it('옵저버가 살아 있는 쿼리는 봉이 안 맞아도 지우지 않는다', () => {
    const queryClient = new QueryClient();
    const key = seedRange(queryClient, '005930', MIN_10);
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => ({ code: '005930' }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      renderHook(
        () => useStudyRangeCacheEviction([tab('t1', '005930')], '005930', ['1m']),
        { wrapper: makeWrapper(queryClient) },
      );

      expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
