import { create } from 'zustand';

// NXT 단독 venue는 제거(#523) — 'UN'이 상위호환(정규장 KRX 실시간 + NXT 시간대
// NXT 실시간, #524 시분할). 저장된 'NXT' 선택은 읽을 때 'UN'으로 마이그레이션한다.
export const LIVE_VENUE_OPTIONS = ['KRX', 'UN'] as const;
export type LiveVenueOption = (typeof LIVE_VENUE_OPTIONS)[number];

// 라벨은 **시분할**을 말한다 — 'UN'은 KRX·NXT 호가를 합치지 않는다. 백엔드
// target_ws_venue()가 벽시계로 한 시장만 고른다(08:50–15:31 KRX, 그 밖 NXT)므로
// 시점당 도착하는 시장은 항상 하나다. 옛 라벨 '통합'은 가격대 잔량을 합산한 병합
// 뷰(ADR-0118 §4, 미구현)를 약속하는 것처럼 읽혀 오해를 샀다 — 저장 키('UN')는
// 내부 식별자라 그대로 두고 표시 문구만 바꾼다(마이그레이션 불요).
export const LIVE_VENUE_LABELS: Record<LiveVenueOption, string> = {
  KRX: 'KRX',
  UN: '시간대 자동',
};

const STORAGE_KEY = 'live.venue.v1';

interface Store {
  venue: LiveVenueOption;
  setVenue: (value: LiveVenueOption) => void;
  hydrateFromStorage: () => void;
}

function isLiveVenueOption(value: unknown): value is LiveVenueOption {
  return typeof value === 'string' && LIVE_VENUE_OPTIONS.includes(value as LiveVenueOption);
}

/** 저장된 venue 문자열 → 유효 옵션. 제거된 'NXT'는 'UN'으로 이행(#523);
 *  그 외 미지값은 null(호출부가 기본 'KRX'로 폴백). */
function migrateStoredVenue(value: unknown): LiveVenueOption | null {
  if (value === 'NXT') return 'UN';
  return isLiveVenueOption(value) ? value : null;
}

function readStorage(): { venue: LiveVenueOption } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { venue?: unknown };
    const migrated = migrateStoredVenue(parsed.venue);
    return migrated ? { venue: migrated } : null;
  } catch {
    return null;
  }
}

function persist(state: { venue: LiveVenueOption }): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable — silent fallback.
  }
}

export const useLiveVenueStore = create<Store>((set) => ({
  venue: readStorage()?.venue ?? 'KRX',

  setVenue: (value) => {
    if (!isLiveVenueOption(value)) return;
    set({ venue: value });
    persist({ venue: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ venue: stored.venue });
  },
}));
