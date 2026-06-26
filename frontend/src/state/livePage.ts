import { create } from 'zustand';
import type { MASource } from '../chart/projectors/movingAverage';
import {
  mergeLiveIndicatorPrefs,
  DEFAULT_LIVE_MAS,
  DEFAULT_DAILY_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  TRADE_VOLUME_POC_DEFAULT_BAND_PCT,
  TRADE_VOLUME_POC_DEFAULT_COLOR,
  TRADE_VOLUME_POC_DEFAULT_OPACITY,
  BROKER_LATE_ENTRY_DEFAULT_START_HHMM,
  BROKER_LATE_ENTRY_DEFAULT_WINDOW_MINUTES,
  type LiveMAConfig,
  type BrokerLateEntrySideMode,
  type PersistedIndicators,
} from './liveIndicatorsPersistence';
import {
  instrumentToActiveCode,
  isLiveInstrument,
  stockInstrument,
  type LiveInstrument,
} from '../live/liveInstrument';
export type { MASource };

// Re-export so existing imports from `./livePage` keep working — single
// source of truth lives in `./liveIndicatorsPersistence` to break the
// circular import the persistence helper would otherwise have on the
// store module. ADR-0046.
export {
  DEFAULT_LIVE_MAS,
  DEFAULT_DAILY_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  TRADE_VOLUME_POC_DEFAULT_BAND_PCT,
  TRADE_VOLUME_POC_DEFAULT_COLOR,
  TRADE_VOLUME_POC_DEFAULT_OPACITY,
};
export type { BrokerLateEntrySideMode, LiveMAConfig };

/** Timeframes the live page supports.
 *
 * Backend (KIS) exposes only the base set directly: '1m', 'D', 'W', 'M'.
 * Aggregated minute frames (3m–30m) are computed client-side from the 1m
 * series; see ``aggregateCandles``. Daily/weekly/monthly frames render
 * the indicator pane empty (Addendum 9.4 — hoga indicators are intraday only). */
export const LIVE_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', 'D', 'W', 'M'] as const;
export type LiveTimeframe = (typeof LIVE_TIMEFRAMES)[number];

/** Server-side base timeframes (no client aggregation). */
export const BASE_TIMEFRAMES = ['1m', 'D', 'W', 'M'] as const;
export type BaseTimeframe = (typeof BASE_TIMEFRAMES)[number];

/** Minute subset of LiveTimeframe — round-trips to `/api/range` via wire
 * `bucket_ms`, gets the full 5-pane chart. */
export const MINUTE_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m'] as const;
export type MinuteTimeframe = (typeof MINUTE_TIMEFRAMES)[number];

/** Calendar subset of LiveTimeframe — client-aggregated (`aggregateCalendar`),
 * candle + volume panes only (ADR-0041). */
export const CALENDAR_TIMEFRAMES = ['D', 'W', 'M'] as const;
export type CalendarTimeframe = (typeof CALENDAR_TIMEFRAMES)[number];

