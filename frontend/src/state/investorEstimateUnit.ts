import { create } from 'zustand';

/**
 * **투자자 두 창**의 표시 단위 — 수량(주) / 금액(억원).
 *
 * 처음엔 잠정투자자 창 전용이었고, 「일별 투자자」 창(#1675)이 같은 토글을 갖게
 * 되면서 둘이 공유한다. 나누지 않은 이유가 아래 도크스트링 그대로다 — 두 창이
 * 나란히 뜬 채 단위가 서로 다르면 비교 자체가 불가능해진다. 표시 단위도 같다
 * (`formatAmount` 가 백만원·억원을 모두 「N억」으로 접는다).
 *
 * ⚠ **두 창이 축을 얻는 방식은 다르다.** 잠정투자자는 한 응답에 두 축이 함께 와서
 * 토글이 서버 왕복 없이 끝나지만, 일별 투자자는 `ka10059` 가 축마다 별개 콜이라
 * 토글이 재요청을 낸다. 그래서 그쪽은 **응답의 `unit`** 으로 포맷터를 고른다 —
 * 이 스토어 값으로 고르면 전환 프레임에 옛 축의 값을 새 단위로 그린다.
 *
 * **창별이 아니라 전역이다.** 지표 설정은 창마다 다른 것을 보려고 띄우므로 창
 * 스코프가 맞지만(#781), 단위는 그런 성질이 아니다. 같은 종목을 두 창에 띄웠는데
 * 단위가 서로 다르면 나란히 놓고 비교하는 일 자체가 불가능해진다.
 *
 * **잠정투자자에서는** 축 전환에 서버 왕복이 없다 — 백엔드가 수량·금액을 한 응답에
 * 함께 싣는다(`LiveInvestorTrendEstimateRow`). 요청마다 축을 갈아 끼우면 관측시각
 * 저장소가 값 변화를 새 관측으로 읽어 차수 시각이 무너지기 때문이다. 일별 투자자는
 * 그 제약이 없어 반대로 골랐다(위 ⚠) — **이 문단은 두 창에 일반화되지 않는다.**
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

/**
 * 다른 탭의 단위 선택을 이 탭에 반영한다 — 단위는 **탭 전역**이다.
 *
 * 위 도크스트링의 논거("단위가 서로 다르면 나란히 놓고 비교하는 일 자체가 불가능")는
 * 창뿐 아니라 **탭에도 그대로 성립한다** — `/live` 딥링크가 새 탭을 여는 구조라
 * (`live/liveNavigate.ts`) 낡은 탭은 예외가 아니라 평상 상태다. 이 배선이 없던 동안
 * `hydrateFromStorage` 는 정의만 되고 아무도 부르지 않아, 저장은 공유(localStorage)인데
 * 읽는 시점이 모듈 로드 한 번뿐이었다 — 먼저 띄워 둔 탭만 옛 단위로 남았다.
 * `state/liveVenue.ts` 가 거래소에서 고친 것과 **같은 기전**이다(2026-08-07).
 *
 * 트레이드오프는 명시적으로 받아들인 것이다: 탭을 나눠 주(수량)와 억(금액)을 나란히
 * 비교하는 사용법은 이제 불가능하다. 대신 헤더 칩으로 한 창 안에서 전환한다.
 *
 * 에코 루프 없음 — `storage` 이벤트는 쓴 탭에서 발생하지 않고 `hydrateFromStorage` 는
 * 읽기만 한다. `event.newValue` 대신 저장소를 다시 읽어 초기화와 같은 검증(`isUnit`)을
 * 태우므로, 손으로 편집된 값이 store 로 새지 않는다.
 *
 * Returns an unsubscribe function (useEffect cleanup shape).
 */
export function subscribeToInvestorEstimateUnitStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    useInvestorEstimateUnitStore.getState().hydrateFromStorage();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
