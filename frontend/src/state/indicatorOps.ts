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
import type { PeakWallPaneMode } from './liveIndicatorsPersistence';

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

/**
 * 강도 pane 슬롯 6칸(방향 × 계열)의 키.
 *
 * pane 의 존재가 이 여섯의 **OR** 이므로(`setPeakWallPaneSlotEnabled`), 한 칸을 움직일
 * 때마다 나머지 다섯을 읽어야 한다 — 좌표(방향 × 계열) 표와 평평한 목록을 함께 두는
 * 이유가 그것이다. 문자열로 조립하지 않는다: 오타가 타입을 통과하고, 「그 상태가
 * 어디서 읽히는가」를 grep 으로 못 찾게 된다.
 */
type PeakWallPaneSlotKey =
  | 'askPeakTradedPaneEnabled' | 'askPeakUnreachedPaneEnabled' | 'askPeakAllWallPaneEnabled'
  | 'bidPeakTradedPaneEnabled' | 'bidPeakUnreachedPaneEnabled' | 'bidPeakAllWallPaneEnabled';

const PEAK_WALL_PANE_SLOT_KEY: Record<
  'ask' | 'bid',
  Record<'Traded' | 'Unreached' | 'AllWall', PeakWallPaneSlotKey>
> = {
  ask: {
    Traded: 'askPeakTradedPaneEnabled',
    Unreached: 'askPeakUnreachedPaneEnabled',
    AllWall: 'askPeakAllWallPaneEnabled',
  },
  bid: {
    Traded: 'bidPeakTradedPaneEnabled',
    Unreached: 'bidPeakUnreachedPaneEnabled',
    AllWall: 'bidPeakAllWallPaneEnabled',
  },
};

const PEAK_WALL_PANE_SLOT_KEYS: readonly PeakWallPaneSlotKey[] = [
  'askPeakTradedPaneEnabled', 'askPeakUnreachedPaneEnabled', 'askPeakAllWallPaneEnabled',
  'bidPeakTradedPaneEnabled', 'bidPeakUnreachedPaneEnabled', 'bidPeakAllWallPaneEnabled',
];

const PEAK_WALL_PANE_SLOT_KEYS_BY_SIDE: Record<'ask' | 'bid', readonly PeakWallPaneSlotKey[]> = {
  ask: ['askPeakTradedPaneEnabled', 'askPeakUnreachedPaneEnabled', 'askPeakAllWallPaneEnabled'],
  bid: ['bidPeakTradedPaneEnabled', 'bidPeakUnreachedPaneEnabled', 'bidPeakAllWallPaneEnabled'],
};

/**
 * 강도 pane 에 **그릴 것이 있는가** — pane 마운트의 실효 조건.
 *
 * ## 이 술어가 생긴 이유
 *
 * pane 의 마운트 게이트는 오랫동안 `peakWallPaneEnabled` **하나만** 봤다
 * (`paneSpecsForTimeframe`). 그런데 그 안에 그려지는 계단은 `usePeakWallRender` 에서
 * `{side}PeakEnabled` 와 슬롯 키로 **한 번 더** 게이트된다. 두 게이트가 서로 다른
 * 질문에 답하고 있었던 것이고, 그래서 최대벽 지표를 끄면 계단만 사라지고
 * **빈 pane 이 남았다**(사용자 신고, 2026-09-03).
 *
 * 처방은 마스터를 쓰기 시점에 동기화하는 것이 **아니다**. 그러면 「왜 닫혔는지」를
 * 잊어버려서 되켤 때 돌아올 수 없다 — 지표를 되켜면 pane 도 함께 돌아와야 한다는 것이
 * 사용자 요구였다(2026-09-03). 그래서 마스터는 **사용자의 opt-in 의사**로 그대로 두고,
 * 마운트 게이트가 렌더 게이트와 **같은 곱**을 보게 한다. 파생이지 변이가 아니다.
 *
 * ## 방향과 슬롯을 함께 본다
 *
 * 매도·매수가 pane 하나를 공유하므로 판정은 방향별 곱의 OR 이다. 「방향의 OR × 슬롯의
 * OR」로 접으면 **매도 슬롯만 켠 채 매도를 끄고 매수를 켠** 조합에서 빈 pane 이 남는다.
 *
 * ## `hidden` 은 보지 않는다
 *
 * 렌더 게이트(`usePeakWallRender`)가 `enabled` 만 읽기 때문이다 — 오버레이를 눈으로
 * 숨겨도 계단은 그려진다. 여기서 `hidden` 을 곱하면 두 게이트가 다시 갈린다.
 */
