import { create } from 'zustand';
import { MINUTE_TIMEFRAMES, type MinuteTimeframe } from './livePage';

const STORAGE_KEY = 'studyView.openPrefs.v1';
export type StudyViewOpenTimeframe = 'saved' | MinuteTimeframe;

interface Store {
  defaultTimeframe: StudyViewOpenTimeframe;
  setDefaultTimeframe: (value: StudyViewOpenTimeframe) => void;
  hydrateFromStorage: () => void;
}

function isStudyViewOpenTimeframe(value: unknown): value is StudyViewOpenTimeframe {
  return value === 'saved' || (typeof value === 'string' && MINUTE_TIMEFRAMES.includes(value as MinuteTimeframe));
}

function readStorage(): { defaultTimeframe: StudyViewOpenTimeframe } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { defaultTimeframe?: unknown };
    return isStudyViewOpenTimeframe(parsed.defaultTimeframe)
      ? { defaultTimeframe: parsed.defaultTimeframe }
      : null;
  } catch {
    return null;
  }
}

function persist(state: { defaultTimeframe: StudyViewOpenTimeframe }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable.
  }
}

export const useStudyViewOpenPrefsStore = create<Store>((set) => ({
  defaultTimeframe: readStorage()?.defaultTimeframe ?? '3m',

  setDefaultTimeframe: (value) => {
    if (!isStudyViewOpenTimeframe(value)) return;
    set({ defaultTimeframe: value });
    persist({ defaultTimeframe: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ defaultTimeframe: stored.defaultTimeframe });
  },
}));
