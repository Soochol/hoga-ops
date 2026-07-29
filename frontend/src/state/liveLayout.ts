import { create } from 'zustand';
import { normalizeKeyOrder } from './keyOrder';
import { persistJson, readJsonObject } from './persist';

export const LIVE_LAYOUT_STORAGE_KEY = 'live.layout.v1';
/** 활성 프리셋 id 전용 **탭 스코프** 키(sessionStorage).
 *
 *  `live.layout.v1` 에 함께 두면, 탭1 의 무관한 조작(상세 패널 접기 등)이 전체 스냅샷을
 *  쓰면서 탭2 의 활성 프리셋을 되돌린다. 그 뒤 탭2 에서 "현재 워크스페이스 저장"을
 *  누르면 **엉뚱한 프리셋**을 덮어쓴다 — 그 프리셋 자체는 변경된 적이 없으므로
 *  updated_at_ms 충돌 감지에도 걸리지 않는 경로다. 워크스페이스가 탭마다 독립이므로
 *  (workspace.ts 스코프 주석) "이 탭이 마지막에 적용한 프리셋" 도 탭의 것이다. */
export const LIVE_ACTIVE_PRESET_STORAGE_KEY = 'live.activePreset.v1';
export const DEFAULT_RIGHT_PANEL_WIDTH_PX = 400;

export type LiveCardKey = 'orderbook' | 'volumeDistribution' | 'program' | 'brokers' | 'investor';
export type LiveCardWeights = Record<LiveCardKey, number>;

/** 카드의 canonical 순서 = 렌더 순서(LiveDetailPanel 의 `CARD_META` 순서와 일치).
 *  `DEFAULT_CARD_WEIGHTS` 키 순서와 다르다(그쪽은 weights 사전이라 순서 무의미). 이
 *  배열이 `rightCardOrder` 정규화의 기준이자 저장값 없을 때의 기본 순서다. */
export const LIVE_CARD_KEYS: readonly LiveCardKey[] = [
  'orderbook',
  'brokers',
  'volumeDistribution',
  'program',
  'investor',
];

export const DEFAULT_CARD_WEIGHTS: LiveCardWeights = {
  orderbook: 34,
  volumeDistribution: 18,
  program: 12,
  brokers: 22,
  investor: 14,
};

type Persisted = {
  rightPanelWidthPx: number;
  /** 접기·리사이저 제거(2026-07-15) 후 UI 는 사용하지 않지만 레이아웃 프리셋이
   *  캡처/적용하므로 하위호환·프리셋 계약을 위해 유지한다(retained-for-migration). */
  rightCardWeights: LiveCardWeights;
  /** 사용자 소유 카드 순서(안정 키 배열; 인덱스 아님, ADR-0114). */
  rightCardOrder: LiveCardKey[];
  /** 키 부재 = 표시. 숨김은 복구 시 이전 상태. */
  rightCardHidden: Partial<Record<LiveCardKey, boolean>>;
  /** 접기 제거 후 UI 미사용. 프리셋 캡처/적용용으로만 유지(retained-for-migration). */
  rightCardCollapsed: Partial<Record<LiveCardKey, boolean>>;
  /** 상세 패널 전체 접힘 여부(사용자 선호; 지수 종목 여부와 독립). */
  detailPanelCollapsed: boolean;
  /** 마지막으로 적용한 레이아웃 프리셋 id(클라 전용, ADR-0114 §4). 이후 수동 조정에도
   *  유지 — "마지막 적용" 의미이지 "동기화됨"이 아니다. null = 프리셋 미적용. */
  lastAppliedPresetId: string | null;
};

/** 프리셋 적용용 우측 패널 배치 묶음(단일 set + 단일 persist). lastAppliedPresetId 도
 *  함께 넘겨 두 번 쓰지 않는다(코드 리뷰). */
export type LiveLayoutPresetInput = {
  rightPanelWidthPx: number;
  rightCardOrder: LiveCardKey[];
  rightCardHidden: Partial<Record<LiveCardKey, boolean>>;
  rightCardCollapsed: Partial<Record<LiveCardKey, boolean>>;
  rightCardWeights: LiveCardWeights;
  lastAppliedPresetId: string | null;
};

