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

/**
 * 취소·실패 계약 (2026-08-20).
 *
 * 세 성질이 함께 `/study` 10호가 버그를 만들었다: 키가 바뀌어도 옛 값이 남고,
 * 죽은 요청이 커넥션을 물고 있고, 실패가 그 옛 값을 영구히 굳혔다. 여기서
 * 나머지 둘을 못박는다(옛 값이 남는 것은 **의도된 동작**이고, 그것을 화면에
 * 말하는 책임은 `isFetching` → `BookPanel.stale` 로 넘어갔다).
 */
describe('useSpot 취소·실패', () => {
  it('키가 바뀌면 비행 중이던 요청을 끊는다', async () => {
    // 끊지 않으면 최신 요청이 **자기가 만든 시체 뒤에서** 큐를 기다린다 —
    // 실측 2026-08-20: 서버 2~7ms 인 /api/orderbook 이 스크럽 중 596~781ms.
    const signals: AbortSignal[] = [];
    const { rerender } = renderHook(
      ({ key }) =>
        useSpot<string>(
          key,
          (signal) => {
            signals.push(signal);
            return new Promise<string>(() => {}); // 영원히 미해결 = 비행 중
          },
          0,
        ),
      { initialProps: { key: 'a' } },
    );

    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ key: 'b' });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('취소는 실패가 아니다 — AbortError 는 error 로 새지 않는다', async () => {
    // 스크럽 중에는 **매 스텝이 이 경로를 지난다**. 여기가 새면 커서를 움직이는
    // 내내 화면이 에러로 깜빡인다.
    const abortErr = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      return e;
    };
    const { result, rerender } = renderHook(
      ({ key }) =>
        useSpot<string>(
          key,
          (signal) =>
            new Promise<string>((resolve, reject) => {
              if (key === 'b') {
                resolve('v:b');
                return;
              }
              signal.addEventListener('abort', () => reject(abortErr()));
            }),
          0,
        ),
      { initialProps: { key: 'a' } },
    );

    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.data).toBe('v:b'));
    expect(result.current.error).toBeNull();
  });

  it('실패하면 옛 값을 남기지 않고 error 로 말한다', async () => {
    // 남기면 커서가 옮겨간 자리에 옛 호가가 눌러앉는다 — 이 훅엔 재시도가 없어
    // 다음 키 변경까지 거짓 데이터가 화면에 굳는다.
    const boom = new Error('boom');
    const fetcher = vi.fn((key: string) =>
      key === 'a' ? Promise.resolve('v:a') : Promise.reject(boom),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ key }) => useSpot<string>(key, () => fetcher(key), 0),
      { initialProps: { key: 'a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('v:a'));
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.error).toBe(boom));
    expect(result.current.data).toBeUndefined();
    logged.mockRestore();
  });

  it('키가 움직이면 지난 실패는 턴다', async () => {
    // 에러는 **키에 딸린 상태**다. 안 털면 실패한 버킷 하나가 커서가 떠난
    // 뒤에도 계속 에러를 그린다.
    const fetcher = vi.fn((key: string) =>
      key === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(`v:${key}`),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, rerender } = renderHook(
      ({ key }) => useSpot<string>(key, () => fetcher(key), 0),
      { initialProps: { key: 'bad' } },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    rerender({ key: 'good' });
    await waitFor(() => expect(result.current.data).toBe('v:good'));
    expect(result.current.error).toBeNull();
    logged.mockRestore();
  });
});
