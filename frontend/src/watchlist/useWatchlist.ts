import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  type WatchlistResponse,
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
    mutationFn: (code: string) => addToWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveFromWatchlist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => removeFromWatchlist(code),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
