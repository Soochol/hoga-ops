import { create } from 'zustand';

/**
 * 잠정투자자 창의 표시 단위 — 수량(주) / 금액(억원).
 *
 * **창별이 아니라 전역이다.** 지표 설정은 창마다 다른 것을 보려고 띄우므로 창
 * 스코프가 맞지만(#781), 단위는 그런 성질이 아니다. 같은 종목을 두 창에 띄웠는데
 * 단위가 서로 다르면 나란히 놓고 비교하는 일 자체가 불가능해진다.
 *
 * 축 전환은 **서버 왕복이 없다** — 백엔드가 수량·금액을 한 응답에 함께 싣는다
 * (`LiveInvestorTrendEstimateRow`). 요청마다 축을 갈아 끼우면 관측시각 저장소가
 * 값 변화를 새 관측으로 읽어 차수 시각이 무너지기 때문이다.
 */
export const INVESTOR_ESTIMATE_UNITS = ['qty', 'amount'] as const;
export type InvestorEstimateUnit = (typeof INVESTOR_ESTIMATE_UNITS)[number];

/** 헤더 칩에 찍히는 글자. 한 글자인 것은 좁은 창에서도 줄이지 않기 위해서다. */
export const INVESTOR_ESTIMATE_UNIT_LABELS: Record<InvestorEstimateUnit, string> = {
  qty: '주',
  amount: '억',
};

const STORAGE_KEY = 'live.investorEstimateUnit.v1';

interface Store {
  unit: InvestorEstimateUnit;
  setUnit: (value: InvestorEstimateUnit) => void;
  toggleUnit: () => void;
  hydrateFromStorage: () => void;
}

function isUnit(value: unknown): value is InvestorEstimateUnit {
  return typeof value === 'string' && INVESTOR_ESTIMATE_UNITS.includes(value as InvestorEstimateUnit);
}

function readStorage(): InvestorEstimateUnit | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { unit?: unknown };
    return isUnit(parsed.unit) ? parsed.unit : null;
  } catch {
    return null;
  }
}

function persist(unit: InvestorEstimateUnit): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ unit }));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useInvestorEstimateUnitStore = create<Store>((set, get) => ({
  unit: readStorage() ?? 'qty',

  setUnit: (value) => {
    if (!isUnit(value)) return;
    set({ unit: value });
    persist(value);
  },

  toggleUnit: () => {
    const next: InvestorEstimateUnit = get().unit === 'qty' ? 'amount' : 'qty';
    set({ unit: next });
    persist(next);
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ unit: stored });
  },
}));
