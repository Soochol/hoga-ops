import { create } from 'zustand';

// 거래소 3옵션 (ADR-0140 §5). NXT 가 **단독 옵션으로 돌아왔다** — #523 이 지웠던
// 이유(시분할이라 NXT 단독은 정규장에 빈 화면)가 PR-F 의 동시 구독으로 사라졌다.
export const LIVE_VENUE_OPTIONS = ['KRX', 'NXT', 'UN'] as const;
export type LiveVenueOption = (typeof LIVE_VENUE_OPTIONS)[number];

// 'UN' 은 이제 **진짜 통합**이다 — 키움 `_AL` 직결이라 거래소가 이미 병합한 호가를
// 그대로 받는다(합성이 아니다). 실측 2026-08-03: `005930_AL` 거래량 45,739,907 ≈
// KRX 27,393,575 + NXT 18,346,108.
//
// 옛 라벨 '시간대 자동'은 시분할을 가리키던 말이라 함께 사라진다. 그때 '통합'을
// 피했던 것은 합치지 않으면서 합친다고 말하지 않기 위해서였는데, 이제 정말 합친다.
export const LIVE_VENUE_LABELS: Record<LiveVenueOption, string> = {
  KRX: 'KRX',
  NXT: 'NXT',
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

/** 저장된 venue 문자열 → 유효 옵션. 미지값은 null(호출부가 기본 'KRX'로 폴백).
 *
 * ⚠ 여기 있던 `'NXT' → 'UN'` 이행 규칙을 **제거했다**(ADR-0140 §5). #523 이 NXT 를
 * 유효 옵션에서 빼면서 넣은 것인데, NXT 가 돌아온 지금은 정반대로 작동한다 —
 * 사용자가 NXT 를 골라도 다음 로드에 조용히 UN 으로 되돌아간다. 되돌아간 화면은
 * 데이터가 나오므로(통합은 NXT 를 포함한다) **고장으로 보이지도 않는다**. */
function migrateStoredVenue(value: unknown): LiveVenueOption | null {
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
