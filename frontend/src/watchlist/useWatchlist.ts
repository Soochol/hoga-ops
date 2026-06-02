import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  reorderWatchlist,
  catchupNow,
  catchupAll,
  type WatchlistResponse,
  type WatchlistEntry,
  type EnqueueResponse,
  type ManualCatchupAllResponse,
} from '../api/watchlist';

const KEY = ['watchlist'] as const;

export function useWatchlist() {
  return useQuery<WatchlistResponse>({
    queryKey: KEY,
    queryFn: getWatchlist,
    refetchInterval: 60_000,  // refresh the countdown source minute-ly
  });
}

export function useAddToWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['watchlist', 'add'],
    mutationFn: (code: string) => addToWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveFromWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['watchlist', 'remove'],
    mutationFn: (code: string) => removeFromWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCatchupOne() {
  const qc = useQueryClient();
  return useMutation<EnqueueResponse, Error, string>({
    mutationKey: ['watchlist', 'catchup-one'],
    mutationFn: (code: string) => catchupNow(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCatchupAll() {
  const qc = useQueryClient();
  return useMutation<ManualCatchupAllResponse, Error, void>({
    mutationKey: ['watchlist', 'catchup-all'],
    mutationFn: () => catchupAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useReorderWatchlist() {
  const qc = useQueryClient();
  return useMutation<WatchlistResponse, Error, string[], { prev?: WatchlistResponse }>({
    mutationKey: ['watchlist', 'reorder'],
    // 재정렬 mutationFn(서버 PUT)을 직렬화한다(같은 scope.id → 한 번에 하나씩).
    // 주의: onMutate(낙관적 갱신·prev 스냅샷)는 mutate() 즉시 실행돼 직렬화 대상이
    // 아니다 — query-core execute() 는 onMutate 를 먼저 await 하고 그 뒤 retryer.start()
    // 에서 canRun(scope) 게이트가 걸린다. 효과는 "서버 쓰기 직렬화": 빠른 연속 드래그의
    // 두 PUT 이 경쟁해 최종 저장 순서가 네트워크 타이밍에 좌우(last-write-wins)되던 것을
    // 막아, 디스패치 순서대로 적용되고 마지막 드래그가 결정적으로 이긴다. 클라이언트
    // transient(앞 PUT 실패 시 onError 의 prev 롤백)는 onSettled invalidate 가 그
    // 결정적 순서로 재조회해 수렴시킨다.
    scope: { id: 'watchlist-reorder' },
    mutationFn: (codes: string[]) => reorderWatchlist(codes),
    onMutate: async (codes: string[]) => {
      await qc.cancelQueries({ queryKey: KEY });
      const prev = qc.getQueryData<WatchlistResponse>(KEY);
      // Cold cache (query never loaded) → nothing to reorder optimistically;
      // the server response via onSettled invalidate will populate it.
      if (prev) {
        const byCode = new Map(prev.entries.map((e) => [e.code, e]));
        const reordered = codes
          .map((c) => byCode.get(c))
          .filter((e): e is WatchlistEntry => e !== undefined);
        const wanted = new Set(codes);
        const rest = prev.entries.filter((e) => !wanted.has(e.code));
        qc.setQueryData<WatchlistResponse>(KEY, { ...prev, entries: [...reordered, ...rest] });
      }
      return { prev };
    },
    onError: (_err, _codes, ctx) => {
      if (ctx?.prev) qc.setQueryData(KEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
