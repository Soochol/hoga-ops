import { create } from 'zustand';

import { INVESTOR_DAILY_SPANS, type InvestorDailySpan } from '../live/investorDailyRows';

/**
 * 일별 투자자 창의 표시 기간(거래일 수).
 *
 * **창별이 아니라 전역이다** — `investorEstimateUnit` 과 같은 논거다: 같은 종목을
 * 두 창에 띄웠는데 기간이 서로 다르면 나란히 놓고 비교하는 일 자체가 불가능해진다.
 *
 * 고정 기간은 최근 응답을 클라이언트에서 자른다. 전체(0)는 창별 과거 조회를
 * 허용하되, 조회한 깊이는 저장하지 않는다.
 */
const STORAGE_KEY = 'live.investorDailySpan.v1';

interface Store {
  span: InvestorDailySpan;
  setSpan: (value: InvestorDailySpan) => void;
  hydrateFromStorage: () => void;
}

function isSpan(value: unknown): value is InvestorDailySpan {
  return typeof value === 'number'
    && (INVESTOR_DAILY_SPANS as readonly number[]).includes(value);
}

function readStorage(): InvestorDailySpan | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { span?: unknown };
    return isSpan(parsed.span) ? parsed.span : null;
  } catch {
    return null;
  }
}

function persist(span: InvestorDailySpan): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ span }));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useInvestorDailySpanStore = create<Store>((set) => ({
  span: readStorage() ?? 0,

  setSpan: (value) => {
    if (!isSpan(value)) return;
    set({ span: value });
    persist(value);
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored !== null) set({ span: stored });
  },
}));

/** 다른 탭의 기간 선택을 이 탭에 반영한다 — `subscribeToInvestorEstimateUnitStorage`
 *  와 같은 기전이고 같은 이유다(`/live` 딥링크가 새 탭을 여는 구조라 낡은 탭이
 *  예외가 아니라 평상 상태다). Returns an unsubscribe function. */
export function subscribeToInvestorDailySpanStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    useInvestorDailySpanStore.getState().hydrateFromStorage();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
