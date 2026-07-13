import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

export const STUDY_LAYOUT_STORAGE_KEY = 'study.layout.v1';
/** 상세 패널을 전체 접었을 때 남는 세로 레일 너비(펼치기 클릭 타깃). /live 와 동일. */
export const STUDY_DETAIL_PANEL_RAIL_WIDTH_PX = 28;

export type StudyCardKey = 'orderbook' | 'brokers' | 'volumeDistribution' | 'program';

const STUDY_CARD_KEYS: readonly StudyCardKey[] = [
  'orderbook',
  'brokers',
  'volumeDistribution',
  'program',
];

function isStudyCardKey(value: string): value is StudyCardKey {
  return (STUDY_CARD_KEYS as readonly string[]).includes(value);
}

type Persisted = {
  /** 키 부재 = 펼침. */
  cardCollapsed: Partial<Record<StudyCardKey, boolean>>;
  detailPanelCollapsed: boolean;
};

type Store = Persisted & {
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
    cardCollapsed: readCollapsedMap(parsed.cardCollapsed),
  };
  if (typeof parsed.detailPanelCollapsed === 'boolean') {
    next.detailPanelCollapsed = parsed.detailPanelCollapsed;
  }
  return next;
}

function persistFromState(state: Persisted): void {
  persistJson(STUDY_LAYOUT_STORAGE_KEY, {
    cardCollapsed: state.cardCollapsed,
    detailPanelCollapsed: state.detailPanelCollapsed,
  });
}

const hydrated = readStorage();

export const useStudyLayoutStore = create<Store>((set) => ({
  cardCollapsed: {},
  detailPanelCollapsed: false,
  ...hydrated,
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
