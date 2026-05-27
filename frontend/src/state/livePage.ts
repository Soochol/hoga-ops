import { create } from 'zustand';

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
};

type Store = Persisted & {
  setActiveCode: (code: string | null) => void;
  setCandleTimeframe: (tf: LiveTimeframe) => void;
  toggleWatchlistPanel: () => void;
  setWatchlistPanelOpen: (open: boolean) => void;
  hydrateFromStorage: () => void;
};

const DEFAULTS: Persisted = {
  activeCode: null,
  candleTimeframe: '1m',
  watchlistPanelOpen: false,
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
    set({ activeCode: code });
    persist({ ...get(), activeCode: code });
  },

  setCandleTimeframe: (tf) => {
    if (!LIVE_TIMEFRAMES.includes(tf)) return;
    set({ candleTimeframe: tf });
    persist({ ...get(), candleTimeframe: tf });
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
