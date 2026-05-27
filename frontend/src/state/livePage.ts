import { create } from 'zustand';

/** Timeframes the live page supports. D/W are intra-stage placeholders —
 * Addendum 9.4 specifies indicator panes render empty for D/W. */
export const LIVE_TIMEFRAMES = ['1m', '3m', '5m', '10m', '15m', '30m', 'D', 'W'] as const;
export type LiveTimeframe = (typeof LIVE_TIMEFRAMES)[number];

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
