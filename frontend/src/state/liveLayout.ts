import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

export const LIVE_LAYOUT_STORAGE_KEY = 'live.layout.v1';
export const DEFAULT_RIGHT_PANEL_WIDTH_PX = 400;
export const LIVE_DETAIL_MIN_WIDTH_PX = 320;
export const CHART_MIN_WIDTH_PX = 640;
export const LIVE_WORKAREA_SPLITTER_WIDTH_PX = 6;

const RIGHT_PANEL_MAX_FRACTION = 0.45;

export type LiveCardKey = 'orderbook' | 'program' | 'brokers' | 'investor';
export type LiveCardWeights = Record<LiveCardKey, number>;

export const DEFAULT_CARD_WEIGHTS: LiveCardWeights = {
  orderbook: 48,
  program: 13,
  brokers: 24,
  investor: 15,
};

export const LIVE_CARD_MIN_HEIGHT_PX: Record<LiveCardKey, number> = {
  orderbook: 260,
  program: 96,
  brokers: 160,
  investor: 120,
};

type Persisted = {
  rightPanelWidthPx: number;
  rightCardWeights: LiveCardWeights;
};

type Store = Persisted & {
  setRightPanelWidthPx: (widthPx: number) => void;
  setRightCardWeights: (weights: LiveCardWeights) => void;
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
  for (const key of Object.keys(DEFAULT_CARD_WEIGHTS)) {
    if (!isLiveCardKey(key)) continue;
    if (!isPositiveFiniteNumber(candidate[key])) return null;
  }

  return {
    orderbook: candidate.orderbook as number,
    program: candidate.program as number,
    brokers: candidate.brokers as number,
    investor: candidate.investor as number,
  };
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

  return next;
}

function persist(state: Persisted): void {
  persistJson(LIVE_LAYOUT_STORAGE_KEY, state);
}

const hydrated = readStorage();

export const useLiveLayoutStore = create<Store>((set) => ({
  rightPanelWidthPx: DEFAULT_RIGHT_PANEL_WIDTH_PX,
  rightCardWeights: DEFAULT_CARD_WEIGHTS,
  ...hydrated,
  setRightPanelWidthPx: (widthPx) => {
    const nextWidthPx = sanitizeRightPanelWidthPx(widthPx);
    set((state) => {
      const next = { rightPanelWidthPx: nextWidthPx, rightCardWeights: state.rightCardWeights };
      persist(next);
      return { rightPanelWidthPx: nextWidthPx };
    });
  },
  setRightCardWeights: (weights) => {
    const nextWeights = clampCardWeights(weights);
    set((state) => {
      const next = { rightPanelWidthPx: state.rightPanelWidthPx, rightCardWeights: nextWeights };
      persist(next);
      return { rightCardWeights: nextWeights };
    });
  },
}));
