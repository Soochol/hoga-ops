import { create } from 'zustand';
import type { ScanBasis, ScreenerResponse, ScreenerRow } from '../api/screener';
import type {
  ScreenerResultSortDirection,
  ScreenerResultSortField,
  ScreenerResultSortMode,
} from '../screener/sortResults';
import { persistJson, readJsonObject } from './persist';

const STORAGE_KEY = 'screenerPanel.v1';
export const SCREENER_PANEL_SCAN_TTL_MS = 30 * 60 * 1000;

const SORT_FIELDS: readonly ScreenerResultSortField[] = [
  'code',
  'name',
  'market',
  'price',
  'change_pct',
  'trade_value_won',
];
const SORT_DIRECTIONS: readonly ScreenerResultSortDirection[] = ['asc', 'desc'];

export interface PanelScan {
  savedId: string;
  savedName: string;
  savedUpdatedAtMs: number;
  rows: ScreenerRow[];
  scanStatus: ScreenerResponse['status'];
  warnings: string[];
  scannedAtMs: number;
  basis: ScanBasis;
  dataStale: boolean;
}

export type PanelUpdateState =
  | { status: 'idle' }
  | { status: 'pending'; startedAtMs: number }
  | { status: 'success'; startedAtMs: number | null; finishedAtMs: number }
  | { status: 'error'; startedAtMs: number | null; finishedAtMs: number; message: string };

type Persisted = {
  selectedSavedId: string | null;
  lastScan: PanelScan | null;
  sortMode: ScreenerResultSortMode;
  updateState: PanelUpdateState;
};

type Store = Persisted & {
  updateState: PanelUpdateState;
  lastScan: PanelScan | null;
  setSelectedSavedId: (id: string | null) => void;
  setSortMode: (mode: ScreenerResultSortMode) => void;
  setLastScan: (scan: PanelScan) => void;
  markLastScanDataStale: () => void;
  clearExpiredScan: (nowMs?: number) => void;
  setUpdatePending: (startedAtMs: number) => void;
  setUpdateSuccess: (finishedAtMs: number) => void;
  setUpdateError: (message: string, finishedAtMs: number) => void;
};

const DEFAULTS: Persisted = {
  selectedSavedId: null,
  lastScan: null,
  sortMode: 'default',
  updateState: { status: 'idle' },
};

function persist(state: Persisted): void {
  persistJson(STORAGE_KEY, state);
}

function persistFromState(state: Store): void {
  persist({
    selectedSavedId: state.selectedSavedId,
    lastScan: state.lastScan,
    sortMode: state.sortMode,
    updateState: persistableUpdateState(state.updateState),
  });
}

function isSortMode(value: unknown): value is ScreenerResultSortMode {
  if (value === 'default') return true;
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.field === 'string'
    && (SORT_FIELDS as readonly string[]).includes(raw.field)
    && typeof raw.direction === 'string'
    && (SORT_DIRECTIONS as readonly string[]).includes(raw.direction)
  );
}

function isMarket(value: unknown): value is ScreenerRow['market'] {
  return value === 'KOSPI' || value === 'KOSDAQ';
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isScreenerRow(value: unknown): value is ScreenerRow {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.code === 'string'
    && typeof raw.name === 'string'
    && isMarket(raw.market)
    && typeof raw.price === 'number'
    && Number.isFinite(raw.price)
    && typeof raw.trade_value_won === 'number'
    && Number.isFinite(raw.trade_value_won)
    && isNumberOrNull(raw.change_pct)
  );
}

export function isPanelScanFresh(scan: PanelScan, nowMs = Date.now()): boolean {
  const ageMs = nowMs - scan.scannedAtMs;
  return ageMs >= 0 && ageMs <= SCREENER_PANEL_SCAN_TTL_MS;
}

function isTerminalUpdateFresh(finishedAtMs: number, nowMs = Date.now()): boolean {
  const ageMs = nowMs - finishedAtMs;
  return ageMs >= 0 && ageMs <= SCREENER_PANEL_SCAN_TTL_MS;
}

