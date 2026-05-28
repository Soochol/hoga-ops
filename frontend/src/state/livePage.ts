import { create } from 'zustand';
import type { MASource } from '../chart/projectors/movingAverage';
export type { MASource };

/** /live의 이동평균선 한 슬롯. 가변 슬롯이므로 array index가 아니라
 *  안정 id로 식별한다 — mid-list 삭제가 다른 슬롯의 series identity를
 *  churn하지 않게 한다. ADR-0046 참조. */
export type LiveMAConfig = {
  id: string;
  enabled: boolean;
  period: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  source: MASource;
};

export const MA_PERIOD_MIN = 2;
export const MA_PERIOD_MAX = 400;
export const MA_SLOT_LIMIT = 8;

/** 색상 hex는 tokens.css의 --ma-N과 정확히 일치 (canvas는 CSS var를
 *  직접 받지 못함). --ma-2 (#3B82F6, blue)는 KRX --price-down (#2563EB,
 *  blue)과 색역이 가까워 기본 슬롯에서 의도적으로 스킵. spec §1 참조. */
export const DEFAULT_LIVE_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'ma-1', enabled: true, period: 5,   color: '#EC4899', lineWidth: 1, source: 'close' },
  { id: 'ma-2', enabled: true, period: 20,  color: '#F97316', lineWidth: 1, source: 'close' },
  { id: 'ma-3', enabled: true, period: 60,  color: '#22C55E', lineWidth: 1, source: 'close' },
  { id: 'ma-4', enabled: true, period: 120, color: '#F8FAFC', lineWidth: 1, source: 'close' },
]) as readonly LiveMAConfig[];

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

type Persisted = {
  activeCode: string | null;
  candleTimeframe: LiveTimeframe;
  watchlistPanelOpen: boolean;
  /** Earliest stock-date the user has scrolled into (YYYYMMDD). null = today
   * only (no /api/range call needed yet). Resets when activeCode or timeframe
   * changes. */
  historicalFromDate: string | null;
};

type Store = Persisted & {
  setActiveCode: (code: string | null) => void;
  setCandleTimeframe: (tf: LiveTimeframe) => void;
  toggleWatchlistPanel: () => void;
  setWatchlistPanelOpen: (open: boolean) => void;
  extendHistoricalRange: (date: string) => void;
  resetHistoricalRange: () => void;
  hydrateFromStorage: () => void;
};

const DEFAULTS: Persisted = {
  activeCode: null,
  candleTimeframe: '1m',
  watchlistPanelOpen: false,
  historicalFromDate: null,
};

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (SSR, privacy mode) — silent fallback.
  }
}

function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export const useLivePageStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...readStorage(),

  setActiveCode: (code) => {
    set({ activeCode: code, historicalFromDate: null });
    persist({ ...get(), activeCode: code, historicalFromDate: null });
  },

  setCandleTimeframe: (tf) => {
    if (!LIVE_TIMEFRAMES.includes(tf)) return;
    set({ candleTimeframe: tf, historicalFromDate: null });
    persist({ ...get(), candleTimeframe: tf, historicalFromDate: null });
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

  toggleWatchlistPanel: () => {
    const next = !get().watchlistPanelOpen;
    set({ watchlistPanelOpen: next });
    persist({ ...get(), watchlistPanelOpen: next });
  },

  setWatchlistPanelOpen: (open) => {
    set({ watchlistPanelOpen: open });
    persist({ ...get(), watchlistPanelOpen: open });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    set({ ...DEFAULTS, ...stored });
  },
}));