export function isMinuteTimeframe(tf: LiveTimeframe): tf is MinuteTimeframe {
  return (MINUTE_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isCalendarTimeframe(tf: LiveTimeframe): tf is CalendarTimeframe {
  return (CALENDAR_TIMEFRAMES as readonly string[]).includes(tf);
}

/** Map a display timeframe to the base timeframe to fetch from the server.
 * Minute frames all source from '1m'; D/W/M pass through. */
export function baseFor(tf: LiveTimeframe): BaseTimeframe {
  if (tf === 'D' || tf === 'W' || tf === 'M') return tf;
  return '1m';
}

/** Bucket size in seconds for a minute display timeframe, or null for D/W/M
 * (calendar buckets — handled by the server). */
export function bucketSeconds(tf: LiveTimeframe): number | null {
  if (tf === '1m') return 60;
  if (tf === '3m') return 180;
  if (tf === '5m') return 300;
  if (tf === '10m') return 600;
  if (tf === '15m') return 900;
  if (tf === '30m') return 1800;
  return null;
}

const STORAGE_KEY = 'live.page.v1';
const INDICATORS_STORAGE_KEY = 'live.indicators.v1';

type Persisted = {
  activeInstrument: LiveInstrument | null;
  activeCode: string | null;
  candleTimeframe: LiveTimeframe;
  lastMinuteTimeframe: MinuteTimeframe;
  /** Earliest stock-date the user has scrolled into (YYYYMMDD). null = today
   * only (no /api/range call needed yet). Resets when activeCode or timeframe
   * changes. */
  historicalFromDate: string | null;
};

// `PersistedIndicators` (the persisted indicator-prefs slice — MA config + the
// per-indicator master toggles) is defined ONCE in ./liveIndicatorsPersistence
// and imported above. Single source of truth (ADR-0046): adding an indicator
// field touches one type, not two. The store's indicator slice IS that type.

/** The full active-view tuple the page renders. Written atomically by the active
 *  Live Tab (applyTabToPage → projectActiveView) so there is no setter ordering to
 *  get wrong (setActiveCode/setCandleTimeframe each reset historicalFromDate; an
 *  atomic write has nothing to reset-then-restore). */
export type ActiveViewProjection = {
  instrument?: LiveInstrument | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
};

type Store = Persisted & PersistedIndicators & {
  projectActiveView: (view: ActiveViewProjection) => void;
  setActiveCode: (code: string | null) => void;
  setCandleTimeframe: (tf: LiveTimeframe) => void;
  extendHistoricalRange: (date: string) => void;
  resetHistoricalRange: () => void;
  hydrateFromStorage: () => void;
  setMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addMovingAverage: () => void;
  removeMovingAverage: (id: string) => void;
  setMovingAverageEnabled: (enabled: boolean) => void;
  setForeignNetEnabled: (enabled: boolean) => void;
  setInstitutionNetEnabled: (enabled: boolean) => void;
  setVolumeEnabled: (enabled: boolean) => void;
  setMovingAverageHidden: (hidden: boolean) => void;
  setAskPeakEnabled: (enabled: boolean) => void;
  setAskPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setAskPeakAllPriceStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setAskPeakVisibleMaxStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setViLimitPriceLineStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setBidPeakEnabled: (enabled: boolean) => void;
  setBidPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setBidPeakAllPriceStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setTradeVolumePocEnabled: (enabled: boolean) => void;
  setTradeVolumePocBandPct: (bandPct: number) => void;
  setTradeVolumePocStyle: (patch: { color?: string; opacity?: number }) => void;
  setVolumeDistributionEnabled: (enabled: boolean) => void;
  setVolumeDistributionRangeCount: (count: number) => void;
  setVolumeDistributionStyle: (patch: { color?: string; maxColor?: string }) => void;
  setQuoteTotalsEnabled: (enabled: boolean) => void;
  setRatioEnabled: (enabled: boolean) => void;
  setFillStrengthEnabled: (enabled: boolean) => void;
  setProgramTradeEnabled: (enabled: boolean) => void;
  setBrokerLateEntryEnabled: (enabled: boolean) => void;
  setBrokerLateEntryStartHHMM: (value: number) => void;
  setBrokerLateEntryWindowMinutes: (value: number) => void;
  setBrokerLateEntrySideMode: (mode: BrokerLateEntrySideMode) => void;
  setBrokerLateEntryStyle: (patch: { buyColor?: string; sellColor?: string }) => void;
  setDailyMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addDailyMovingAverage: () => void;
  removeDailyMovingAverage: (id: string) => void;
  setDailyMovingAverageEnabled: (enabled: boolean) => void;
  setDailyMovingAverageHidden: (hidden: boolean) => void;
};

const DEFAULTS: Persisted = {
  activeInstrument: null,
  activeCode: null,
  candleTimeframe: '1m',
  lastMinuteTimeframe: '1m',
  historicalFromDate: null,
};

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (SSR, privacy mode) — silent fallback.
  }
}

function isLiveTimeframe(v: unknown): v is LiveTimeframe {
  return typeof v === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(v);
}

function isMinuteFrameValue(v: unknown): v is MinuteTimeframe {
  return typeof v === 'string' && (MINUTE_TIMEFRAMES as readonly string[]).includes(v);
}