type Store = Persisted & {
  setRightPanelWidthPx: (widthPx: number) => void;
  setRightCardOrder: (order: LiveCardKey[]) => void;
  setCardHidden: (key: LiveCardKey, hidden: boolean) => void;
  setDetailPanelCollapsed: (collapsed: boolean) => void;
  toggleDetailPanelCollapsed: () => void;
  applyLayoutPreset: (input: LiveLayoutPresetInput) => void;
  setLastAppliedPresetId: (id: string | null) => void;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isLiveCardKey(value: string): value is LiveCardKey {
  return value in DEFAULT_CARD_WEIGHTS;
}

function sanitizeRightPanelWidthPx(widthPx: unknown): number {
  return isPositiveFiniteNumber(widthPx) ? Math.round(widthPx) : DEFAULT_RIGHT_PANEL_WIDTH_PX;
}

function readPersistedCardWeights(value: unknown): LiveCardWeights | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<Record<LiveCardKey, unknown>>;
  const next: LiveCardWeights = { ...DEFAULT_CARD_WEIGHTS };
  for (const key of Object.keys(DEFAULT_CARD_WEIGHTS)) {
    if (!isLiveCardKey(key)) continue;
    const persisted = candidate[key];
    if (persisted === undefined && key === 'volumeDistribution') continue;
    if (!isPositiveFiniteNumber(persisted)) return null;
    next[key] = persisted;
  }

  return next;
}

function clampCardWeights(weights: Partial<LiveCardWeights>): LiveCardWeights {
  const next: LiveCardWeights = { ...DEFAULT_CARD_WEIGHTS };
  for (const key of Object.keys(DEFAULT_CARD_WEIGHTS)) {
    if (!isLiveCardKey(key)) continue;
    const value = weights[key];
    if (isPositiveFiniteNumber(value)) {
      next[key] = value;
    }
  }
  return next;
}

/** 접힘 맵은 엔트리별로 관대하게 검증한다(weights 의 all-or-nothing 검증과 달리,
 *  손상된 엔트리 하나가 전체 맵을 날리지 않도록 — 부울 맵엔 per-entry 가 항상 낫다). */
function readCollapsedMap(value: unknown): Partial<Record<LiveCardKey, boolean>> {
  const next: Partial<Record<LiveCardKey, boolean>> = {};
  if (!value || typeof value !== 'object') return next;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isLiveCardKey(key) && typeof raw === 'boolean') next[key] = raw;
  }
  return next;
}

function readStorage(): Partial<Persisted> {
  const parsed = readJsonObject(LIVE_LAYOUT_STORAGE_KEY);
  const next: Partial<Persisted> = {};

  if (isPositiveFiniteNumber(parsed.rightPanelWidthPx)) {
    next.rightPanelWidthPx = Math.round(parsed.rightPanelWidthPx);
  }

  const persistedWeights = readPersistedCardWeights(parsed.rightCardWeights);
  if (persistedWeights) {
    next.rightCardWeights = persistedWeights;
  }

  next.rightCardOrder = normalizeKeyOrder(parsed.rightCardOrder, LIVE_CARD_KEYS, isLiveCardKey);
  next.rightCardHidden = readCollapsedMap(parsed.rightCardHidden);
  next.rightCardCollapsed = readCollapsedMap(parsed.rightCardCollapsed);

  if (typeof parsed.detailPanelCollapsed === 'boolean') {
    next.detailPanelCollapsed = parsed.detailPanelCollapsed;
  }
  next.lastAppliedPresetId = readActivePresetId(parsed.lastAppliedPresetId);

  return next;
}

/** 활성 프리셋 id 하이드레이션 — 탭 키가 있으면 그것이 진실(명시적 null 포함:
 *  "기본으로 초기화" 한 탭이 새로고침으로 옛 프리셋을 되찾으면 안 된다). 탭 키가
 *  아예 없을 때만 공유 필드에서 폴백 시드한다 — 이 변경 전부터 쓰던 사용자의 활성
 *  프리셋이 첫 전환에서 사라지지 않게(별도 마이그레이션 코드 불요). */
function readActivePresetId(sharedValue: unknown): string | null {
  const own = readJsonObject(LIVE_ACTIVE_PRESET_STORAGE_KEY, 'tab');
  if ('lastAppliedPresetId' in own) {
    return typeof own.lastAppliedPresetId === 'string' ? own.lastAppliedPresetId : null;
  }
  return typeof sharedValue === 'string' ? sharedValue : null;
}

