import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { GroupSymbol, WorkspaceWindow } from '../state/workspace';
import { liveOpenCodesKey, useLiveRangeCacheEviction } from './useLiveRangeCacheEviction';

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** canonical 병합본 키. identity 는 실키 배열의 JSON 이고 code 는 인덱스 1. */
function mergedRangeKey(code: string): unknown[] {
  return ['live', 'range-merged', JSON.stringify(['range', code, null, '20260729', 60_000])];
}

function win(id: string, group: number): WorkspaceWindow {
  return { id, kind: 'chart', group, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } };
}

function sym(code: string): GroupSymbol {
  return { code, name: `${code} 종목` };
}

describe('liveOpenCodesKey', () => {
  it('창이 있는 그룹의 종목만, 중복 없이 정렬해 돌려준다', () => {
    const windows = [win('w1', 1), win('w2', 1), win('w3', 2)];
    const symbols = { 1: sym('005930'), 2: sym('000660'), 3: sym('035720') };

    // 그룹 3 은 창이 없으므로 빠진다. 그룹 1 은 창이 둘이어도 한 번만.
    expect(liveOpenCodesKey(windows, symbols)).toBe('000660,005930');
  });

  it('종목 구성이 같으면 창이 바뀌어도 같은 문자열이다', () => {
    const symbols = { 1: sym('005930') };
    const before = liveOpenCodesKey([win('w1', 1)], symbols);
    const after = liveOpenCodesKey([win('w1', 1), win('w2', 1)], symbols);

    // 문자열 동일 = zustand 셀렉터가 재렌더를 안 낸다는 뜻.
    expect(after).toBe(before);
  });

  it('창이 없으면 빈 문자열', () => {
    expect(liveOpenCodesKey([], { 1: sym('005930') })).toBe('');
  });
});

describe('useLiveRangeCacheEviction', () => {
  it('열린 창에 없는 종목의 canonical 병합본을 축출한다', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(mergedRangeKey('005930'), { code: '005930' });
    queryClient.setQueryData(mergedRangeKey('000660'), { code: '000660' });

    renderHook(() => useLiveRangeCacheEviction('005930'), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueryData(mergedRangeKey('005930'))).toBeDefined();
    expect(queryClient.getQueryData(mergedRangeKey('000660'))).toBeUndefined();
  });

  it('past-candles 는 청크와 병합본의 코드 위치가 달라도 각각 옳게 읽는다', () => {
    const queryClient = new QueryClient();
    // 실제 키 모양(bucketMs 꼬리 포함, #1008). 술어는 [2]/[3]만 보므로 꼬리 확장에
    // 불변이어야 한다 — 이 픽스처가 구 6요소 모양이면 그 성질을 검증하지 못한다.
    const openChunk = ['live', 'past-candles', '005930', '20260701', '20260729', 'AUTO', 600_000];
    const openMerged = ['live', 'past-candles', 'merged', '005930', '20260729', 'AUTO', 600_000];
    const goneChunk = ['live', 'past-candles', '000660', '20260701', '20260729', 'AUTO', 600_000];
    const goneMerged = ['live', 'past-candles', 'merged', '000660', '20260729', 'AUTO', 600_000];
    // 같은 종목의 다른 tf 병합본도 종목 축출을 따라간다(스코프별 키 분리의 귀결).
    const goneOtherTf = ['live', 'past-candles', 'merged', '000660', '20260729', 'AUTO', 60_000];
    for (const key of [openChunk, openMerged, goneChunk, goneMerged, goneOtherTf]) {
      queryClient.setQueryData(key, { seeded: true });
    }

    renderHook(() => useLiveRangeCacheEviction('005930'), {
      wrapper: makeWrapper(queryClient),
    });

    // 병합본은 code 가 인덱스 3 이다. 인덱스 2 만 읽으면 'merged' 를 코드로 오인해
    // 열린 종목의 병합 캔들까지 날아간다 — 이 단언이 그 회귀를 잡는다.
    expect(queryClient.getQueryData(openMerged)).toBeDefined();
    expect(queryClient.getQueryData(openChunk)).toBeDefined();
    expect(queryClient.getQueryData(goneMerged)).toBeUndefined();
    expect(queryClient.getQueryData(goneChunk)).toBeUndefined();
    expect(queryClient.getQueryData(goneOtherTf)).toBeUndefined();
  });

  it("/study 와 공유하는 ['range'] 청크는 건드리지 않는다", () => {
    const queryClient = new QueryClient();
    const studyKey = ['range', '000660', '20260701', '20260729', 600_000, 'hoga'];
    queryClient.setQueryData(studyKey, { code: '000660' });

    renderHook(() => useLiveRangeCacheEviction('005930'), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueryData(studyKey)).toBeDefined();
  });

  it('옵저버가 살아 있는 쿼리는 창에서 빠져도 남긴다', () => {
    const queryClient = new QueryClient();
    const observedKey = ['live', 'series', '000660', '20260729'];
    queryClient.setQueryData(observedKey, { code: '000660' });
    const observer = new QueryObserver(queryClient, {
      queryKey: observedKey,
      queryFn: () => ({ code: '000660' }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      renderHook(() => useLiveRangeCacheEviction('005930'), {
        wrapper: makeWrapper(queryClient),
      });

      // 옵저버가 남은 쿼리를 지우면 RQ 가 즉시 재생성·재요청한다.
      expect(queryClient.getQueryData(observedKey)).toBeDefined();
    } finally {
      unsubscribe();
    }
  });

  it('열린 종목이 하나도 없으면 아무것도 지우지 않는다', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(mergedRangeKey('005930'), { code: '005930' });

    // 라우트 진입 직후 워크스페이스 하이드레이션 전 한 프레임을 흉내낸다.
    renderHook(() => useLiveRangeCacheEviction(''), {
      wrapper: makeWrapper(queryClient),
    });

    expect(queryClient.getQueryData(mergedRangeKey('005930'))).toBeDefined();
  });

  it('열린 종목이 바뀌면 새로 빠진 종목을 축출한다', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(mergedRangeKey('005930'), { code: '005930' });
    queryClient.setQueryData(mergedRangeKey('000660'), { code: '000660' });

    const { rerender } = renderHook(
      ({ codes }) => useLiveRangeCacheEviction(codes),
      { wrapper: makeWrapper(queryClient), initialProps: { codes: '000660,005930' } },
    );
    expect(queryClient.getQueryData(mergedRangeKey('000660'))).toBeDefined();

    rerender({ codes: '005930' });

    expect(queryClient.getQueryData(mergedRangeKey('005930'))).toBeDefined();
    expect(queryClient.getQueryData(mergedRangeKey('000660'))).toBeUndefined();
  });
});
