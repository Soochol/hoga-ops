import type { LineStyle } from '../chart/drawing/types';
import {
  BROKER_LATE_ENTRY_DEFAULT_START_HHMM,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  type BrokerLateEntrySideMode,
  type LiveMAConfig,
} from './liveIndicatorsPersistence';
import type { IndicatorSettings } from './indicatorSettingsV2';

/**
 * 지표 설정의 도메인 변이 — 순수 함수 모음 (ADR-0119 C2c-2a).
 *
 * `(현재 설정, 인자) → Partial<IndicatorSettings> | null` 규약. null = no-op
 * (검증 실패·한도 도달). 여기 있는 로직이 지표 setter 시맨틱의 SSOT 다:
 *
 * - 전역 `useLivePageStore` 의 이름 setter 들은 이 ops 를 호출해 ambient 봉
 *   버킷에 patch 를 기록한다 (기존 단일 뷰 · `/study` 경로).
 * - 멀티창의 `useIndicatorActions()`(windowView)는 같은 ops 를 호출해 대상
 *   차트 창의 봉 버킷에 patch 를 기록한다 (#712 창 소유 설정).
 *
 * 두 백엔드가 클램프·enable↔hidden 결합·스타일 병합 시맨틱을 중복 없이
 * 공유하기 위한 절단면이므로, 지표 변이 규칙을 바꿀 때는 이 모듈만 고친다.
 */

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function nextSlotId(existing: readonly LiveMAConfig[], prefix = 'ma'): string {
  const used = new Set(existing.map((m) => m.id));
  for (let i = 1; i <= MA_SLOT_LIMIT * 2; i++) {
    const id = `${prefix}-${i}`;
    if (!used.has(id)) return id;
  }
  // Fallback (should never hit given MA_SLOT_LIMIT cap) — deterministic to
  // keep this module pure.
  return `${prefix}-overflow-${existing.length}`;
}

/** 8색 hex palette — tokens.css의 --ma-1..--ma-8과 매칭. canvas는 CSS
 *  var를 직접 받지 못해 hex로 정적 deflate. 신규 슬롯의 색 자동 배정
 *  (`nextSlotColor`)에 사용한다. 사용자가 직접 색을 고르는 32색 grid
 *  (8 hue × 4 shade)는 `MAStylePicker`에 별도로 정의되어 있다. */
export const MA_PALETTE: readonly string[] = [
  '#EC4899', '#3B82F6', '#F97316', '#22C55E',
  '#F8FAFC', '#06B6D4', '#EAB308', '#94A3B8',
];

function nextSlotColor(existing: readonly LiveMAConfig[]): string {
  const used = new Set(existing.map((m) => m.color.toLowerCase()));
  const free = MA_PALETTE.find((c) => !used.has(c.toLowerCase()));
  return free ?? MA_PALETTE[existing.length % MA_PALETTE.length];
}

function normalizeBrokerLateEntryStartHHMM(value: number): number {
  const next = Math.trunc(value);
  const hh = Math.floor(next / 100);
  const mm = next % 100;
  return hh < 9 || hh > 15 || mm < 0 || mm > 59 || (hh === 15 && mm > 20)
    ? BROKER_LATE_ENTRY_DEFAULT_START_HHMM
    : next;
}

type Patch = Partial<IndicatorSettings> | null;

function patchMaSlot(
  current: readonly LiveMAConfig[],
  id: string,
  patch: Partial<LiveMAConfig>,
): LiveMAConfig[] | null {
  const idx = current.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const next: LiveMAConfig = { ...current[idx], ...patch };
  if (patch.period !== undefined) {
    const p = Number(patch.period);
    if (!Number.isFinite(p)) return null;
    next.period = clamp(Math.floor(p), MA_PERIOD_MIN, MA_PERIOD_MAX);
  }
  const nextArr = current.slice();
  nextArr[idx] = next;
  return nextArr;
}

function addMaSlot(
  current: readonly LiveMAConfig[],
  prefix: 'ma' | 'dma',
  lineWidth: 1 | 2,
): LiveMAConfig[] | null {
  if (current.length >= MA_SLOT_LIMIT) return null;
  const last = current[current.length - 1];
  const period = last ? clamp(last.period * 2, MA_PERIOD_MIN, MA_PERIOD_MAX) : 20;
  const next: LiveMAConfig = {
    id: nextSlotId(current, prefix),
    enabled: true,
    period,
    color: nextSlotColor(current),
    lineWidth,
    source: 'close',
  };
  return [...current, next];
}

function removeMaSlot(current: readonly LiveMAConfig[], id: string): LiveMAConfig[] | null {
  if (current.length <= 1) return null;
  const nextArr = current.filter((m) => m.id !== id);
  if (nextArr.length === current.length) return null; // unknown id
  return nextArr;
}