/** 활성 프리셋 id 만 탭 저장소에 기록한다. 공유 스냅샷(`persistFromState`)에도 계속
 *  실리지만 그쪽은 이제 새 탭 시드용 — 읽기는 위 `readActivePresetId` 가 탭 우선. */
function persistActivePresetId(id: string | null): void {
  persistJson(LIVE_ACTIVE_PRESET_STORAGE_KEY, { lastAppliedPresetId: id }, 'tab');
}

/** 모든 setter 가 공유하는 단일 영속화 지점 — 각 setter 가 payload 를 수동 조립하면
 *  새 필드를 빠뜨려 조용히 유실시킨다. 병합된 다음 state 를 통째로 넘기고 여기서 픽. */
function persistFromState(state: Persisted): void {
  persistJson(LIVE_LAYOUT_STORAGE_KEY, {
    rightPanelWidthPx: state.rightPanelWidthPx,
    rightCardWeights: state.rightCardWeights,
    rightCardOrder: state.rightCardOrder,
    rightCardHidden: state.rightCardHidden,
    rightCardCollapsed: state.rightCardCollapsed,
    detailPanelCollapsed: state.detailPanelCollapsed,
    lastAppliedPresetId: state.lastAppliedPresetId,
  });
}

const hydrated = readStorage();

export const useLiveLayoutStore = create<Store>((set) => ({
  rightPanelWidthPx: DEFAULT_RIGHT_PANEL_WIDTH_PX,
  rightCardWeights: DEFAULT_CARD_WEIGHTS,
  rightCardOrder: [...LIVE_CARD_KEYS],
  rightCardHidden: {},
  rightCardCollapsed: {},
  detailPanelCollapsed: false,
  lastAppliedPresetId: null,
  ...hydrated,
  setRightPanelWidthPx: (widthPx) => {
    const nextWidthPx = sanitizeRightPanelWidthPx(widthPx);
    set((state) => {
      persistFromState({ ...state, rightPanelWidthPx: nextWidthPx });
      return { rightPanelWidthPx: nextWidthPx };
    });
  },
  setRightCardOrder: (order) => {
    const nextOrder = normalizeKeyOrder(order, LIVE_CARD_KEYS, isLiveCardKey);
    set((state) => {
      persistFromState({ ...state, rightCardOrder: nextOrder });
      return { rightCardOrder: nextOrder };
    });
  },
  setCardHidden: (key, hidden) => {
    set((state) => {
      // 숨김은 weights/collapse 불변 — 복구 시 이전 비율·접힘 상태 그대로 복원.
      const nextHidden = { ...state.rightCardHidden, [key]: hidden };
      persistFromState({ ...state, rightCardHidden: nextHidden });
      return { rightCardHidden: nextHidden };
    });
  },
  setDetailPanelCollapsed: (collapsed) => {
    set((state) => {
      persistFromState({ ...state, detailPanelCollapsed: collapsed });
      return { detailPanelCollapsed: collapsed };
    });
  },
  toggleDetailPanelCollapsed: () => {
    set((state) => {
      const next = !state.detailPanelCollapsed;
      persistFromState({ ...state, detailPanelCollapsed: next });
      return { detailPanelCollapsed: next };
    });
  },
  applyLayoutPreset: (input) => {
    // 프리셋 적용 — 우측 패널 배치를 한 번에 교체(단일 set + 단일 persist). 입력은
    // 호출측(layoutPresetSnapshot)이 이미 정규화했다고 가정하되, order 는 방어적으로
    // 한 번 더 정규화한다.
    const next = {
      rightPanelWidthPx: sanitizeRightPanelWidthPx(input.rightPanelWidthPx),
      rightCardOrder: normalizeKeyOrder(input.rightCardOrder, LIVE_CARD_KEYS, isLiveCardKey),
      rightCardHidden: readCollapsedMap(input.rightCardHidden),
      rightCardCollapsed: readCollapsedMap(input.rightCardCollapsed),
      rightCardWeights: clampCardWeights(input.rightCardWeights),
      lastAppliedPresetId: input.lastAppliedPresetId,
    };
    set((state) => {
      persistFromState({ ...state, ...next });
      persistActivePresetId(next.lastAppliedPresetId);
      return next;
    });
  },
  setLastAppliedPresetId: (id) => {
    set((state) => {
      persistFromState({ ...state, lastAppliedPresetId: id });
      persistActivePresetId(id);
      return { lastAppliedPresetId: id };
    });
  },
}));