function isNumberOrNullField(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function persistableUpdateState(state: PanelUpdateState): PanelUpdateState {
  return state.status === 'success' || state.status === 'error' ? state : { status: 'idle' };
}

function isPanelUpdateState(value: unknown, nowMs = Date.now()): value is PanelUpdateState {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw.status === 'idle') return true;
  if (raw.status === 'pending') return false;
  if (raw.status === 'success') {
    return (
      isNumberOrNullField(raw.startedAtMs)
      && typeof raw.finishedAtMs === 'number'
      && Number.isFinite(raw.finishedAtMs)
      && isTerminalUpdateFresh(raw.finishedAtMs, nowMs)
    );
  }
  if (raw.status === 'error') {
    return (
      isNumberOrNullField(raw.startedAtMs)
      && typeof raw.finishedAtMs === 'number'
      && Number.isFinite(raw.finishedAtMs)
      && typeof raw.message === 'string'
      && raw.message.length > 0
      && isTerminalUpdateFresh(raw.finishedAtMs, nowMs)
    );
  }
  return false;
}

function isPanelScan(value: unknown, nowMs = Date.now()): value is PanelScan {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw.scanStatus !== 'ok' && raw.scanStatus !== 'not_seeded' && raw.scanStatus !== 'building') return false;
  if (raw.basis !== 'intraday' && raw.basis !== 'eod') return false;
  if (!Array.isArray(raw.rows) || !raw.rows.every(isScreenerRow)) return false;
  if (!Array.isArray(raw.warnings) || !raw.warnings.every((w) => typeof w === 'string')) return false;
  const scan = raw as Partial<PanelScan>;
  return (
    typeof scan.savedId === 'string'
    && typeof scan.savedName === 'string'
    && typeof scan.savedUpdatedAtMs === 'number'
    && Number.isFinite(scan.savedUpdatedAtMs)
    && typeof scan.scannedAtMs === 'number'
    && Number.isFinite(scan.scannedAtMs)
    && typeof scan.dataStale === 'boolean'
    && isPanelScanFresh(scan as PanelScan, nowMs)
  );
}

function readStorage(nowMs = Date.now()): Partial<Persisted> {
  const parsed = readJsonObject(STORAGE_KEY);
  const out: Partial<Persisted> = {};
  if (parsed.selectedSavedId === null) out.selectedSavedId = null;
  else if (typeof parsed.selectedSavedId === 'string') out.selectedSavedId = parsed.selectedSavedId;
  if (isPanelScan(parsed.lastScan, nowMs)) out.lastScan = parsed.lastScan;
  if (isSortMode(parsed.sortMode)) out.sortMode = parsed.sortMode;
  if (isPanelUpdateState(parsed.updateState, nowMs)) out.updateState = parsed.updateState;
  return out;
}

const hydrated = readStorage();

export const useScreenerPanelStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...hydrated,

  setSelectedSavedId: (id) => {
    set({ selectedSavedId: id });
    persistFromState(get());
  },

  setSortMode: (sortMode) => {
    set({ sortMode });
    persistFromState(get());
  },

  setLastScan: (scan) => {
    set({ lastScan: scan });
    persistFromState(get());
  },

  markLastScanDataStale: () => {
    const { lastScan } = get();
    if (!lastScan) return;
    set({ lastScan: { ...lastScan, dataStale: true } });
    persistFromState(get());
  },

  clearExpiredScan: (nowMs = Date.now()) => {
    const { lastScan } = get();
    if (!lastScan || isPanelScanFresh(lastScan, nowMs)) return;
    set({ lastScan: null });
    persistFromState(get());
  },

  setUpdatePending: (startedAtMs) => {
    set({ updateState: { status: 'pending', startedAtMs } });
    persistFromState(get());
  },

  setUpdateSuccess: (finishedAtMs) => {
    const prev = get().updateState;
    set({
      updateState: {
        status: 'success',
        startedAtMs: prev.status === 'pending' ? prev.startedAtMs : null,
        finishedAtMs,
      },
    });
    persistFromState(get());
  },

  setUpdateError: (message, finishedAtMs) => {
    const prev = get().updateState;
    set({
      updateState: {
        status: 'error',
        startedAtMs: prev.status === 'pending' ? prev.startedAtMs : null,
        finishedAtMs,
        message,
      },
    });
    persistFromState(get());
  },
}));
