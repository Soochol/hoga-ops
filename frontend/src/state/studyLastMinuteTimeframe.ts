import { create } from 'zustand';
import { MINUTE_TIMEFRAMES, type MinuteTimeframe } from './livePage';

// /study 차트에서 마지막으로 설정한 "분봉" 하나를 전역 persist한다. 저장뷰를
// "설정된 분봉"으로 열 때(studyViewOpenPrefs='current') 이 값을 override로 쓴다.
// /live의 lastMinuteTimeframe(live.page.v1)과 같은 역할이지만 라우트가 다르므로 별도 키.
// 분봉을 한 번도 안 쓴 초기 상태 폴백은 이 기본값('3m')이 그대로 담당한다.
const STORAGE_KEY = 'study.lastMinuteTimeframe.v1';
const DEFAULT_MINUTE_TIMEFRAME: MinuteTimeframe = '3m';

interface Store {
  lastMinuteTimeframe: MinuteTimeframe;
  setLastMinuteTimeframe: (value: MinuteTimeframe) => void;
  hydrateFromStorage: () => void;
}

function isMinuteTimeframe(value: unknown): value is MinuteTimeframe {
  return typeof value === 'string' && MINUTE_TIMEFRAMES.includes(value as MinuteTimeframe);
}

function readStorage(): MinuteTimeframe | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lastMinuteTimeframe?: unknown };
    return isMinuteTimeframe(parsed.lastMinuteTimeframe) ? parsed.lastMinuteTimeframe : null;
  } catch {
    return null;
  }
}

function persist(value: MinuteTimeframe): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ lastMinuteTimeframe: value }));
  } catch {
    // localStorage may be unavailable.
  }
}

export const useStudyLastMinuteTimeframeStore = create<Store>((set) => ({
  lastMinuteTimeframe: readStorage() ?? DEFAULT_MINUTE_TIMEFRAME,

  setLastMinuteTimeframe: (value) => {
    if (!isMinuteTimeframe(value)) return;
    set({ lastMinuteTimeframe: value });
    persist(value);
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ lastMinuteTimeframe: stored });
  },
}));
