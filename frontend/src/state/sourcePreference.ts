import { create } from 'zustand';
import {
  SOURCE_PREFERENCE_OPTIONS,
  type SourcePreference,
} from '../api/sourceCapabilities';

/**
 * Orderflow Source Preference (ADR-0039) — global per-user setting that drives
 * source selection for hoga/orderbook/trade-derived read paths such as
 * `/api/range`, `/api/orderbook`, and `/api/brokers/series`.
 *
 * Storage key stays `chart.sourcePreference.v1` for backward compatibility.
 */
export { SOURCE_PREFERENCE_OPTIONS as SOURCE_OPTIONS, type SourcePreference };

const STORAGE_KEY = 'chart.sourcePreference.v1';

interface Store {
  sourcePreference: SourcePreference;
  setSourcePreference: (value: SourcePreference) => void;
  hydrateFromStorage: () => void;
}

function readStorage(): { sourcePreference: SourcePreference } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sourcePreference: string };
    const legacy: Record<string, SourcePreference> = {
      hogaplay: 'hogaplay_first',
      kis_live: 'kis_ws_first',
    };
    const value = legacy[parsed.sourcePreference] ?? parsed.sourcePreference;
    if (SOURCE_PREFERENCE_OPTIONS.includes(value as SourcePreference)) {
      return { sourcePreference: value as SourcePreference };
    }
    return null;
  } catch {
    return null;
  }
}

function persist(state: { sourcePreference: SourcePreference }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useSourcePreferenceStore = create<Store>((set, _get) => ({
  sourcePreference: readStorage()?.sourcePreference ?? 'hogaplay_first',

  setSourcePreference: (value) => {
    if (!SOURCE_PREFERENCE_OPTIONS.includes(value)) return;
    set({ sourcePreference: value });
    persist({ sourcePreference: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ sourcePreference: stored.sourcePreference });
  },
}));
