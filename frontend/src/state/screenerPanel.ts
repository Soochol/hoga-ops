import { useEffect } from 'react';
import { create } from 'zustand';
import type { DepthPeakValue, ScanBasis, ScreenerResponse, ScreenerRow } from '../api/screener';
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
  // saved* 는 드로어(저장본 기반 스캔)에서만 채워진다. 풀페이지 Screener 는 저장 안 된
  // 임시 조건으로도 조회하므로 nullable — null 이면 "임시 조건" 결과다.
  savedId: string | null;
  savedName: string | null;
  savedUpdatedAtMs: number | null;
  // 풀페이지 Screener 의 내용 기반 staleness 판정용(요청 바디 직렬화). 드로어는 신원
  // 기반(savedId/savedUpdatedAtMs)이라 null 로 둔다.
  scanKey: string | null;
  rows: ScreenerRow[];
  scanStatus: ScreenerResponse['status'];
  warnings: string[];
  // 총잔량 신고 조건이 있을 때만 채워진다 — 결과 테이블의 호가 신고 값 컬럼 복원용.
  depthValues: Record<string, DepthPeakValue> | null;
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
  // 드로어 실시간 모니터링 on/off. 영속 → 새로고침·재접속 후 자동 재개(장중 켜두는
  // 사용 패턴). 재조회 주기는 파생(선택 저장본 스코프 유무)이라 영속하지 않는다.
  monitoringActive: boolean;
};

type Store = Persisted & {
  updateState: PanelUpdateState;
  lastScan: PanelScan | null;
  setSelectedSavedId: (id: string | null) => void;
  setSortMode: (mode: ScreenerResultSortMode) => void;
  setLastScan: (scan: PanelScan) => void;
  markLastScanDataStale: () => void;
  clearExpiredScan: (nowMs?: number) => void;
  setMonitoringActive: (active: boolean) => void;
  setUpdatePending: (startedAtMs: number) => void;
  setUpdateSuccess: (finishedAtMs: number) => void;
  setUpdateError: (message: string, finishedAtMs: number) => void;
};

const DEFAULTS: Persisted = {
  selectedSavedId: null,
  lastScan: null,
  sortMode: 'default',
  updateState: { status: 'idle' },
  monitoringActive: false,
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
    monitoringActive: state.monitoringActive,
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

function isDepthPeakValue(value: unknown): value is DepthPeakValue {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    isNumberOrNull(raw.ask_today)
    && isNumberOrNull(raw.ask_past_peak)
    && typeof raw.ask_have_days === 'number'
    && typeof raw.ask_need_days === 'number'
    && isNumberOrNull(raw.bid_today)
    && isNumberOrNull(raw.bid_past_peak)
    && typeof raw.bid_have_days === 'number'
    && typeof raw.bid_need_days === 'number'
  );
}

function isDepthValues(value: unknown): value is Record<string, DepthPeakValue> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(isDepthPeakValue);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
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

// 검증 + 정규화를 한 번에: 유효하면 완전한 PanelScan, 아니면 null. 구버전 스키마(단일
// 뷰 시절 saved* 필수, scanKey/depthValues 없음)는 누락 필드를 null 로 채워 마이그레이션
// 한다(키는 screenerPanel.v1 유지 — 필드를 넓히기만 해 하위호환).
function coercePanelScan(value: unknown, nowMs = Date.now()): PanelScan | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.scanStatus !== 'ok' && raw.scanStatus !== 'not_seeded' && raw.scanStatus !== 'building') return null;
  if (raw.basis !== 'intraday' && raw.basis !== 'eod') return null;
  if (!Array.isArray(raw.rows) || !raw.rows.every(isScreenerRow)) return null;
  if (!Array.isArray(raw.warnings) || !raw.warnings.every((w) => typeof w === 'string')) return null;
  if (typeof raw.scannedAtMs !== 'number' || !Number.isFinite(raw.scannedAtMs)) return null;
  if (typeof raw.dataStale !== 'boolean') return null;

  const savedId = raw.savedId ?? null;
  const savedName = raw.savedName ?? null;
  const savedUpdatedAtMs = raw.savedUpdatedAtMs ?? null;
  const scanKey = raw.scanKey ?? null;
  if (!isStringOrNull(savedId) || !isStringOrNull(savedName) || !isStringOrNull(scanKey)) return null;
  if (!isNumberOrNull(savedUpdatedAtMs)) return null;
  let depthValues: Record<string, DepthPeakValue> | null = null;
  if (raw.depthValues != null) {
    if (!isDepthValues(raw.depthValues)) return null;
    depthValues = raw.depthValues;
  }

  const scan: PanelScan = {
    savedId,
    savedName,
    savedUpdatedAtMs,
    scanKey,
    rows: raw.rows as ScreenerRow[],
    scanStatus: raw.scanStatus,
    warnings: raw.warnings as string[],
    depthValues,
    scannedAtMs: raw.scannedAtMs,
    basis: raw.basis,
    dataStale: raw.dataStale,
  };
  return isPanelScanFresh(scan, nowMs) ? scan : null;
}

function readStorage(nowMs = Date.now()): Partial<Persisted> {
  const parsed = readJsonObject(STORAGE_KEY);
  const out: Partial<Persisted> = {};
  if (parsed.selectedSavedId === null) out.selectedSavedId = null;
  else if (typeof parsed.selectedSavedId === 'string') out.selectedSavedId = parsed.selectedSavedId;
  const lastScan = coercePanelScan(parsed.lastScan, nowMs);
  if (lastScan) out.lastScan = lastScan;
  if (isSortMode(parsed.sortMode)) out.sortMode = parsed.sortMode;
  if (isPanelUpdateState(parsed.updateState, nowMs)) out.updateState = parsed.updateState;
  if (typeof parsed.monitoringActive === 'boolean') out.monitoringActive = parsed.monitoringActive;
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

  setMonitoringActive: (active) => {
    set({ monitoringActive: active });
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

/**
 * 마운트 시 만료 스캔을 즉시 정리하고 60초마다 재확인 — 페이지·드로어가 공유하는
 * 단일 관용구(TTL 경과분이 오래 남아 "다시 조회 필요" 없이 유령 결과로 보이지 않게).
 */
export function useExpireScreenerScan(): void {
  const clearExpiredScan = useScreenerPanelStore((s) => s.clearExpiredScan);
  useEffect(() => {
    clearExpiredScan();
    const timer = window.setInterval(() => clearExpiredScan(), 60_000);
    return () => window.clearInterval(timer);
  }, [clearExpiredScan]);
}
