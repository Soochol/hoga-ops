import type { LineStyle } from '../chart/drawing/types';
import {
  BROKER_LATE_ENTRY_DEFAULT_START_HHMM,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  BROKER_LATE_ENTRY_SLOT_LIMIT,
  type BrokerLateEntryConfig,
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

/** 슬롯 하나 삭제. **마지막 하나도 지울 수 있다** — 레전드 칩 ✕ 가 인스턴스 단위
 *  삭제이므로 "0개" 는 도달 가능한 유효 상태다(코어서의 `normalizeMaSlots` 가 빈
 *  배열을 보존한다). 종전의 min-1 가드는 마스터 토글이 가시성을 쥐고 있어 슬롯이
 *  0개면 되살릴 UI 가 없던 시절의 방어였다. null 은 **모르는 id** 일 때만. */
function removeMaSlot(current: readonly LiveMAConfig[], id: string): LiveMAConfig[] | null {
  const nextArr = current.filter((m) => m.id !== id);
  if (nextArr.length === current.length) return null; // unknown id
  return nextArr;
}

/**
 * 값 series 없이 캔들/호가비 pane 위에 그려지는 오버레이 지표 — 레전드에서는
 * "flag 행" 으로 나온다. 이 목록이 **정본**이고 `legendRows` 의 `LegendFlagId` 가
 * 여기서 파생된다(레전드는 표현, 설정 스키마는 이 계층).
 */
export const FLAG_INDICATOR_TYPES = [
  'ask-peak',
  'bid-peak',
  'trade-volume-poc',
  'depth-heatmap',
  'depth-delta',
  'broker-late-entry',
] as const;

export type FlagIndicatorType = (typeof FLAG_INDICATOR_TYPES)[number];

/** flag 지표의 사용자 표시명 — 레전드 라벨·undo 문구·설정 패널이 공유한다. */
export const FLAG_INDICATOR_LABEL: Record<FlagIndicatorType, string> = {
  'ask-peak': '당일 매도 최대벽',
  'bid-peak': '당일 매수 최대벽',
  'trade-volume-poc': '당일 최대 매물대',
  'depth-heatmap': '호가 잔량 히트맵',
  'depth-delta': '단별 잔량 증감',
  'broker-late-entry': '신규 거래원 등장',
};

/**
 * 각 flag 지표가 **소유한 설정 필드 전부** — 삭제(=공장값 리셋)의 대상 집합.
 *
 * 손으로 적는다. 접두사 매칭 같은 자동 발견을 쓰지 않는 이유는 이 리포가 이미
 * 판정한 것과 같다: 이름 규칙 매칭은 **오탐과 누락이 둘 다 조용하다**. 대신
 * `indicatorOps.flagFields.test.ts` 가 "flag 접두를 가진 `IndicatorSettings` 키는
 * 정확히 한 목록에 속한다" 를 강제한다 — 새 필드가 늘면 그 가드가 빨개진다.
 * 이 가드는 실제로 **세 번** 잡았다: #1582 의 `askPeakAllWall*` 3필드, #1588 의
 * `*Unreached*` 6필드, 그리고 설정 재구성의 `*PeakTradedLineEnabled` 2필드
 * (전부 병행 PR 이라 텍스트 충돌 없이 머지됐다). 손 목록의 위험이
 * 이론이 아니라는 증거이고, 동시에 가드가 그 위험을 실제로 덮는다는 증거다.
 */
export const FLAG_INDICATOR_FIELDS: Record<
  FlagIndicatorType,
  readonly (keyof IndicatorSettings)[]
> = {
  'ask-peak': [
    'askPeakEnabled', 'askPeakHidden', 'askPeakColor', 'askPeakLineWidth',
    'askPeakTradedLineEnabled',
    'askPeakAllWallLineEnabled', 'askPeakAllWallColor', 'askPeakAllWallLineWidth',
    'askPeakUnreachedLineEnabled', 'askPeakUnreachedColor', 'askPeakUnreachedLineWidth',
  ],
  'bid-peak': [
    'bidPeakEnabled', 'bidPeakHidden', 'bidPeakColor', 'bidPeakLineWidth',
    'bidPeakTradedLineEnabled',
    'bidPeakAllWallLineEnabled', 'bidPeakAllWallColor', 'bidPeakAllWallLineWidth',
    'bidPeakUnreachedLineEnabled', 'bidPeakUnreachedColor', 'bidPeakUnreachedLineWidth',
  ],
  'trade-volume-poc': [
    'tradeVolumePocEnabled', 'tradeVolumePocHidden', 'tradeVolumePocBandPct',
    'tradeVolumePocColor', 'tradeVolumePocOpacity',
  ],
  'depth-heatmap': [
    'depthHeatmapEnabled', 'depthHeatmapHidden', 'depthHeatmapBidColor',
    'depthHeatmapAskColor', 'depthHeatmapMaxOpacity',
  ],
  'depth-delta': [
    'depthDeltaEnabled', 'depthDeltaHidden', 'depthDeltaInColor',
    'depthDeltaOutColor', 'depthDeltaMaxOpacity',
  ],
  // 배열로 승격된 지표는 **필드가 하나**다 — 삭제 = 공장 배열로 되돌리기.
  'broker-late-entry': ['brokerLateEntries'],
};

/**
 * flag 지표 삭제의 patch 쌍 — `apply` 는 공장값으로 되돌리고, `undo` 는 현재값이다.
 *
 * MA 는 배열에서 원소를 빼는 것이 삭제지만, flat 싱글턴 타입은 뺄 배열이 없다.
 * 그래서 삭제 = **그 지표가 소유한 필드를 전부 공장값으로**다. 공장값과 같아진
 * 필드는 sparse 버킷의 정의상 다음 로드에서 자연 소멸하므로("diff 제거"),
 * 결과적으로 "이 지표에 대해 사용자가 손댄 적 없는 상태" 가 된다.
 *
 * 배열 승격(Phase 3) 전까지 flat 타입의 인스턴스는 언제나 하나이므로, 삭제가
 * 곧 "그 하나를 지우는 것" 이다.
 */
export function flagRemovalPatches(
  cur: IndicatorSettings,
  type: FlagIndicatorType,
  factory: IndicatorSettings,
): { label: string; apply: Partial<IndicatorSettings>; undo: Partial<IndicatorSettings> } {
  const apply: Record<string, unknown> = {};
  const undo: Record<string, unknown> = {};
  for (const field of FLAG_INDICATOR_FIELDS[type]) {
    apply[field] = factory[field];
    undo[field] = cur[field];
  }
  return {
    label: `${FLAG_INDICATOR_LABEL[type]} 삭제됨`,
    apply: apply as Partial<IndicatorSettings>,
    undo: undo as Partial<IndicatorSettings>,
  };
}

/** MA 계열 두 슬라이스의 사용자 표시명 — 레전드 라벨과 undo 문구가 공유한다. */
export const MA_SLICE_LABEL = {
  movingAverages: '이동평균선',
  dailyMovingAverages: '일봉 이동평균선',
} as const;

export type MaSliceKey = keyof typeof MA_SLICE_LABEL;

/**
 * 슬롯 삭제의 undo 스냅샷 — **삭제를 수행하지 않는다**(호출자가 op 로 한다).
 *
 * 되돌릴 값이 배열 **전체**인 것이 요점이다. 지운 원소만 다시 끼우면 순서를
 * 복원할 수 없고, 토스트가 떠 있는 동안 다른 슬롯이 편집됐을 때 어느 쪽을
 * 이겨야 하는지도 애매해진다. 전체 스냅샷은 "그 시점으로 되돌린다" 는 한 가지
 * 뜻만 갖는다(드로잉 `clearToast` 와 같은 규율).
 *
 * 모르는 id 면 null — 호출자는 삭제도 토스트도 하지 않는다.
 */
export function maRemovalUndo(
  cur: IndicatorSettings,
  key: MaSliceKey,
  id: string,
): { label: string; patch: Partial<IndicatorSettings> } | null {
  const slots = cur[key];
  const slot = slots.find((m) => m.id === id);
  if (!slot) return null;
  return {
    label: `${MA_SLICE_LABEL[key]} ${slot.period} 삭제됨`,
    patch: { [key]: slots } as Partial<IndicatorSettings>,
  };
}

/** 거래원 등장 인스턴스 삭제의 undo 스냅샷 — MA 의 `maRemovalUndo` 와 같은 규약
 *  (배열 **전체**를 되돌린다: 원소만 다시 끼우면 순서를 복원할 수 없다). */
export function brokerLateEntryRemovalUndo(
  cur: IndicatorSettings,
  id: string,
): { label: string; patch: Partial<IndicatorSettings> } | null {
  const target = cur.brokerLateEntries.find((e) => e.id === id);
  if (!target) return null;
  const hh = String(Math.floor(target.startHHMM / 100)).padStart(2, '0');
  const mm = String(target.startHHMM % 100).padStart(2, '0');
  return {
    label: `신규 거래원 ${hh}:${mm} 삭제됨`,
    patch: { brokerLateEntries: cur.brokerLateEntries },
  };
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
  /** 타입 전체 일괄 표시/숨김 — 마스터 토글의 후계다. 마스터가 슬롯의 `enabled` 로
   *  접히면서(ADR) "타입을 끈다" 는 곧 "전 슬롯을 끈다" 가 됐다. 슬롯이 0개면 켤
   *  대상이 없으므로 no-op(null) — 빈 배열에 쓰면 diff 만 늘고 화면은 그대로다. */
  setAllMovingAveragesEnabled: (cur: IndicatorSettings, enabled: boolean): Patch =>
    (cur.movingAverages.length === 0
      ? null
      : { movingAverages: cur.movingAverages.map((m) => ({ ...m, enabled })) }),

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
  /** 일봉 판 — `setAllMovingAveragesEnabled` 와 같은 규약. */
  setAllDailyMovingAveragesEnabled: (cur: IndicatorSettings, enabled: boolean): Patch =>
    (cur.dailyMovingAverages.length === 0
      ? null
      : { dailyMovingAverages: cur.dailyMovingAverages.map((m) => ({ ...m, enabled })) }),

  setVolumeEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ volumeEnabled: enabled }),
  setPeakWallPaneEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ peakWallPaneEnabled: enabled }),
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
  setAskPeakTradedLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ askPeakTradedLineEnabled: enabled }),
  setAskPeakAllWallLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ askPeakAllWallLineEnabled: enabled }),
  setAskPeakAllWallStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    askPeakAllWallColor: patch.color ?? cur.askPeakAllWallColor,
    askPeakAllWallLineWidth: patch.lineWidth ?? cur.askPeakAllWallLineWidth,
  }),
  setAskPeakUnreachedLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ askPeakUnreachedLineEnabled: enabled }),
  setAskPeakUnreachedStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    askPeakUnreachedColor: patch.color ?? cur.askPeakUnreachedColor,
    askPeakUnreachedLineWidth: patch.lineWidth ?? cur.askPeakUnreachedLineWidth,
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
  setBidPeakTradedLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ bidPeakTradedLineEnabled: enabled }),
  setBidPeakAllWallLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ bidPeakAllWallLineEnabled: enabled }),
  setBidPeakAllWallStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    bidPeakAllWallColor: patch.color ?? cur.bidPeakAllWallColor,
    bidPeakAllWallLineWidth: patch.lineWidth ?? cur.bidPeakAllWallLineWidth,
  }),
  setBidPeakUnreachedLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ bidPeakUnreachedLineEnabled: enabled }),
  setBidPeakUnreachedStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }): Patch => ({
    bidPeakUnreachedColor: patch.color ?? cur.bidPeakUnreachedColor,
    bidPeakUnreachedLineWidth: patch.lineWidth ?? cur.bidPeakUnreachedLineWidth,
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

  setWallSurgeEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ wallSurgeEnabled: enabled }),

  setDepthDeltaEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    (enabled
      ? { depthDeltaEnabled: true, depthDeltaHidden: false }
      : { depthDeltaEnabled: false }),
  setDepthDeltaHidden: (_cur: IndicatorSettings, hidden: boolean): Patch =>
    ({ depthDeltaHidden: hidden }),
  setDepthDeltaStyle: (cur: IndicatorSettings, patch: { inColor?: string; outColor?: string; maxOpacity?: number }): Patch => ({
    depthDeltaInColor: patch.inColor ?? cur.depthDeltaInColor,
    depthDeltaOutColor: patch.outColor ?? cur.depthDeltaOutColor,
    // 코어서(0.2~1)와 슬라이더 min/max 와 **같은 범위**여야 한다 — tradeVolumePoc 의
    // 0~1 을 복사해 오면 op 가 코어서가 거부하는 값을 만들어 저장 시 되돌아간다.
    depthDeltaMaxOpacity: patch.maxOpacity === undefined
      ? cur.depthDeltaMaxOpacity
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
  setQuoteTotalsDayMaxLineEnabled: (_cur: IndicatorSettings, enabled: boolean): Patch =>
    ({ quoteTotalsDayMaxLineEnabled: enabled }),
  setQuoteTotalsDayMaxBidStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }): Patch => ({
    quoteTotalsDayMaxBidColor: patch.color ?? cur.quoteTotalsDayMaxBidColor,
    quoteTotalsDayMaxBidWidth: patch.lineWidth ?? cur.quoteTotalsDayMaxBidWidth,
    quoteTotalsDayMaxBidStyle: patch.lineStyle ?? cur.quoteTotalsDayMaxBidStyle,
  }),
  setQuoteTotalsDayMaxAskStyle: (cur: IndicatorSettings, patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }): Patch => ({
    quoteTotalsDayMaxAskColor: patch.color ?? cur.quoteTotalsDayMaxAskColor,
    quoteTotalsDayMaxAskWidth: patch.lineWidth ?? cur.quoteTotalsDayMaxAskWidth,
    quoteTotalsDayMaxAskStyle: patch.lineStyle ?? cur.quoteTotalsDayMaxAskStyle,
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

  /** 인스턴스 전체 일괄 표시/숨김 — 패널의 추가·삭제가 쓰는 존재 토글이다.
   *  MA 의 `setAllMovingAveragesEnabled` 와 같은 규약(0개면 no-op). */
  setAllBrokerLateEntriesEnabled: (cur: IndicatorSettings, enabled: boolean): Patch =>
    (cur.brokerLateEntries.length === 0
      ? null
      : { brokerLateEntries: cur.brokerLateEntries.map((e) => ({ ...e, enabled })) }),

  /** 인스턴스 하나를 patch — 모르는 id 는 no-op. 기준 시각은 여기서 클램프한다. */
  setBrokerLateEntry: (
    cur: IndicatorSettings,
    id: string,
    patch: Partial<Omit<BrokerLateEntryConfig, 'id'>>,
  ): Patch => {
    const idx = cur.brokerLateEntries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const next = { ...cur.brokerLateEntries[idx], ...patch };
    if (patch.startHHMM !== undefined) {
      next.startHHMM = Number.isFinite(patch.startHHMM)
        ? normalizeBrokerLateEntryStartHHMM(patch.startHHMM)
        : BROKER_LATE_ENTRY_DEFAULT_START_HHMM;
    }
    if (patch.sideMode !== undefined
      && patch.sideMode !== 'both' && patch.sideMode !== 'buy' && patch.sideMode !== 'sell') {
      return null;
    }
    const arr = cur.brokerLateEntries.slice();
    arr[idx] = next;
    return { brokerLateEntries: arr };
  },

  /** 인스턴스 추가 — 기본값으로 생기되 **기준 시각만 어긋나게** 준다. 같은 시각의
   *  두 인스턴스는 같은 마커를 겹쳐 그려 아무 정보도 더하지 않으므로, 추가의 의도
   *  ("다른 시각대를 같이 본다")를 기본값이 미리 반영한다. 색은 MA 팔레트에서
   *  안 쓴 것을 골라 두 세트가 화면에서 구별된다. */
  addBrokerLateEntry: (cur: IndicatorSettings): Patch => {
    if (cur.brokerLateEntries.length >= BROKER_LATE_ENTRY_SLOT_LIMIT) return null;
    const last = cur.brokerLateEntries[cur.brokerLateEntries.length - 1];
    const used = new Set(cur.brokerLateEntries.map((e) => e.id));
    let id = 'ble-1';
    for (let i = 1; i <= BROKER_LATE_ENTRY_SLOT_LIMIT * 2; i++) {
      if (!used.has(`ble-${i}`)) { id = `ble-${i}`; break; }
    }
    const usedColors = new Set(cur.brokerLateEntries.flatMap((e) => [
      e.buyColor.toLowerCase(), e.sellColor.toLowerCase(),
    ]));
    const freeColor = MA_PALETTE.find((c) => !usedColors.has(c.toLowerCase()))
      ?? MA_PALETTE[cur.brokerLateEntries.length % MA_PALETTE.length];
    return {
      brokerLateEntries: [...cur.brokerLateEntries, {
        id,
        enabled: true,
        startHHMM: normalizeBrokerLateEntryStartHHMM(
          (last?.startHHMM ?? BROKER_LATE_ENTRY_DEFAULT_START_HHMM) + 100,
        ),
        sideMode: last?.sideMode ?? 'both',
        buyColor: freeColor,
        sellColor: freeColor,
      }],
    };
  },

  /** 인스턴스 삭제 — MA 와 같이 **마지막 하나도 지울 수 있다**(0개가 유효 상태). */
  removeBrokerLateEntry: (cur: IndicatorSettings, id: string): Patch => {
    const next = cur.brokerLateEntries.filter((e) => e.id !== id);
    return next.length === cur.brokerLateEntries.length ? null : { brokerLateEntries: next };
  },
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
