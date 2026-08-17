import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useStudyRangeCacheEviction } from './useStudyRangeCacheEviction';

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

// 보존 집합은 **활성 저장뷰의 종목 하나**다(ADR-0149). 종전엔 "열린 탭 어느 하나라도
// 든 종목" 이라 여러 개였고, 탭이 사라지면서 하나로 좁아졌다 — 그만큼 축출이 공격적이다.
describe('useStudyRangeCacheEviction — 종목 축', () => {
  it('활성 종목이 아닌 range 캐시를 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930');
    seedRange(queryClient, '000660');

    renderHook(() => useStudyRangeCacheEviction('005930'), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
    expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(0);
  });

  it('range 밖의 네임스페이스는 건드리지 않는다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '000660');
    queryClient.setQueryData(['live', 'past-candles', '000660'], { code: '000660' });

    renderHook(() => useStudyRangeCacheEviction('005930'), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueryData(['live', 'past-candles', '000660'])).toBeDefined();
  });

  // `type: 'inactive'` 가드. 이게 없으면 축출 직후 RQ 가 재생성·재요청한다.
  it('옵저버가 살아 있는 쿼리는 활성 종목이 아니어도 남긴다', () => {
    const queryClient = new QueryClient();
    const observedKey = seedRange(queryClient, '000660');
    const observer = new QueryObserver(queryClient, {
      queryKey: observedKey,
      queryFn: () => ({ code: '000660' }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      renderHook(() => useStudyRangeCacheEviction('005930'), {
        wrapper: makeWrapper(queryClient),
      });

      expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  // 저장뷰를 옮겨 다니는 동선이 이것이다 — 뷰 A(종목 X) → 뷰 B(종목 Y).
  it('활성 종목이 바뀌면 직전 종목을 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930');

    const { rerender } = renderHook(({ code }) => useStudyRangeCacheEviction(code), {
      wrapper: makeWrapper(queryClient),
      initialProps: { code: '005930' as string | null },
    });
    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);

    // 새 뷰를 열면 그 종목 번들이 새로 받아진다.
    seedRange(queryClient, '000660');
    rerender({ code: '000660' });

    expect(queryClient.getQueriesData({ queryKey: ['range', '000660'] })).toHaveLength(1);
    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(0);
  });

  it('활성 뷰가 없으면 관찰자 없는 range 캐시를 전부 축출한다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930');
    seedRange(queryClient, '000660');

    renderHook(() => useStudyRangeCacheEviction(null), {
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
      () => useStudyRangeCacheEviction('005930', ['5m', '10m']),
      { wrapper: makeWrapper(queryClient) },
    );

    // 창 둘이 5m·10m 을 열고 있으니 둘 다 남는다.
    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(2);

    renderHook(
      () => useStudyRangeCacheEviction('005930', ['5m']),
      { wrapper: makeWrapper(queryClient) },
    );
    // 10m 창을 닫으면 그 번들만 축출된다.
    const left = queryClient.getQueriesData({ queryKey: ['range', '005930'] });
    expect(left).toHaveLength(1);
    expect((left[0][0] as unknown[])[4]).toBe(MIN_5);
  });

  it('캘린더 봉 창은 1분봉 번들을 지킨다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930', MIN_1);

    renderHook(
      () => useStudyRangeCacheEviction('005930', ['D']),
      { wrapper: makeWrapper(queryClient) },
    );

    expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
  });

  // 창이 아직 없는 하이드레이션 직전 — 빈 배열은 "보존할 봉이 없다" 가 아니라
  // "창이 아직 없다" 는 뜻이다. 여기서 축출하면 창이 뜨자마자 전부 재fetch 이고,
  // 그게 이 훅이 줄이려던 바로 그 비용이다.
  //
  // 탭이 있던 시절엔 보존 집합에 탭 봉이 함께 들어가 이 구멍이 드러나지 않았다.
  it('열린 창 봉을 하나도 안 주면 봉 축을 끄고 활성 종목 캐시를 지킨다', () => {
    const queryClient = new QueryClient();
    seedRange(queryClient, '005930', MIN_10);

    renderHook(() => useStudyRangeCacheEviction('005930', []), {
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
        () => useStudyRangeCacheEviction('005930', ['1m']),
        { wrapper: makeWrapper(queryClient) },
      );

      expect(queryClient.getQueriesData({ queryKey: ['range', '005930'] })).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
