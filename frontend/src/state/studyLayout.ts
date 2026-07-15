import { create } from 'zustand';
import { normalizeKeyOrder } from './keyOrder';
import { DETAIL_PANEL_RAIL_WIDTH_PX } from './liveLayout';
import { persistJson, readJsonObject } from './persist';

export const STUDY_LAYOUT_STORAGE_KEY = 'study.layout.v1';
/** 상세 패널을 전체 접었을 때 남는 세로 레일 너비 — /live 와 같은 값 하나만 존재. */
export const STUDY_DETAIL_PANEL_RAIL_WIDTH_PX = DETAIL_PANEL_RAIL_WIDTH_PX;

export type StudyCardKey = 'orderbook' | 'brokers' | 'volumeDistribution' | 'program';

/** 렌더 순서 그대로의 카드 키 — 패널의 섹션 목록·전체접힘 판정이 이 목록을 공유한다. */
export const STUDY_CARD_KEYS: readonly StudyCardKey[] = [
  'orderbook',
  'brokers',
  'volumeDistribution',
  'program',
];

function isStudyCardKey(value: string): value is StudyCardKey {
  return (STUDY_CARD_KEYS as readonly string[]).includes(value);
}

type Persisted = {
  /** 사용자 소유 카드 순서(안정 키 배열, ADR-0114). */
  cardOrder: StudyCardKey[];
  /** 키 부재 = 표시. 숨김은 collapse 를 파괴하지 않는다. */
  cardHidden: Partial<Record<StudyCardKey, boolean>>;
  /** 키 부재 = 펼침. */
  cardCollapsed: Partial<Record<StudyCardKey, boolean>>;
  detailPanelCollapsed: boolean;
};

type Store = Persisted & {
  setCardOrder: (order: StudyCardKey[]) => void;
  setCardHidden: (key: StudyCardKey, hidden: boolean) => void;
  toggleCardCollapsed: (key: StudyCardKey) => void;
  setAllCardsCollapsed: (collapsed: boolean) => void;
  setDetailPanelCollapsed: (collapsed: boolean) => void;
  toggleDetailPanelCollapsed: () => void;
};

/** 엔트리별 관대 검증 — 손상된 엔트리 하나가 전체 맵을 날리지 않도록(부울 맵). */
function readCollapsedMap(value: unknown): Partial<Record<StudyCardKey, boolean>> {
  const next: Partial<Record<StudyCardKey, boolean>> = {};
  if (!value || typeof value !== 'object') return next;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isStudyCardKey(key) && typeof raw === 'boolean') next[key] = raw;
  }
  return next;
}

function readStorage(): Partial<Persisted> {
  const parsed = readJsonObject(STUDY_LAYOUT_STORAGE_KEY);
  const next: Partial<Persisted> = {
    cardOrder: normalizeKeyOrder(parsed.cardOrder, STUDY_CARD_KEYS, isStudyCardKey),
    cardHidden: readCollapsedMap(parsed.cardHidden),
    cardCollapsed: readCollapsedMap(parsed.cardCollapsed),
  };
  if (typeof parsed.detailPanelCollapsed === 'boolean') {
    next.detailPanelCollapsed = parsed.detailPanelCollapsed;
  }
  return next;
}

function persistFromState(state: Persisted): void {
  persistJson(STUDY_LAYOUT_STORAGE_KEY, {
    cardOrder: state.cardOrder,
    cardHidden: state.cardHidden,
    cardCollapsed: state.cardCollapsed,
    detailPanelCollapsed: state.detailPanelCollapsed,
  });
}

const hydrated = readStorage();

export const useStudyLayoutStore = create<Store>((set) => ({
  cardOrder: [...STUDY_CARD_KEYS],
  cardHidden: {},
  cardCollapsed: {},
  detailPanelCollapsed: false,
  ...hydrated,
  setCardOrder: (order) => {
    const nextOrder = normalizeKeyOrder(order, STUDY_CARD_KEYS, isStudyCardKey);
    set((state) => {
      persistFromState({ ...state, cardOrder: nextOrder });
      return { cardOrder: nextOrder };
    });
  },
  setCardHidden: (key, hidden) => {
    set((state) => {
      const nextHidden = { ...state.cardHidden, [key]: hidden };
      persistFromState({ ...state, cardHidden: nextHidden });
      return { cardHidden: nextHidden };
    });
  },
  toggleCardCollapsed: (key) => {
    set((state) => {
      const nextCollapsed = { ...state.cardCollapsed, [key]: !state.cardCollapsed[key] };
      persistFromState({ ...state, cardCollapsed: nextCollapsed });
      return { cardCollapsed: nextCollapsed };
    });
  },
  setAllCardsCollapsed: (collapsed) => {
    set((state) => {
      const nextCollapsed: Partial<Record<StudyCardKey, boolean>> = {};
      for (const key of STUDY_CARD_KEYS) nextCollapsed[key] = collapsed;
      persistFromState({ ...state, cardCollapsed: nextCollapsed });
      return { cardCollapsed: nextCollapsed };
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
}));
