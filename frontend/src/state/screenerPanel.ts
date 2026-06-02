import { create } from 'zustand';
import type { ScreenerRow, ScreenerResponse } from '../api/screener';
import { persistJson, readJsonObject } from './persist';

const STORAGE_KEY = 'screenerPanel.v1';

export interface PanelScan {
  savedId: string;
  savedName: string;
  rows: ScreenerRow[];
  scanStatus: ScreenerResponse['status']; // 'ok' | 'not_seeded' | 'building'
  warnings: string[];
}

type Persisted = { selectedSavedId: string | null };

type Store = Persisted & {
  lastScan: PanelScan | null;
  setSelectedSavedId: (id: string | null) => void;
  setLastScan: (scan: PanelScan) => void;
};

const DEFAULTS: Persisted = { selectedSavedId: null };

function persist(state: Persisted): void {
  persistJson(STORAGE_KEY, state);
}

// Only selectedSavedId is persisted. Accept a string id or an explicit null;
// reject anything else (corrupt/hand-edited) so it can't leak into state.
function readStorage(): Partial<Persisted> {
  const parsed = readJsonObject(STORAGE_KEY);
  // Explicit null branch: a stored null (deselected) is valid and must be
  // accepted before the string check.
  if (parsed.selectedSavedId === null) return { selectedSavedId: null };
  if (typeof parsed.selectedSavedId === 'string') return { selectedSavedId: parsed.selectedSavedId };
  return {};
}

// lastScan is in-memory only: it survives panel close/reopen and route changes
// (the store outlives the drawer's mount) but is gone on a full reload — a
// screener row is a price snapshot, so showing a stale one after restart misleads.
export const useScreenerPanelStore = create<Store>((set) => ({
  ...DEFAULTS,
  ...readStorage(),
  lastScan: null,

  setSelectedSavedId: (id) => {
    const next: Persisted = { selectedSavedId: id };
    set(next);
    persist(next);
  },
  setLastScan: (scan) => set({ lastScan: scan }),
}));