export function peakWallPaneHasContent(cur: IndicatorSettings): boolean {
  if (!cur.peakWallPaneEnabled) return false;
  return (['ask', 'bid'] as const).some((side) => (
    (side === 'ask' ? cur.askPeakEnabled : cur.bidPeakEnabled)
    && PEAK_WALL_PANE_SLOT_KEYS_BY_SIDE[side].some((k) => cur[k])
  ));
}

/**
 * 봉별 모드에서 **이 계열의 배열을 실제로 요청해야 하는가**.
 *
 * `peakWallPaneHasContent`(pane 이 뜨는가)보다 좁다 — 계열까지 본다. 두 계열의 wire
 * 배열이 **크기가 크게 다르기 때문**이다: 체결 계열은 터치가 있었던 봉만이지만 전체
 * 계열은 **호가가 있던 모든 봉**에 값이 있다. 게이트를 하나로 묶으면 체결 슬롯만 켠
 * 창이 전체 배열까지 받는다(`/api/range` 의 `all_bar_peaks_enabled` 가 이 값을 탄다).
 *
 * 모드가 `step` 이면 어느 계열도 요청하지 않는다 — 계단은 이 배열을 안 쓴다.
 */
export function peakWallBarFamilyActive(
  cur: IndicatorSettings, family: 'Traded' | 'AllWall',
): boolean {
  if (cur.peakWallPaneMode !== 'bar' || !cur.peakWallPaneEnabled) return false;
  return (['ask', 'bid'] as const).some((side) => (
    (side === 'ask' ? cur.askPeakEnabled : cur.bidPeakEnabled)
    && cur[PEAK_WALL_PANE_SLOT_KEY[side][family]]
  ));
}

/** 한 칸만 담은 패치. 계산된 키(`{ [key]: value }`)를 쓰면 TS 가 `{ [k: string]: boolean }`
 *  으로 넓혀 `Partial<IndicatorSettings>` 에 붙지 않으므로 여섯을 명시로 편다. */
function paneSlotPatch(key: PeakWallPaneSlotKey, value: boolean): Partial<IndicatorSettings> {
  switch (key) {
    case 'askPeakTradedPaneEnabled': return { askPeakTradedPaneEnabled: value };
    case 'askPeakUnreachedPaneEnabled': return { askPeakUnreachedPaneEnabled: value };
    case 'askPeakAllWallPaneEnabled': return { askPeakAllWallPaneEnabled: value };
    case 'bidPeakTradedPaneEnabled': return { bidPeakTradedPaneEnabled: value };
    case 'bidPeakUnreachedPaneEnabled': return { bidPeakUnreachedPaneEnabled: value };
    case 'bidPeakAllWallPaneEnabled': return { bidPeakAllWallPaneEnabled: value };
  }
}

/** 이 칸만 켜고 나머지 다섯을 끈 패치 — **닫혀 있던 pane 을 여는 클릭**이 쓴다.
 *  왜 저장값을 살리지 않는지는 `setPeakWallPaneSlotEnabled` 의 주석에 있다. */
function onlyPaneSlot(key: PeakWallPaneSlotKey): Partial<IndicatorSettings> {
  return {
    askPeakTradedPaneEnabled: key === 'askPeakTradedPaneEnabled',
    askPeakUnreachedPaneEnabled: key === 'askPeakUnreachedPaneEnabled',
    askPeakAllWallPaneEnabled: key === 'askPeakAllWallPaneEnabled',
    bidPeakTradedPaneEnabled: key === 'bidPeakTradedPaneEnabled',
    bidPeakUnreachedPaneEnabled: key === 'bidPeakUnreachedPaneEnabled',
    bidPeakAllWallPaneEnabled: key === 'bidPeakAllWallPaneEnabled',
  };
}

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
  'broker-late-entry',
] as const;

export type FlagIndicatorType = (typeof FLAG_INDICATOR_TYPES)[number];