export const INDICATOR_OPS = {
  setMovingAverage: (cur: IndicatorSettings, id: string, patch: Partial<LiveMAConfig>): Patch => {
    const next = patchMaSlot(cur.movingAverages, id, patch);
    return next ? { movingAverages: next } : null;
  },
  addMovingAverage: (cur: IndicatorSettings): Patch => {
    const next = addMaSlot(cur.movingAverages, 'ma', 1);
    return next ? { movingAverages: next } : null;
  },
  removeMovingAverage: (cur: IndicatorSettings, id: string): Patch => {
    const next = removeMaSlot(cur.movingAverages, id);
    return next ? { movingAverages: next } : null;
  },
  setMovingAverageEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ movingAverageEnabled: enabled }),
  setMovingAverageHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ movingAverageHidden: hidden }),

  setDailyMovingAverage: (cur: IndicatorSettings, id: string, patch: Partial<LiveMAConfig>): Patch => {
    const next = patchMaSlot(cur.dailyMovingAverages, id, patch);
    return next ? { dailyMovingAverages: next } : null;
  },
  addDailyMovingAverage: (cur: IndicatorSettings): Patch => {
    const next = addMaSlot(cur.dailyMovingAverages, 'dma', 2);
    return next ? { dailyMovingAverages: next } : null;
  },
  removeDailyMovingAverage: (cur: IndicatorSettings, id: string): Patch => {
    const next = removeMaSlot(cur.dailyMovingAverages, id);
    return next ? { dailyMovingAverages: next } : null;
  },
  // MA 마스터 규칙: 켤 때 hidden 초기화(꺼진 채 켜지는 혼란 방지).
  setDailyMovingAverageEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled
      ? { dailyMovingAverageEnabled: true, dailyMovingAverageHidden: false }
      : { dailyMovingAverageEnabled: false }),
  setDailyMovingAverageHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ dailyMovingAverageHidden: hidden }),

  setVolumeEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ volumeEnabled: enabled }),
  setForeignNetEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ foreignNetEnabled: enabled }),
  setInstitutionNetEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ institutionNetEnabled: enabled }),

  setAskPeakEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled ? { askPeakEnabled: true, askPeakHidden: false } : { askPeakEnabled: false }),
  setAskPeakHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ askPeakHidden: hidden }),
  setAskPeakStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    askPeakColor: patch.color ?? cur.askPeakColor,
    askPeakLineWidth: patch.lineWidth ?? cur.askPeakLineWidth,
  }),
  setAskPeakAllPriceStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    askPeakAllPriceColor: patch.color ?? cur.askPeakAllPriceColor,
    askPeakAllPriceLineWidth: patch.lineWidth ?? cur.askPeakAllPriceLineWidth,
  }),
  setAskPeakVisibleMaxStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    askPeakVisibleMaxColor: patch.color ?? cur.askPeakVisibleMaxColor,
    askPeakVisibleMaxLineWidth: patch.lineWidth ?? cur.askPeakVisibleMaxLineWidth,
  }),
  setViLimitPriceLineStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    viLimitPriceLineColor: patch.color ?? cur.viLimitPriceLineColor,
    viLimitPriceLineWidth: patch.lineWidth ?? cur.viLimitPriceLineWidth,
  }),

  setBidPeakEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled ? { bidPeakEnabled: true, bidPeakHidden: false } : { bidPeakEnabled: false }),
  setBidPeakHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ bidPeakHidden: hidden }),
  setBidPeakStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    bidPeakColor: patch.color ?? cur.bidPeakColor,
    bidPeakLineWidth: patch.lineWidth ?? cur.bidPeakLineWidth,
  }),
  setBidPeakAllPriceStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    bidPeakAllPriceColor: patch.color ?? cur.bidPeakAllPriceColor,
    bidPeakAllPriceLineWidth: patch.lineWidth ?? cur.bidPeakAllPriceLineWidth,
  }),

  setTradeVolumePocEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled
      ? { tradeVolumePocEnabled: true, tradeVolumePocHidden: false }
      : { tradeVolumePocEnabled: false }),
  setTradeVolumePocHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ tradeVolumePocHidden: hidden }),
  setTradeVolumePocBandPct: (_cur: IndicatorSettings, bandPct: number): Patch => {
    if (bandPct !== 0.0025 && bandPct !== 0.005 && bandPct !== 0.01) return null;
    return { tradeVolumePocBandPct: bandPct };
  },
  setTradeVolumePocStyle: (cur: IndicatorSettings, patch: { color?: string; opacity?: number }): Patch => ({
    tradeVolumePocColor: patch.color ?? cur.tradeVolumePocColor,
    tradeVolumePocOpacity: patch.opacity === undefined
      ? cur.tradeVolumePocOpacity
      : clamp(patch.opacity, 0, 1),
  }),

  setDepthHeatmapEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled
      ? { depthHeatmapEnabled: true, depthHeatmapHidden: false }
      : { depthHeatmapEnabled: false }),
  setDepthHeatmapHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ depthHeatmapHidden: hidden }),
  setDepthHeatmapStyle: (cur: IndicatorSettings, patch: { bidColor?: string; askColor?: string; maxOpacity?: number }): Patch => ({
    depthHeatmapBidColor: patch.bidColor ?? cur.depthHeatmapBidColor,
    depthHeatmapAskColor: patch.askColor ?? cur.depthHeatmapAskColor,
    depthHeatmapMaxOpacity: patch.maxOpacity === undefined
      ? cur.depthHeatmapMaxOpacity
      : clamp(patch.maxOpacity, 0.2, 1),
  }),

  setVolumeDistributionEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ volumeDistributionEnabled: enabled }),
  setVolumeDistributionHoverCutoffEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ volumeDistributionHoverCutoffEnabled: enabled }),
  setVolumeDistributionRangeCount: (_cur: IndicatorSettings, count: number): Patch => {
    if (!Number.isFinite(count)) return null;
    return { volumeDistributionRangeCount: clamp(Math.trunc(count), 5, 30) };
  },
  setVolumeDistributionStyle: (cur: IndicatorSettings, patch: { color?: string; maxColor?: string }): Patch => ({
    volumeDistributionColor: patch.color ?? cur.volumeDistributionColor,
    volumeDistributionMaxColor: patch.maxColor ?? cur.volumeDistributionMaxColor,
  }),

  setQuoteTotalsEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ quoteTotalsEnabled: enabled }),
  setQuoteTotalsLevelLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ quoteTotalsLevelLineEnabled: enabled }),
  setQuoteTotalsBidLevelStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }): Patch => ({
    quoteTotalsBidLevelColor: patch.color ?? cur.quoteTotalsBidLevelColor,
    quoteTotalsBidLevelWidth: patch.lineWidth ?? cur.quoteTotalsBidLevelWidth,
    quoteTotalsBidLevelStyle: patch.lineStyle ?? cur.quoteTotalsBidLevelStyle,
  }),
  setQuoteTotalsAskLevelStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }): Patch => ({
    quoteTotalsAskLevelColor: patch.color ?? cur.quoteTotalsAskLevelColor,
    quoteTotalsAskLevelWidth: patch.lineWidth ?? cur.quoteTotalsAskLevelWidth,
    quoteTotalsAskLevelStyle: patch.lineStyle ?? cur.quoteTotalsAskLevelStyle,
  }),

  setRatioEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ ratioEnabled: enabled }),
  setRatioLevelLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ ratioLevelLineEnabled: enabled }),
  setRatioLevelStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }): Patch => ({
    ratioLevelColor: patch.color ?? cur.ratioLevelColor,
    ratioLevelWidth: patch.lineWidth ?? cur.ratioLevelWidth,
    ratioLevelStyle: patch.lineStyle ?? cur.ratioLevelStyle,
  }),

  setFillStrengthEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ fillStrengthEnabled: enabled }),
  setProgramTradeEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ programTradeEnabled: enabled }),

  setBrokerLateEntryEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled
      ? { brokerLateEntryEnabled: true, brokerLateEntryHidden: false }
      : { brokerLateEntryEnabled: false }),
  setBrokerLateEntryHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ brokerLateEntryHidden: hidden }),
  setBrokerLateEntryStartHHMM: (_cur: IndicatorSettings, value: number): Patch => {
    if (!Number.isFinite(value)) {
      return { brokerLateEntryStartHHMM: BROKER_LATE_ENTRY_DEFAULT_START_HHMM };
    }
    return { brokerLateEntryStartHHMM: normalizeBrokerLateEntryStartHHMM(value) };
  },
  setBrokerLateEntrySideMode: (_cur: IndicatorSettings, mode: BrokerLateEntrySideMode): Patch => {
    if (mode !== 'both' && mode !== 'buy' && mode !== 'sell') return null;
    return { brokerLateEntrySideMode: mode };
  },
  setBrokerLateEntryStyle: (cur: IndicatorSettings, patch: { buyColor?: string; sellColor?: string }): Patch => ({
    brokerLateEntryBuyColor: patch.buyColor ?? cur.brokerLateEntryBuyColor,
    brokerLateEntrySellColor: patch.sellColor ?? cur.brokerLateEntrySellColor,
  }),
} as const;

