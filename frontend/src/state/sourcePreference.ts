import { create } from 'zustand';
import {
  SOURCE_PREFERENCE_OPTIONS,
  type SourcePreference,
} from '../api/sourceCapabilities';

/**
 * Source Preference (ADR-0039) — global per-user setting that drives the
 * source selection on `/api/range` requests.
 *
 * Default: 'hogaplay_first' (the higher-resolution capture source). Falls back
 * according to display priority when the preferred source is missing — see backend
 * `build_range_bundle(source_pref=...)` and ADR-0039 semantics.
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
