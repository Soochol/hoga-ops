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
  /** 장중 오버레이 실패의 구조화된 사유(ADR-0143). 상태 태그와 갈라 저장한다 —
   *  `warnings` 는 depth·ETF 태그와 한 평면이라 사유를 섞으면 이름이 충돌한다. */
  intradayFailure?: ScreenerResponse['intraday_failure'];
  // 총잔량 신고 조건이 있을 때만 채워진다 — 결과 테이블의 호가 신고 값 컬럼 복원용.
  depthValues: Record<string, DepthPeakValue> | null;
  scannedAtMs: number;
  basis: ScanBasis;
  dataStale: boolean;
}

type Persisted = {
  selectedSavedId: string | null;
  lastScan: PanelScan | null;
  sortMode: ScreenerResultSortMode;
  // 드로어 실시간 모니터링 on/off. 영속 → 새로고침·재접속 후 자동 재개(장중 켜두는
  // 사용 패턴).
  monitoringActive: boolean;
  // 재조회 주기(ms) 사용자 override. null = 자동(스코프15/전체30초). 영속.
  monitorPeriodMs: number | null;
};

type Store = Persisted & {
  lastScan: PanelScan | null;
  setSelectedSavedId: (id: string | null) => void;
  setSortMode: (mode: ScreenerResultSortMode) => void;
  setLastScan: (scan: PanelScan) => void;
  clearLastScan: () => void;
  markLastScanDataStale: () => void;
  clearExpiredScan: (nowMs?: number) => void;
  setMonitoringActive: (active: boolean) => void;
  setMonitorPeriodMs: (periodMs: number | null) => void;
};

const DEFAULTS: Persisted = {
  selectedSavedId: null,
  lastScan: null,
  sortMode: 'default',
  monitoringActive: false,
  monitorPeriodMs: null,
};

// 사용자가 고를 수 있는 재조회 주기(ms). null = 자동(스코프15/전체30초).
export const MONITOR_PERIOD_CHOICES_MS: readonly (number | null)[] = [null, 10_000, 30_000, 60_000];

function persist(state: Persisted): void {
  persistJson(STORAGE_KEY, state);
}

function persistFromState(state: Store): void {
  persist({
    selectedSavedId: state.selectedSavedId,
    lastScan: state.lastScan,
    sortMode: state.sortMode,
    monitoringActive: state.monitoringActive,
    monitorPeriodMs: state.monitorPeriodMs,
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
    // 구버전 저장본에는 없다(필드를 넓히기만 하는 마이그레이션 — 위 주석 참조).
    intradayFailure: raw.intradayFailure as PanelScan['intradayFailure'],
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
  if (typeof parsed.monitoringActive === 'boolean') out.monitoringActive = parsed.monitoringActive;
  const period = parsed.monitorPeriodMs;
  if (period === null) out.monitorPeriodMs = null;
  else if (typeof period === 'number' && MONITOR_PERIOD_CHOICES_MS.includes(period)) out.monitorPeriodMs = period;
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

  // 드로어 '시작' = 새 검색. 이전 결과를 즉시 버려 조회 왕복 동안 옛 리스트가 새 결과인
  // 척 남지 않게 한다(조건을 바꿔 시작했을 때 특히 — 그 전엔 경고 문구로만 알렸다).
  clearLastScan: () => {
    if (get().lastScan === null) return;
    set({ lastScan: null });
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

  setMonitorPeriodMs: (periodMs) => {
    set({ monitorPeriodMs: periodMs });
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
