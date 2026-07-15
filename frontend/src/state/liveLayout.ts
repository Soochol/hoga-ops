import { create } from 'zustand';
import { normalizeKeyOrder } from './keyOrder';
import { persistJson, readJsonObject } from './persist';

export const LIVE_LAYOUT_STORAGE_KEY = 'live.layout.v1';
export const DEFAULT_RIGHT_PANEL_WIDTH_PX = 400;
export const LIVE_DETAIL_MIN_WIDTH_PX = 320;
export const CHART_MIN_WIDTH_PX = 640;
export const LIVE_WORKAREA_SPLITTER_WIDTH_PX = 6;
/** 상세 패널을 전체 접었을 때 남는 세로 레일 너비(펼치기 클릭 타깃). */
export const DETAIL_PANEL_RAIL_WIDTH_PX = 28;

const RIGHT_PANEL_MAX_FRACTION = 0.45;

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

export const LIVE_CARD_MIN_HEIGHT_PX: Record<LiveCardKey, number> = {
  orderbook: 260,
  volumeDistribution: 180,
  program: 96,
  brokers: 160,
  investor: 120,
};

type Persisted = {
  rightPanelWidthPx: number;
  rightCardWeights: LiveCardWeights;
  /** 사용자 소유 카드 순서(안정 키 배열; 인덱스 아님, ADR-0114). */
  rightCardOrder: LiveCardKey[];
  /** 키 부재 = 표시. 숨김은 weights/collapse 를 파괴하지 않으므로 복구 시 이전 상태. */
  rightCardHidden: Partial<Record<LiveCardKey, boolean>>;
  /** 키 부재 = 펼침. weights 를 파괴하지 않으므로 펴면 이전 비율 복원. */
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
  setRightCardWeights: (weights: LiveCardWeights) => void;
  setRightCardOrder: (order: LiveCardKey[]) => void;
  setCardHidden: (key: LiveCardKey, hidden: boolean) => void;
  toggleCardCollapsed: (key: LiveCardKey) => void;
  setAllCardsCollapsed: (collapsed: boolean) => void;
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

export function clampRightPanelWidth(
  widthPx: number,
  workareaWidthPx: number,
  splitterWidthPx = 0,
): number {
  const safeWorkareaWidthPx = isPositiveFiniteNumber(workareaWidthPx) ? workareaWidthPx : 0;
  if (safeWorkareaWidthPx <= 0) return DEFAULT_RIGHT_PANEL_WIDTH_PX;

  const maxByFraction = Math.floor(safeWorkareaWidthPx * RIGHT_PANEL_MAX_FRACTION);
  const safeSplitterWidthPx = isPositiveFiniteNumber(splitterWidthPx) ? splitterWidthPx : 0;
  const maxByChart = Math.max(
    LIVE_DETAIL_MIN_WIDTH_PX,
    safeWorkareaWidthPx - CHART_MIN_WIDTH_PX - safeSplitterWidthPx,
  );
  const maxWidth = Math.max(LIVE_DETAIL_MIN_WIDTH_PX, Math.min(maxByFraction, maxByChart));
  const safeWidthPx = isPositiveFiniteNumber(widthPx) ? widthPx : DEFAULT_RIGHT_PANEL_WIDTH_PX;

  return Math.min(maxWidth, Math.max(LIVE_DETAIL_MIN_WIDTH_PX, Math.round(safeWidthPx)));
}

export function clampCardWeights(weights: Partial<LiveCardWeights>): LiveCardWeights {
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

export function resizeAdjacentWeights(
  weights: LiveCardWeights,
  upperKey: LiveCardKey,
  lowerKey: LiveCardKey,
  deltaPx: number,
  panelHeightPx: number,
): LiveCardWeights {
  if (!isFiniteNumber(deltaPx) || !isPositiveFiniteNumber(panelHeightPx)) return weights;

  const totalWeight = weights[upperKey] + weights[lowerKey];
  if (!(totalWeight > 0)) return weights;

  const upperMinPx = LIVE_CARD_MIN_HEIGHT_PX[upperKey];
  const lowerMinPx = LIVE_CARD_MIN_HEIGHT_PX[lowerKey];
  const minTotalPx = upperMinPx + lowerMinPx;
  if (panelHeightPx < minTotalPx) return weights;

  const currentUpperPx = (weights[upperKey] / totalWeight) * panelHeightPx;
  const maxUpperPx = panelHeightPx - lowerMinPx;
  const nextUpperPx = Math.min(
    maxUpperPx,
    Math.max(upperMinPx, currentUpperPx + deltaPx),
  );

  const nextUpperWeight = (nextUpperPx / panelHeightPx) * totalWeight;
  const nextLowerWeight = totalWeight - nextUpperWeight;

  return {
    ...weights,
    [upperKey]: nextUpperWeight,
    [lowerKey]: nextLowerWeight,
  };
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
  if (typeof parsed.lastAppliedPresetId === 'string') {
    next.lastAppliedPresetId = parsed.lastAppliedPresetId;
  }

  return next;
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
  setRightCardWeights: (weights) => {
    const nextWeights = clampCardWeights(weights);
    set((state) => {
      persistFromState({ ...state, rightCardWeights: nextWeights });
      return { rightCardWeights: nextWeights };
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
  toggleCardCollapsed: (key) => {
    set((state) => {
      const nextCollapsed = { ...state.rightCardCollapsed, [key]: !state.rightCardCollapsed[key] };
      persistFromState({ ...state, rightCardCollapsed: nextCollapsed });
      return { rightCardCollapsed: nextCollapsed };
    });
  },
  setAllCardsCollapsed: (collapsed) => {
    set((state) => {
      const nextCollapsed: Partial<Record<LiveCardKey, boolean>> = {};
      for (const key of Object.keys(DEFAULT_CARD_WEIGHTS)) {
        if (isLiveCardKey(key)) nextCollapsed[key] = collapsed;
      }
      persistFromState({ ...state, rightCardCollapsed: nextCollapsed });
      return { rightCardCollapsed: nextCollapsed };
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
      return next;
    });
  },
  setLastAppliedPresetId: (id) => {
    set((state) => {
      persistFromState({ ...state, lastAppliedPresetId: id });
      return { lastAppliedPresetId: id };
    });
  },
}));