/** flag 지표의 사용자 표시명 — 레전드 라벨·undo 문구·설정 패널이 공유한다. */
export const FLAG_INDICATOR_LABEL: Record<FlagIndicatorType, string> = {
  'ask-peak': '당일 매도 최대벽',
  'bid-peak': '당일 매수 최대벽',
  'trade-volume-poc': '당일 최대 매물대',
  'depth-heatmap': '호가 잔량 히트맵',
  'broker-late-entry': '신규 거래원 등장',
};

/**
 * 각 flag 지표가 **소유한 설정 필드 전부** — 삭제(=공장값 리셋)의 대상 집합.
 *
 * 손으로 적는다. 접두사 매칭 같은 자동 발견을 쓰지 않는 이유는 이 리포가 이미
 * 판정한 것과 같다: 이름 규칙 매칭은 **오탐과 누락이 둘 다 조용하다**. 대신
 * `indicatorOps.flagFields.test.ts` 가 "flag 접두를 가진 `IndicatorSettings` 키는
 * 정확히 한 목록에 속한다" 를 강제한다 — 새 필드가 늘면 그 가드가 빨개진다.
 * 이 가드는 실제로 **네 번** 잡았다: #1582 의 `askPeakAllWall*` 3필드, #1588 의
 * `*Unreached*` 6필드, 설정 재구성의 `*PeakTradedLineEnabled` 2필드, 그리고 강도 pane
 * 슬롯의 `*Pane Enabled` 6필드(앞 셋은 전부 병행 PR 이라 텍스트 충돌 없이 머지됐다). 손 목록의 위험이
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
    // 강도 pane 슬롯 — 이 지표가 사라지면 pane 구성도 함께 공장값으로 돌아간다.
    'askPeakTradedPaneEnabled', 'askPeakUnreachedPaneEnabled', 'askPeakAllWallPaneEnabled',
  ],
  'bid-peak': [
    'bidPeakEnabled', 'bidPeakHidden', 'bidPeakColor', 'bidPeakLineWidth',
    'bidPeakTradedLineEnabled',
    'bidPeakAllWallLineEnabled', 'bidPeakAllWallColor', 'bidPeakAllWallLineWidth',
    'bidPeakUnreachedLineEnabled', 'bidPeakUnreachedColor', 'bidPeakUnreachedLineWidth',
    'bidPeakTradedPaneEnabled', 'bidPeakUnreachedPaneEnabled', 'bidPeakAllWallPaneEnabled',
  ],
  'trade-volume-poc': [
    'tradeVolumePocEnabled', 'tradeVolumePocHidden', 'tradeVolumePocBandPct',
    'tradeVolumePocColor', 'tradeVolumePocOpacity',
  ],
  'depth-heatmap': [
    'depthHeatmapEnabled', 'depthHeatmapHidden', 'depthHeatmapBidColor',
    'depthHeatmapAskColor', 'depthHeatmapMaxOpacity',
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
  /**
   * 강도 pane 의 슬롯 6칸(방향 × 계열) — 캔들 선 토글과 독립이다
   * (`liveIndicatorsPersistence` 의 `askPeakTradedPaneEnabled` 주석). 키를 문자열로
   * 조립하지 않는 이유는 이 파일의 나머지와 같다 — 오타가 타입을 통과한다.
   *
   * ## pane 의 존재 = 여섯 칸의 OR (2026-08-27, 사용자 결정)
   *
   * 마스터(`peakWallPaneEnabled`)는 더 이상 사람이 직접 미는 스위치가 아니다.
   * 설정 패널 ⑤ 의 토글을 없애고 **이 op 이 마스터를 관리한다** — 칸이 하나라도
   * 켜지면 pane 이 있고, 여섯이 다 꺼지면 없다. 종전엔 켜기만 마스터를 열었고
   * 끄기는 건드리지 않아, 「칸은 다 껐는데 빈 pane 이 남는」 상태가 있었다.
   *
   * **판정은 여섯 전부다 — 화면에 보이는 셋이 아니다.** pane 은 매도·매수가 공유하는
   * 하나라, 매수 칸이 켜져 있는 동안 매도 셋을 다 꺼도 pane 은 남아야 한다(그 안에
   * 매수 계단이 있다). 그 사실은 ⑤ 의 요약 줄이 화면에서 말한다.
   *
   * ## 닫혀 있던 pane 을 여는 클릭은 **그 칸 하나만** 넣는다
   *
   * 공장값이 양방향 체결된 벽 슬롯을 켜 둔 채라(`liveIndicatorsPersistence`), 단순히
   * 마스터만 열면 「미도달 벽 하나를 켰는데 계단이 셋 뜨는」 일이 생긴다 — 저장돼
   * 있던 두 칸이 함께 되살아나기 때문이다. 켜기와 끄기가 대칭이려면(끄면 그것만,
   * 켜면 그것만) 여는 순간에 나머지 다섯을 함께 닫아야 한다.
   *
   * 그 대가로 **접혀 있던 저장값은 다음 arm 에서 버려진다**. 설정 패널의 요약 줄이
   * 「되켜면 무엇이 돌아오는지」를 말하지 않고 **지금 들어 있는 것만** 말하는 이유다.
   *
   * ⚠ **「닫힘」이 두 종류가 됐다**(2026-09-03). 위 문단은 **마스터가 닫힌** 경우다.
   * 방향이 꺼져서 pane 이 안 보이는 것은 다른 닫힘이고, 그때 슬롯은 **그대로 보존
   * 된다** — 방향을 되켜면 pane 이 저장돼 있던 칸과 함께 돌아온다. 그게 사용자가
   * 요구한 대칭이고(`peakWallPaneHasContent`), 그래서 여는 분기의 판정을 「내용이
   * 있는가」로 넓히지 **않았다**. 넓히면 방향-닫힘도 다섯 칸을 버리게 된다.
   *
   * ## 켜는 클릭은 **그 방향도 켠다**
   *
   * 이 스위치의 이름은 「pane 에 추가」이므로 켰는데 아무 일도 안 일어나면 안 된다.
   * 그런데 계단은 `{side}PeakEnabled` 로도 게이트되므로(`usePeakWallRender`), 방향이
   * 꺼진 채로는 슬롯과 마스터를 다 열어도 화면이 그대로다. 마스터를 함께 여는 것과
   * 같은 근거로 방향도 함께 연다 — 캔들 오버레이 선이 함께 나타나는 것이 대가다.
   *
   * 한 패치에 담는 이유는 `setAskPeakEnabled` 가 `askPeakHidden: false` 를 함께 쓰는
   * 것과 같다 — undo 한 항목, 프리셋 경로에서도 결합 유지.
   */
  /**
   * 강도 pane 의 표현 모드 — `step`(누적 계단) ↔ `bar`(봉별 최대 체결 벽).
   *
   * **슬롯을 건드리지 않는다.** 모드는 "같은 벽들을 어느 축으로 읽는가" 이지 "무엇을
   * 넣는가" 가 아니고, 두 축이 pane 하나를 공유하는 것이 `PeakWallPaneMode` 의 전제다.
   * 모드를 바꿨다고 칸이 열리거나 닫히면 되돌릴 때 원래 조합이 사라진다.
   *
   * pane 이 닫혀 있어도 기록한다 — 여는 클릭이 저장된 모드를 그대로 쓴다.
   */
  setPeakWallPaneMode: (cur: IndicatorSettings, mode: PeakWallPaneMode): Patch =>
    (cur.peakWallPaneMode === mode ? null : { peakWallPaneMode: mode }),

  setPeakWallPaneSlotEnabled: (
    cur: IndicatorSettings,
    side: 'ask' | 'bid',
    family: 'Traded' | 'Unreached' | 'AllWall',
    enabled: boolean,
  ): Patch => {
    const key = PEAK_WALL_PANE_SLOT_KEY[side][family];
    if (!enabled) {
      // 마지막 칸이면 pane 이 사라진다 — 나머지 다섯을 읽어 판정한다.
      const othersOn = PEAK_WALL_PANE_SLOT_KEYS.some((k) => k !== key && cur[k]);
      return { ...paneSlotPatch(key, false), peakWallPaneEnabled: othersOn };
    }
    // 방향도 함께 연다(위 주석). `Hidden: false` 를 같이 쓰는 것은
    // `setAskPeakEnabled` 의 켜는 분기와 같은 결합 — 눈이 감긴 채 되살아나지 않게.
    const sideOn = side === 'ask'
      ? { askPeakEnabled: true, askPeakHidden: false }
      : { bidPeakEnabled: true, bidPeakHidden: false };
    if (!cur.peakWallPaneEnabled) {
      return { ...onlyPaneSlot(key), ...sideOn, peakWallPaneEnabled: true };
    }
    return { ...paneSlotPatch(key, true), ...sideOn, peakWallPaneEnabled: true };
  },
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