function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed) return {};
    const candleTimeframe = isLiveTimeframe(parsed.candleTimeframe) ? parsed.candleTimeframe : undefined;
    const derivedMinute = isMinuteFrameValue(parsed.lastMinuteTimeframe)
      ? parsed.lastMinuteTimeframe
      : isMinuteFrameValue(candleTimeframe)
        ? candleTimeframe
        : undefined;
    const next: Partial<Persisted> = {};
    if (isLiveInstrument(parsed.activeInstrument)) {
      next.activeInstrument = parsed.activeInstrument;
    } else if (typeof parsed.activeCode === 'string' && parsed.activeCode) {
      next.activeInstrument = stockInstrument(parsed.activeCode);
    } else if (parsed.activeInstrument === null || parsed.activeCode === null) {
      next.activeInstrument = null;
    }
    if (typeof parsed.activeCode === 'string' || parsed.activeCode === null) {
      next.activeCode = parsed.activeCode;
    } else if (next.activeInstrument !== undefined) {
      next.activeCode = instrumentToActiveCode(next.activeInstrument);
    }
    if (candleTimeframe !== undefined) {
      next.candleTimeframe = candleTimeframe;
    }
    if (derivedMinute !== undefined) {
      next.lastMinuteTimeframe = derivedMinute;
    }
    if (typeof parsed.historicalFromDate === 'string' || parsed.historicalFromDate === null) {
      next.historicalFromDate = parsed.historicalFromDate;
    }
    return next;
  } catch {
    return {};
  }
}

