import { create } from 'zustand';

export const LIVE_VENUE_OPTIONS = ['KRX', 'NXT', 'UN', 'AUTO'] as const;
export type LiveVenueOption = (typeof LIVE_VENUE_OPTIONS)[number];

export const LIVE_VENUE_LABELS: Record<LiveVenueOption, string> = {
  KRX: 'KRX',
  NXT: 'NXT',
  UN: '통합',
  AUTO: '자동',
};

const STORAGE_KEY = 'live.venue.v1';

interface Store {
  venue: LiveVenueOption;
  setVenue: (value: LiveVenueOption) => void;
  hydrateFromStorage: () => void;
}

function isLiveVenueOption(value: unknown): value is LiveVenueOption {
  return typeof value === 'string' && LIVE_VENUE_OPTIONS.includes(value as LiveVenueOption);
}

function readStorage(): { venue: LiveVenueOption } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { venue?: unknown };
    return isLiveVenueOption(parsed.venue) ? { venue: parsed.venue } : null;
  } catch {
    return null;
  }
}

function persist(state: { venue: LiveVenueOption }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useLiveVenueStore = create<Store>((set) => ({
  venue: readStorage()?.venue ?? 'KRX',

  setVenue: (value) => {
    if (!isLiveVenueOption(value)) return;
    set({ venue: value });
    persist({ venue: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ venue: stored.venue });
  },
}));
