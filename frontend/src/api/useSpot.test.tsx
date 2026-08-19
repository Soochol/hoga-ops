import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSpot } from './useSpot';

/**
 * capacity 회귀 가드.
 *
 * useSpot 의 LRU 는 리플레이 스크러빙(작은 스냅샷 · 키 재방문 잦음)을 전제로 100 이
 * 기본이다. 그 전제가 깨지는 호출부 — 키에 시각 스탬프가 박혀 **다시는 안 맞는**
 * 종류 — 는 반드시 좁혀 잡아야 한다. 안 그러면 한 번 쓰고 버려진 사본 100 벌이
 * 힙에 남아 GC 정지를 늘린다(2026-07-29 진단: 당일 거래원 궤적이 그 사례였다).
 *
 * 그 사례 자체는 이제 useSpot 을 쓰지 않는다 — 스탬프-in-key 로 갱신하던 거래원
 * 훅들은 react-query 로 옮겨 갔고(`brokerSeries.ts`), 갱신은 `refetchInterval` 이
 * 맡는다. **가드는 남긴다**: capacity 계약은 남은 호출부(호가 스팟)와 앞으로 생길
 * 호출부에 여전히 걸리고, 스탬프-in-key 는 다시 나타나기 쉬운 패턴이다.
 */
describe('useSpot capacity', () => {
  it('capacity 1 이면 직전 키만 남아 되돌아온 키는 재요청한다', async () => {
    const fetcher = vi.fn((key: string) => Promise.resolve(`v:${key}`));
    const { result, rerender } = renderHook(
      ({ key }) => useSpot<string>(key, () => fetcher(key), 0, 1),
      { initialProps: { key: 'a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('v:a'));
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.data).toBe('v:b'));
    rerender({ key: 'a' });
    await waitFor(() => expect(result.current.data).toBe('v:a'));

    // 'a' 가 'b' 로 축출됐으므로 세 번째도 실제 요청이다 = 사본이 안 쌓인다.
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('기본 용량에서는 되돌아온 키가 캐시 히트라 재요청이 없다', async () => {
    const fetcher = vi.fn((key: string) => Promise.resolve(`v:${key}`));
    const { result, rerender } = renderHook(
      ({ key }) => useSpot<string>(key, () => fetcher(key), 0),
      { initialProps: { key: 'a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('v:a'));
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.data).toBe('v:b'));
    rerender({ key: 'a' });
    await waitFor(() => expect(result.current.data).toBe('v:a'));

    // 스크러빙 전제가 살아 있다는 확인 — 기본값을 좁히면 여기서 깨진다.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('키가 바뀌어 재요청하는 동안에도 이전 값을 계속 보여준다', async () => {
    let resolveSecond!: (v: string) => void;
    const second = new Promise<string>((resolve) => { resolveSecond = resolve; });
    const fetcher = vi.fn((key: string) =>
      key === 'a' ? Promise.resolve('v:a') : second,
    );
    const { result, rerender } = renderHook(
      ({ key }) => useSpot<string>(key, () => fetcher(key), 0, 1),
      { initialProps: { key: 'a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('v:a'));
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.isFetching).toBe(true));

    // capacity 1 이어도 in-flight 중 화면이 비지 않는다(거래원 카드 깜빡임 방지).
    expect(result.current.data).toBe('v:a');

    resolveSecond('v:b');
    await waitFor(() => expect(result.current.data).toBe('v:b'));
  });
});
