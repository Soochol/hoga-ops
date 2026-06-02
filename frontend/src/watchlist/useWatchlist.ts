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
        const rest = prev.entries.filter((e) => !codes.includes(e.code));
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
