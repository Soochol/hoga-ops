import { create } from 'zustand';

import { INVESTOR_DAILY_SPANS, type InvestorDailySpan } from '../live/investorDailyRows';

/**
 * 일별 투자자 창의 표시 기간(거래일 수).
 *
 * **창별이 아니라 전역이다** — `investorEstimateUnit` 과 같은 논거다: 같은 종목을
 * 두 창에 띄웠는데 기간이 서로 다르면 나란히 놓고 비교하는 일 자체가 불가능해진다.
 *
 * 기간 전환은 **서버 왕복이 없다.** 창이 요청하는 달력 구간은 기간과 무관하게
 * 고정이고(가장 긴 기간을 덮는 값), 자르기는 `buildInvestorDailyTable` 이 클라에서
 * 한다. 기간마다 다른 `from` 을 보내면 react-query 키가 갈려 칩을 누를 때마다
 * 새 요청이 나가는데, 벤더 페이지가 100행(≈5개월)이라 그 재요청은 전부 낭비다.
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
  span: readStorage() ?? 20,

  setSpan: (value) => {
    if (!isSpan(value)) return;
    set({ span: value });
    persist(value);
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ span: stored });
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
