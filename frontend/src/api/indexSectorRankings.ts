import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type IndexSectorRankingSource = 'daily_adjusted' | 'unavailable';
export type IndexSectorMissingReason = 'no_basis_bar' | 'no_previous_close' | 'no_intraday_price';
export const INDEX_SECTOR_RANKINGS_KEY = ['live', 'index-sector-rankings'] as const;
export const TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS = 60_000;

export interface IndexSectorRankingStock {
  code: string;
  name: string;
  folder_id: string | null;
  folder_name: string;
  order: number;
  close: number | null;
  previous_close: number | null;
  change_pct: number | null;
  missing_reason: IndexSectorMissingReason | null;
}

export interface IndexSectorRankingSector {
  folder_id: string | null;
  folder_name: string;
  order: number;
  change_pct: number | null;
  finite_count: number;
  total_count: number;
  stocks: IndexSectorRankingStock[];
}

export interface IndexSectorRankingResponse {
  date: string;
  source: IndexSectorRankingSource;
  unavailable_reason: 'screener_daily_corpus_missing' | 'daily_corpus_invalid' | 'no_basis_bars' | null;
  sectors: IndexSectorRankingSector[];
}

export function indexSectorRankingFreshnessOptions(
  date: string | null,
  todayKst: string | null,
): { staleTime: number; refetchInterval: number | false } {
  const isToday = !!(date && todayKst && date === todayKst);
  return {
    staleTime: TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS,
    refetchInterval: isToday ? TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS : false,
  };
}

export function useIndexSectorRankings(
  date: string | null,
  enabledByCaller = true,
  todayKst?: string | null,
) {
  const { staleTime, refetchInterval } = indexSectorRankingFreshnessOptions(date, todayKst ?? null);

  return useQuery({
    queryKey: [...INDEX_SECTOR_RANKINGS_KEY, date] as const,
    queryFn: ({ signal }) =>
      apiCall<IndexSectorRankingResponse>(
        `/api/live/index-sector-rankings?date=${date}`,
        { signal },
      ),
    enabled: enabledByCaller && !!date,
    staleTime,
    refetchInterval,
    placeholderData: (prev) => (prev && prev.date === date ? prev : undefined),
  });
}
