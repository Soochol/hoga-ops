import type { IndexSectorRankingSector } from '../api/indexSectorRankings';

export type BasisMode = 'latest' | 'hover' | 'pinned';
export type SectorIdentityKey = string;

// v3 (ADR-0112): heatmap folder_id 는 항상 실폴더 — __uncat__ 센티널 키는 폐지.
export function sectorIdentityKey(folderId: string): SectorIdentityKey {
  return `folder:${folderId}`;
}

export interface IndexSectorRankingUiState {
  hoverDate: string | null;
  pinnedDate: string | null;
  previewSectorKey: SectorIdentityKey | null;
  pinnedSectorKey: SectorIdentityKey | null;
}

export const initialIndexSectorRankingUiState: IndexSectorRankingUiState = {
  hoverDate: null,
  pinnedDate: null,
  previewSectorKey: null,
  pinnedSectorKey: null,
};

export type IndexSectorRankingAction =
  | { type: 'hover_date'; date: string | null }
  | { type: 'select_date'; date: string | null }
  | { type: 'toggle_date_pin'; date: string }
  | { type: 'clear_date_pin' }
  | { type: 'preview_sector'; sectorKey: SectorIdentityKey | null }
  | { type: 'toggle_sector_pin'; sectorKey: SectorIdentityKey | null }
  | { type: 'clear_sector_pin' };

export function reduceIndexSectorRankingState(
  state: IndexSectorRankingUiState,
  action: IndexSectorRankingAction,
): IndexSectorRankingUiState {
  switch (action.type) {
    case 'hover_date':
      return state.pinnedDate ? state : { ...state, hoverDate: action.date };
    case 'select_date':
      return { ...state, pinnedDate: action.date, hoverDate: null };
    case 'toggle_date_pin':
      return {
        ...state,
        pinnedDate: state.pinnedDate === action.date ? null : action.date,
        hoverDate: state.pinnedDate === action.date ? null : state.hoverDate,
      };
    case 'clear_date_pin':
      return { ...state, pinnedDate: null, hoverDate: null };
    case 'preview_sector':
      return { ...state, previewSectorKey: action.sectorKey };
    case 'toggle_sector_pin':
      return {
        ...state,
        pinnedSectorKey: state.pinnedSectorKey === action.sectorKey ? null : action.sectorKey,
      };
    case 'clear_sector_pin':
      return { ...state, pinnedSectorKey: null };
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

function findSectorByKey(
  sectors: IndexSectorRankingSector[],
  sectorKey: SectorIdentityKey,
): IndexSectorRankingSector | null {
  return sectors.find((sector) => sectorIdentityKey(sector.folder_id) === sectorKey) ?? null;
}

export function resolveActiveSectorId(
  sectors: IndexSectorRankingSector[],
  state: IndexSectorRankingUiState,
): SectorIdentityKey | null {
  if (state.previewSectorKey !== null) {
    const previewSector = findSectorByKey(sectors, state.previewSectorKey);
    if (previewSector) return sectorIdentityKey(previewSector.folder_id);
  }
  if (state.pinnedSectorKey !== null) {
    const pinnedSector = findSectorByKey(sectors, state.pinnedSectorKey);
    if (pinnedSector) return sectorIdentityKey(pinnedSector.folder_id);
  }
  return sectors[0] ? sectorIdentityKey(sectors[0].folder_id) : null;
}
