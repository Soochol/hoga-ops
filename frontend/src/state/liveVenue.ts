import { create } from 'zustand';

// NXT 단독 venue는 제거(#523) — 통합(UN)이 상위호환(정규장 KRX 실시간 + NXT 시간대
// NXT 실시간, #524 시분할). 저장된 'NXT' 선택은 읽을 때 'UN'으로 마이그레이션한다.
export const LIVE_VENUE_OPTIONS = ['KRX', 'UN'] as const;
export type LiveVenueOption = (typeof LIVE_VENUE_OPTIONS)[number];

export const LIVE_VENUE_LABELS: Record<LiveVenueOption, string> = {
  KRX: 'KRX',
  UN: '통합',
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
