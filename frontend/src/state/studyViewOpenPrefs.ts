import { create } from 'zustand';
import { MINUTE_TIMEFRAMES, type MinuteTimeframe } from './livePage';

const STORAGE_KEY = 'studyView.openPrefs.v1';
// 'current' = study 차트에서 마지막으로 설정한 분봉(useStudyLastMinuteTimeframeStore)으로 연다.
// 그 외는 고정 분봉. (구 센티넬 'saved'=저장뷰 자체 분봉은 폐지 — 아래에서 'current'로 마이그레이션)
export type StudyViewOpenTimeframe = 'current' | MinuteTimeframe;

interface Store {
  defaultTimeframe: StudyViewOpenTimeframe;
  setDefaultTimeframe: (value: StudyViewOpenTimeframe) => void;
  hydrateFromStorage: () => void;
}

function isStudyViewOpenTimeframe(value: unknown): value is StudyViewOpenTimeframe {
  return value === 'current' || (typeof value === 'string' && MINUTE_TIMEFRAMES.includes(value as MinuteTimeframe));
}

function normalizeStored(value: unknown): StudyViewOpenTimeframe | null {
  // 구 센티넬 'saved'(저장된 분봉)를 'current'(설정된 분봉)로 승격한다.
  if (value === 'saved') return 'current';
  return isStudyViewOpenTimeframe(value) ? value : null;
}

function readStorage(): { defaultTimeframe: StudyViewOpenTimeframe } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { defaultTimeframe?: unknown };
    const normalized = normalizeStored(parsed.defaultTimeframe);
    return normalized ? { defaultTimeframe: normalized } : null;
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
  defaultTimeframe: readStorage()?.defaultTimeframe ?? 'current',

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
