import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type IndexSectorRankingSource = 'daily_adjusted' | 'unavailable';
export type IndexSectorMissingReason = 'no_basis_bar' | 'no_previous_close';

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
  unavailable_reason: 'screener_daily_corpus_missing' | null;
  sectors: IndexSectorRankingSector[];
}

export function useIndexSectorRankings(date: string | null, enabledByCaller = true) {
  return useQuery({
    queryKey: ['live', 'index-sector-rankings', date] as const,
    queryFn: ({ signal }) =>
      apiCall<IndexSectorRankingResponse>(
        `/api/live/index-sector-rankings?date=${date}`,
        { signal },
      ),
    enabled: enabledByCaller && !!date,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.date === date ? prev : undefined),
  });
}
