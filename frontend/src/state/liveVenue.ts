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

/**
 * 거래소 3옵션이 무엇인지 설명하는 한 문단 — **진입점이 둘이라 여기서만 정한다**.
 * 설정 모달의 「거래소」 그룹(`DataSourceDetail`, /live·/study 공용)과 /live 툴바의
 * 거래소 선택기 팝오버(`LiveVenuePicker`)가 같은 문자열을 쓴다. 복제해 두면 한쪽만
 * 고쳐져 같은 개념이 화면마다 다르게 설명된다.
 *
 * /study 는 이 문단 대신 hogaplay 캡처 공백을 덧붙인 자기 문구를 쓴다 —
 * 복기 데이터에는 KRX 전용 캡처가 섞여 있어 설명해야 할 것이 하나 더 있다.
 */
export const LIVE_VENUE_HELP =
  'KRX는 정규장(09:00–15:30), NXT는 프리·애프터마켓을 포함한 08:00–20:00을 봅니다. '
  + '통합은 거래소가 병합해 내보내는 단일 호가라, 두 시장을 화면에서 더한 것이 아닙니다. '
  // 탭 전역이라는 사실을 여기서 알린다 — 탭마다 다를 것으로 기대하고 두 탭을
  // 띄운 사용자는, 알리지 않으면 한쪽이 "저절로 바뀌었다"고 읽는다.
  + '선택은 열려 있는 모든 탭에 함께 적용됩니다.';

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

/**
 * 다른 탭의 거래소 선택을 이 탭에 반영한다 — 거래소는 **탭 전역**이다
 * (2026-08-07 사용자 결정). 이전에는 저장은 공유(localStorage)인데 읽는 시점이
 * 모듈 로드 한 번뿐이라, 먼저 띄워 둔 탭만 옛 거래소로 남았다.
 *
 * 트레이드오프는 명시적으로 받아들인 것이다: 탭을 나눠 KRX 와 NXT 를 나란히
 * 비교하는 사용법은 이제 불가능하다(한 탭에서 바꾸면 전부 따라온다). 대신 툴바
 * 선택기(#1179)로 한 탭 안에서 전환한다.
 *
 * 테마 선호(`state/themePrefs.ts`)와 같은 모양이다 — 에코 루프 없음(`storage` 는
 * 쓴 탭에서 발생하지 않고 `hydrateFromStorage` 는 읽기만 한다), `event.newValue`
 * 대신 저장소를 다시 읽어 초기화와 같은 검증(`migrateStoredVenue`)을 태운다.
 *
 * Returns an unsubscribe function (useEffect cleanup shape).
 */
export function subscribeToLiveVenueStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    useLiveVenueStore.getState().hydrateFromStorage();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
