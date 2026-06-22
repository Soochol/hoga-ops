import type { IndexSectorRankingSector } from '../api/indexSectorRankings';

export type BasisMode = 'latest' | 'hover' | 'pinned';

export interface IndexSectorRankingUiState {
  hoverDate: string | null;
  pinnedDate: string | null;
  previewSectorId: string | null;
  pinnedSectorId: string | null;
}

export const initialIndexSectorRankingUiState: IndexSectorRankingUiState = {
  hoverDate: null,
  pinnedDate: null,
  previewSectorId: null,
  pinnedSectorId: null,
};

export type IndexSectorRankingAction =
  | { type: 'hover_date'; date: string | null }
  | { type: 'toggle_date_pin'; date: string }
  | { type: 'clear_date_pin' }
  | { type: 'preview_sector'; folderId: string | null }
  | { type: 'toggle_sector_pin'; folderId: string | null }
  | { type: 'clear_sector_pin' };

export function reduceIndexSectorRankingState(
  state: IndexSectorRankingUiState,
  action: IndexSectorRankingAction,
): IndexSectorRankingUiState {
  switch (action.type) {
    case 'hover_date':
      return state.pinnedDate ? state : { ...state, hoverDate: action.date };
    case 'toggle_date_pin':
      return {
        ...state,
        pinnedDate: state.pinnedDate === action.date ? null : action.date,
        hoverDate: state.pinnedDate === action.date ? null : state.hoverDate,
      };
    case 'clear_date_pin':
      return { ...state, pinnedDate: null };
    case 'preview_sector':
      return { ...state, previewSectorId: action.folderId };
    case 'toggle_sector_pin':
      return {
        ...state,
        pinnedSectorId: state.pinnedSectorId === action.folderId ? null : action.folderId,
      };
    case 'clear_sector_pin':
      return { ...state, pinnedSectorId: null };
  }
}

export function resolveBasisDate(
  state: IndexSectorRankingUiState,
  latestDate: string | null,
): { date: string | null; mode: BasisMode } {
  if (state.pinnedDate) return { date: state.pinnedDate, mode: 'pinned' };
  if (state.hoverDate) return { date: state.hoverDate, mode: 'hover' };
  return { date: latestDate, mode: 'latest' };
}

function sectorExists(sectors: IndexSectorRankingSector[], folderId: string | null): boolean {
  return sectors.some((sector) => sector.folder_id === folderId);
}

export function resolveActiveSectorId(
  sectors: IndexSectorRankingSector[],
  state: IndexSectorRankingUiState,
): string | null {
  if (state.previewSectorId !== null && sectorExists(sectors, state.previewSectorId)) {
    return state.previewSectorId;
  }
  if (state.pinnedSectorId !== null && sectorExists(sectors, state.pinnedSectorId)) {
    return state.pinnedSectorId;
  }
  return sectors[0]?.folder_id ?? null;
}
