import { create } from 'zustand';

/**
 * Source Preference (ADR-0039) — global per-user setting that drives the
 * source selection on `/api/range` requests.
 *
 * Default: 'hogaplay' (the higher-resolution capture source). Falls back
 * automatically when the preferred source is missing — see backend
 * `build_range_bundle(source_pref=...)` and ADR-0039 semantics.
 */
export const SOURCE_OPTIONS = ['hogaplay', 'kis_live'] as const;
export type SourcePreference = (typeof SOURCE_OPTIONS)[number];

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
    if (SOURCE_OPTIONS.includes(parsed.sourcePreference as SourcePreference)) {
      return { sourcePreference: parsed.sourcePreference as SourcePreference };
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

export const useSourcePreferenceStore = create<Store>((set, get) => ({
  sourcePreference: readStorage()?.sourcePreference ?? 'hogaplay',

  setSourcePreference: (value) => {
    if (!SOURCE_OPTIONS.includes(value)) return;
    set({ sourcePreference: value });
    persist({ sourcePreference: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ sourcePreference: stored.sourcePreference });
  },
}));
