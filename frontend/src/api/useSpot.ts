import { useEffect, useRef, useState } from 'react';
import { LRUCache } from '../util/lru';

/**
 * Spot-data hook for the replay viewer.
 *
 * Contract (plan line 2804):
 * - `key` uniquely identifies the request (e.g. "stockCode|date|virtualMs").
 * - `fetcher` is a thunk that returns a Promise<T>. The call site closes over
 *   the key; we never pass the key into the fetcher.
 * - Debounces `debounceMs` (default 30ms) — only the trailing key's fetch is
 *   issued when the user scrubs rapidly.
 * - Maintains a per-hook-instance `LRUCache<string, T>` (cap = `capacity`,
 *   default 100). Different consumers do not share state.
 * - Returns `{ data, isFetching, error }`. On rapid key change the previous
 *   fetch is **aborted** and its resolve ignored via a monotonic token.
 * - `key === null` clears state and issues no fetch.
 *
 * ⚠ **키가 바뀌는 동안 `data` 는 비지 않는다** — 이전 값이 그대로 렌더된다.
 * 그것이 스크럽 UX 상 옳지만(버킷마다 깜빡이지 않는다) 소비 표면에 계약을
 * 하나 지운다: **`data` 만 읽으면 stale 과 fresh 를 구별할 수 없다.** 그래서
 * `isFetching` 은 장식이 아니라 **소비처가 반드시 처리해야 하는 반환값**이다.
 *
 * 그 계약을 지우고 있던 것이 2026-08-20 의 `/study` 버그였다: 호출부가
 * `const { data } =` 로 `isFetching` 을 버려서, 커서가 날짜를 넘어가는 동안
 * **옛 날짜의 10호가 사다리에 새 날짜의 등락률 분모**가 적용된 프레임이 떴다
 * (실측: 같은 가격 26,050 이 −1.51% → +2.76%). 같이 렌더되는 값들이 각자
 * 다른 속도로 도착하면 화면은 **어느 순간에도 존재한 적 없는 상태**를 그린다.
 *
 * 취소를 도입한 이유는 성능이 아니라 그 지연 자체다 — 죽은 요청이 브라우저
 * 커넥션을 점유하면 최신 요청이 자기가 만든 시체 뒤에서 기다리고, 지연이
 * 늘수록 토큰 폐기율이 올라가 사다리가 사실상 얼어붙는다(실측: 90ms 간격
 * 10스텝 스크럽에서 잔량 갱신 2회, 앞 470ms 완전 고정).
 *
 * `capacity` 는 **키 재사용 패턴 × 페이로드 크기**로 정한다. 기본 100 은 리플레이
 * 스크러빙 전제 — 커서를 앞뒤로 훑으면 같은 키로 자주 되돌아오고, 스냅샷 하나가
 * 작다. 그 전제가 깨지는 호출부(키가 다시는 안 맞거나 페이로드가 당일 전체 궤적급)
 * 는 반드시 좁혀 잡아야 한다. 안 그러면 "한 번 쓰고 버려진" 사본 100 벌이 힙에
 * 남아 major GC 를 늘리고 크로스헤어가 마우스를 늦게 따라온다(2026-07-29 진단).
 * capacity 는 최초 렌더에만 반영된다 — 호출부에서 상수로 넘겨라.
 */
export function useSpot<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  debounceMs: number = 30,
  capacity: number = 100,
): { data: T | undefined; isFetching: boolean; error: Error | null } {
  // Per-hook-instance cache. Initialize lazily so React stays happy.
  const cacheRef = useRef<LRUCache<string, T> | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new LRUCache<string, T>(capacity);
  }

  // Monotonic token; resolver only writes if its token is still the latest.
  const tokenRef = useRef(0);

  const [data, setData] = useState<T | undefined>(undefined);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // 에러는 **키에 딸린 상태**다. 키가 움직였으면 지난 키의 실패는 더 이상
    // 화면의 사실이 아니므로 여기서 턴다 — 안 털면 실패한 버킷 하나가 커서가
    // 떠난 뒤에도 계속 에러를 그린다. (null→null 은 React 가 bail out 한다.)
    setError(null);

    if (key === null) {
      setData(undefined);
      setIsFetching(false);
      return;
    }

    const cache = cacheRef.current as LRUCache<string, T>;
    const cached = cache.get(key);
    if (cached !== undefined) {
      setData(cached);
      setIsFetching(false);
      return;
    }

    // Cache miss — debounce, then fetch.
    const token = ++tokenRef.current;
    setIsFetching(true);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetcher(controller.signal)
        .then((value) => {
          if (token !== tokenRef.current) return; // stale — caller has moved on
          cache.set(key, value);
          setData(value);
          setIsFetching(false);
        })
        .catch((err: unknown) => {
          // 취소는 실패가 아니다 — 우리가 스스로 끊은 것이고 그 자리엔 이미 새
          // 키의 fetch 가 서 있다. 아래 토큰 검사가 이미 걸러 주지만 여기서도
          // 명시적으로 본다: 스크럽 중에는 **매 스텝이 이 경로를 지나므로**
          // 순서가 한 번만 어긋나도 화면이 에러로 깜빡인다.
          if (controller.signal.aborted) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          if (token !== tokenRef.current) return;
          // Surface the failure so a future bug of the shape "card stuck on
          // '커서 위치 로딩 중…' forever" is not silently masked. The prior
          // empty catch hid a 400 on multi-day ranges for weeks.
          console.error(`[useSpot] fetch failed for key=${key}:`, err);
          // 실패분은 **비운다**. 남겨 두면 이 훅에 재시도 경로가 없으므로 옛
          // 스냅샷이 새 커서 자리에 눌러앉아 다음 키 변경까지 거짓 데이터를
          // 그린다. 비운 자리를 "로딩" 으로 오독하지 않도록 `error` 를 함께
          // 내보내고, 소비처가 별도 상태로 그린다.
          setData(undefined);
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsFetching(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      // 비행 중이면 끊는다 — stale 응답을 무시하는 것과 **커넥션을 돌려주는
      // 것은 다른 일**이고, 후자가 없으면 최신 요청이 폐기될 요청 뒤에서 큐를
      // 기다린다(위 docstring 실측).
      controller.abort();
      // Bump token so any in-flight fetch becomes stale.
      tokenRef.current += 1;
    };
    // We intentionally do NOT include `fetcher` in deps — call sites typically
    // recreate it on each render. `key` is the source of truth for identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs]);

  return { data, isFetching, error };
}