export type IndicatorOps = typeof INDICATOR_OPS;

type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;

/** ops 를 (읽기, 쓰기) 백엔드에 바인딩한 이름 setter 표면 — 인자에서 `cur` 가 빠진다. */
export type BoundIndicatorOps = {
  [K in keyof IndicatorOps]: (...args: DropFirst<Parameters<IndicatorOps[K]>>) => void;
};

/**
 * ops 전체를 백엔드에 바인딩한다. `read` 는 호출 시점의 현재 설정(스토어 fresh
 * read — stale closure 방지), `apply` 는 patch 의 목적지(전역 ambient 버킷 또는
 * 창별 봉 버킷). no-op patch(null)는 흡수한다.
 */
export function bindIndicatorOps(
  read: () => IndicatorSettings,
  apply: (patch: Partial<IndicatorSettings>) => void,
): BoundIndicatorOps {
  const out: Record<string, (...args: unknown[]) => void> = {};
  for (const [name, op] of Object.entries(INDICATOR_OPS)) {
    out[name] = (...args: unknown[]) => {
      const patch = (op as (cur: IndicatorSettings, ...rest: unknown[]) => Partial<IndicatorSettings> | null)(
        read(),
        ...args,
      );
      if (patch) apply(patch);
    };
  }
  return out as BoundIndicatorOps;
}
