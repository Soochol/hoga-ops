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
 * - Returns `{ data, isFetching }`. On rapid key change, the previous fetch's
 *   result is discarded (we don't abort the network — we just ignore stale
 *   resolves via a monotonic token).
 * - `key === null` clears state and issues no fetch.
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
  fetcher: () => Promise<T>,
  debounceMs: number = 30,
  capacity: number = 100,
): { data: T | undefined; isFetching: boolean } {
  // Per-hook-instance cache. Initialize lazily so React stays happy.
  const cacheRef = useRef<LRUCache<string, T> | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new LRUCache<string, T>(capacity);
  }

  // Monotonic token; resolver only writes if its token is still the latest.
  const tokenRef = useRef(0);

  const [data, setData] = useState<T | undefined>(undefined);
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
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

    const timer = setTimeout(() => {
      fetcher()
        .then((value) => {
          if (token !== tokenRef.current) return; // stale — caller has moved on
          cache.set(key, value);
          setData(value);
          setIsFetching(false);
        })
        .catch((err: unknown) => {
          if (token !== tokenRef.current) return;
          // Surface the failure so a future bug of the shape "card stuck on
          // '커서 위치 로딩 중…' forever" is not silently masked. We keep
          // `data` as undefined (callers distinguish loading vs no-data via
          // the undefined check), but at least the error reaches the console
          // for diagnosis. The prior empty catch hid a 400 on multi-day
          // ranges for weeks.
          console.error(`[useSpot] fetch failed for key=${key}:`, err);
          setIsFetching(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      // Bump token so any in-flight fetch becomes stale.
      tokenRef.current += 1;
    };
    // We intentionally do NOT include `fetcher` in deps — call sites typically
    // recreate it on each render. `key` is the source of truth for identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, debounceMs]);

  return { data, isFetching };
}