function persistIndicators(state: PersistedIndicators): void {
  try {
    localStorage.setItem(INDICATORS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — silent fallback
  }
}

/** Serialize the current indicator slice for persistence. Reads the live store
 *  so every setter persists ALL indicator fields, not just the one it changed
 *  (prevents a foreign-toggle write from clobbering MA prefs, and vice versa). */
function snapshotIndicators(get: () => Store): PersistedIndicators {
  const s = get();
  return {
    movingAverages: s.movingAverages,
    movingAverageEnabled: s.movingAverageEnabled,
    foreignNetEnabled: s.foreignNetEnabled,
    institutionNetEnabled: s.institutionNetEnabled,
    volumeEnabled: s.volumeEnabled,
    movingAverageHidden: s.movingAverageHidden,
    askPeakEnabled: s.askPeakEnabled,
    askPeakColor: s.askPeakColor,
    askPeakLineWidth: s.askPeakLineWidth,
    askPeakAllPriceColor: s.askPeakAllPriceColor,
    askPeakAllPriceLineWidth: s.askPeakAllPriceLineWidth,
    askPeakVisibleMaxColor: s.askPeakVisibleMaxColor,
    askPeakVisibleMaxLineWidth: s.askPeakVisibleMaxLineWidth,
    viLimitPriceLineColor: s.viLimitPriceLineColor,
    viLimitPriceLineWidth: s.viLimitPriceLineWidth,
    bidPeakEnabled: s.bidPeakEnabled,
    bidPeakColor: s.bidPeakColor,
    bidPeakLineWidth: s.bidPeakLineWidth,
    bidPeakAllPriceColor: s.bidPeakAllPriceColor,
    bidPeakAllPriceLineWidth: s.bidPeakAllPriceLineWidth,
    tradeVolumePocEnabled: s.tradeVolumePocEnabled,
    tradeVolumePocBandPct: s.tradeVolumePocBandPct,
    tradeVolumePocColor: s.tradeVolumePocColor,
    tradeVolumePocOpacity: s.tradeVolumePocOpacity,
    volumeDistributionEnabled: s.volumeDistributionEnabled,
    volumeDistributionRangeCount: s.volumeDistributionRangeCount,
    volumeDistributionColor: s.volumeDistributionColor,
    volumeDistributionMaxColor: s.volumeDistributionMaxColor,
    quoteTotalsEnabled: s.quoteTotalsEnabled,
    ratioEnabled: s.ratioEnabled,
    fillStrengthEnabled: s.fillStrengthEnabled,
    programTradeEnabled: s.programTradeEnabled,
    brokerLateEntryEnabled: s.brokerLateEntryEnabled,
    brokerLateEntryStartHHMM: s.brokerLateEntryStartHHMM,
    brokerLateEntryWindowMinutes: s.brokerLateEntryWindowMinutes,
    brokerLateEntrySideMode: s.brokerLateEntrySideMode,
    brokerLateEntryBuyColor: s.brokerLateEntryBuyColor,
    brokerLateEntrySellColor: s.brokerLateEntrySellColor,
    dailyMovingAverages: s.dailyMovingAverages,
    dailyMovingAverageEnabled: s.dailyMovingAverageEnabled,
    dailyMovingAverageHidden: s.dailyMovingAverageHidden,
  };
}

function readIndicatorsStorage(): PersistedIndicators {
  try {
    const raw = localStorage.getItem(INDICATORS_STORAGE_KEY);
    return mergeLiveIndicatorPrefs(raw ? JSON.parse(raw) : undefined);
  } catch {
    return mergeLiveIndicatorPrefs(undefined);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeBrokerLateEntryStartHHMM(value: number): number {
  const next = Math.trunc(value);
  const hh = Math.floor(next / 100);
  const mm = next % 100;
  return hh < 9 || hh > 15 || mm < 0 || mm > 59 || (hh === 15 && mm > 20)
    ? BROKER_LATE_ENTRY_DEFAULT_START_HHMM
    : next;
}

function normalizeBrokerLateEntryWindowMinutes(value: number): number {
  return clamp(Math.trunc(value), 1, 240);
}

function nextSlotId(existing: readonly LiveMAConfig[], prefix = 'ma'): string {
  const used = new Set(existing.map((m) => m.id));
  // Try fast path: <prefix>-N for N up to MA_SLOT_LIMIT * 2.
  for (let i = 1; i <= MA_SLOT_LIMIT * 2; i++) {
    const id = `${prefix}-${i}`;
    if (!used.has(id)) return id;
  }
  // Fallback (should never hit given MA_SLOT_LIMIT cap).
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

/** 8색 hex palette — tokens.css의 --ma-1..--ma-8과 매칭. canvas는 CSS
 *  var를 직접 받지 못해 hex로 정적 deflate. 신규 슬롯의 색 자동 배정
 *  (`nextSlotColor`)에 사용한다. 사용자가 직접 색을 고르는 32색 grid
 *  (8 hue × 4 shade)는 `MAStylePicker`에 별도로 정의되어 있다. */
export const MA_PALETTE: readonly string[] = [
  '#EC4899', '#3B82F6', '#F97316', '#22C55E',
  '#F8FAFC', '#06B6D4', '#EAB308', '#94A3B8',
];

function nextSlotColor(existing: readonly LiveMAConfig[]): string {
  const used = new Set(existing.map((m) => m.color.toLowerCase()));
  const free = MA_PALETTE.find((c) => !used.has(c.toLowerCase()));
  return free ?? MA_PALETTE[existing.length % MA_PALETTE.length];
}

export const useLivePageStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...readStorage(),
  ...readIndicatorsStorage(),

  setMovingAverage: (id, patch) => {
    const current = get().movingAverages;
    const idx = current.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const cur = current[idx];
    const next: LiveMAConfig = { ...cur, ...patch };
    if (patch.period !== undefined) {
      const p = Number(patch.period);
      if (!Number.isFinite(p)) return;
      next.period = clamp(Math.floor(p), MA_PERIOD_MIN, MA_PERIOD_MAX);
    }
    const nextArr = current.slice();
    nextArr[idx] = next;
    set({ movingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  addMovingAverage: () => {
    const current = get().movingAverages;
    if (current.length >= MA_SLOT_LIMIT) return;
    const last = current[current.length - 1];
    const period = last ? clamp(last.period * 2, MA_PERIOD_MIN, MA_PERIOD_MAX) : 20;
    const next: LiveMAConfig = {
      id: nextSlotId(current),
      enabled: true,
      period,
      color: nextSlotColor(current),
      lineWidth: 1,
      source: 'close',
    };
    const nextArr = [...current, next];
    set({ movingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  removeMovingAverage: (id) => {
    const current = get().movingAverages;
    if (current.length <= 1) return;
    const nextArr = current.filter((m) => m.id !== id);
    if (nextArr.length === current.length) return; // unknown id
    set({ movingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  setMovingAverageEnabled: (enabled) => {
    set({ movingAverageEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setForeignNetEnabled: (enabled) => {
    set({ foreignNetEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setInstitutionNetEnabled: (enabled) => {
    set({ institutionNetEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setVolumeEnabled: (enabled) => {
    set({ volumeEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setMovingAverageHidden: (hidden) => {
    set({ movingAverageHidden: hidden });
    persistIndicators(snapshotIndicators(get));
  },

  setAskPeakEnabled: (enabled) => {
    set({ askPeakEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setAskPeakStyle: (patch) => {
    set((s) => ({
      askPeakColor: patch.color ?? s.askPeakColor,
      askPeakLineWidth: patch.lineWidth ?? s.askPeakLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setAskPeakAllPriceStyle: (patch) => {
    set((s) => ({
      askPeakAllPriceColor: patch.color ?? s.askPeakAllPriceColor,
      askPeakAllPriceLineWidth: patch.lineWidth ?? s.askPeakAllPriceLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setAskPeakVisibleMaxStyle: (patch) => {
    set((s) => ({
      askPeakVisibleMaxColor: patch.color ?? s.askPeakVisibleMaxColor,
      askPeakVisibleMaxLineWidth: patch.lineWidth ?? s.askPeakVisibleMaxLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setViLimitPriceLineStyle: (patch) => {
    set((s) => ({
      viLimitPriceLineColor: patch.color ?? s.viLimitPriceLineColor,
      viLimitPriceLineWidth: patch.lineWidth ?? s.viLimitPriceLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setBidPeakEnabled: (enabled) => {
    set({ bidPeakEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setBidPeakStyle: (patch) => {
    set((s) => ({
      bidPeakColor: patch.color ?? s.bidPeakColor,
      bidPeakLineWidth: patch.lineWidth ?? s.bidPeakLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setBidPeakAllPriceStyle: (patch) => {
    set((s) => ({
      bidPeakAllPriceColor: patch.color ?? s.bidPeakAllPriceColor,
      bidPeakAllPriceLineWidth: patch.lineWidth ?? s.bidPeakAllPriceLineWidth,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setTradeVolumePocEnabled: (enabled) => {
    set({ tradeVolumePocEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setTradeVolumePocBandPct: (bandPct) => {
    if (bandPct !== 0.0025 && bandPct !== 0.005 && bandPct !== 0.01) return;
    set({ tradeVolumePocBandPct: bandPct });
    persistIndicators(snapshotIndicators(get));
  },

  setTradeVolumePocStyle: (patch) => {
    set((s) => ({
      tradeVolumePocColor: patch.color ?? s.tradeVolumePocColor,
      tradeVolumePocOpacity: patch.opacity === undefined
        ? s.tradeVolumePocOpacity
        : clamp(patch.opacity, 0, 1),
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setVolumeDistributionEnabled: (enabled) => {
    set({ volumeDistributionEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setVolumeDistributionRangeCount: (count) => {
    if (!Number.isFinite(count)) return;
    set({ volumeDistributionRangeCount: clamp(Math.trunc(count), 5, 30) });
    persistIndicators(snapshotIndicators(get));
  },

  setVolumeDistributionStyle: (patch) => {
    set((s) => ({
      volumeDistributionColor: patch.color ?? s.volumeDistributionColor,
      volumeDistributionMaxColor: patch.maxColor ?? s.volumeDistributionMaxColor,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setQuoteTotalsEnabled: (enabled) => {
    set({ quoteTotalsEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setRatioEnabled: (enabled) => {
    set({ ratioEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setFillStrengthEnabled: (enabled) => {
    set({ fillStrengthEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setProgramTradeEnabled: (enabled) => {
    set({ programTradeEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setBrokerLateEntryEnabled: (enabled) => {
    set({ brokerLateEntryEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setBrokerLateEntryStartHHMM: (value) => {
    if (!Number.isFinite(value)) {
      set({ brokerLateEntryStartHHMM: BROKER_LATE_ENTRY_DEFAULT_START_HHMM });
      persistIndicators(snapshotIndicators(get));
      return;
    }
    set({ brokerLateEntryStartHHMM: normalizeBrokerLateEntryStartHHMM(value) });
    persistIndicators(snapshotIndicators(get));
  },

  setBrokerLateEntryWindowMinutes: (value) => {
    if (!Number.isFinite(value)) {
      set({ brokerLateEntryWindowMinutes: BROKER_LATE_ENTRY_DEFAULT_WINDOW_MINUTES });
      persistIndicators(snapshotIndicators(get));
      return;
    }
    set({ brokerLateEntryWindowMinutes: normalizeBrokerLateEntryWindowMinutes(value) });
    persistIndicators(snapshotIndicators(get));
  },

  setBrokerLateEntrySideMode: (mode) => {
    if (mode !== 'both' && mode !== 'buy' && mode !== 'sell') return;
    set({ brokerLateEntrySideMode: mode });
    persistIndicators(snapshotIndicators(get));
  },

  setBrokerLateEntryStyle: (patch) => {
    set((s) => ({
      brokerLateEntryBuyColor: patch.buyColor ?? s.brokerLateEntryBuyColor,
      brokerLateEntrySellColor: patch.sellColor ?? s.brokerLateEntrySellColor,
    }));
    persistIndicators(snapshotIndicators(get));
  },

  setDailyMovingAverage: (id, patch) => {
    const current = get().dailyMovingAverages;
    const idx = current.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const cur = current[idx];
    const next: LiveMAConfig = { ...cur, ...patch };
    if (patch.period !== undefined) {
      const p = Number(patch.period);
      if (!Number.isFinite(p)) return;
      next.period = clamp(Math.floor(p), MA_PERIOD_MIN, MA_PERIOD_MAX);
    }
    const nextArr = current.slice();
    nextArr[idx] = next;
    set({ dailyMovingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  addDailyMovingAverage: () => {
    const current = get().dailyMovingAverages;
    if (current.length >= MA_SLOT_LIMIT) return;
    const last = current[current.length - 1];
    const period = last ? clamp(last.period * 2, MA_PERIOD_MIN, MA_PERIOD_MAX) : 20;
    const next: LiveMAConfig = {
      id: nextSlotId(current, 'dma'),
      enabled: true,
      period,
      color: nextSlotColor(current),
      lineWidth: 2,
      source: 'close',
    };
    set({ dailyMovingAverages: [...current, next] });
    persistIndicators(snapshotIndicators(get));
  },

  removeDailyMovingAverage: (id) => {
    const current = get().dailyMovingAverages;
    if (current.length <= 1) return;
    const nextArr = current.filter((m) => m.id !== id);
    if (nextArr.length === current.length) return;
    set({ dailyMovingAverages: nextArr });
    persistIndicators(snapshotIndicators(get));
  },

  setDailyMovingAverageEnabled: (enabled) => {
    set({ dailyMovingAverageEnabled: enabled });
    persistIndicators(snapshotIndicators(get));
  },

  setDailyMovingAverageHidden: (hidden) => {
    set({ dailyMovingAverageHidden: hidden });
    persistIndicators(snapshotIndicators(get));
  },

  projectActiveView: ({ instrument, code, timeframe, historicalFromDate }) => {
    // One atomic write — no reset-then-restore. tf is clamped like setCandleTimeframe
    // (belt-and-suspenders; tabs already carry validated timeframes).
    const tf = LIVE_TIMEFRAMES.includes(timeframe) ? timeframe : get().candleTimeframe;
    const nextInstrument = instrument === undefined
      ? (code ? stockInstrument(code) : null)
      : instrument;
    const next = {
      activeInstrument: nextInstrument,
      activeCode: instrument === undefined
        ? code
        : (instrument === null && code === '' ? '' : instrumentToActiveCode(nextInstrument)),
      candleTimeframe: tf,
      lastMinuteTimeframe: isMinuteTimeframe(tf) ? tf : get().lastMinuteTimeframe,
      historicalFromDate,
    };
    set(next);
    persist({ ...get(), ...next });
  },

  setActiveCode: (code) => {
    const activeInstrument = code ? stockInstrument(code) : null;
    set({ activeInstrument, activeCode: code, historicalFromDate: null });
    persist({ ...get(), activeInstrument, activeCode: code, historicalFromDate: null });
  },

  setCandleTimeframe: (tf) => {
    if (!LIVE_TIMEFRAMES.includes(tf)) return;
    const next = {
      candleTimeframe: tf,
      lastMinuteTimeframe: isMinuteTimeframe(tf) ? tf : get().lastMinuteTimeframe,
      historicalFromDate: null,
    };
    set(next);
    persist({ ...get(), ...next });
  },

  extendHistoricalRange: (date) => {
    const cur = get().historicalFromDate;
    if (cur !== null && cur <= date) return; // already at or before this date
    set({ historicalFromDate: date });
    persist({ ...get(), historicalFromDate: date });
  },

  resetHistoricalRange: () => {
    set({ historicalFromDate: null });
    persist({ ...get(), historicalFromDate: null });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    const merged = { ...DEFAULTS, ...stored };
    const lastMinuteTimeframe = stored.lastMinuteTimeframe
      ?? (isMinuteTimeframe(merged.candleTimeframe) ? merged.candleTimeframe : DEFAULTS.lastMinuteTimeframe);
    set({ ...merged, lastMinuteTimeframe });
  },
}));
