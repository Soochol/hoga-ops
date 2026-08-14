import { create } from 'zustand';
import { TIMEFRAME_TO_MS } from '../api/types';
import type { MASource } from '../chart/projectors/movingAverage';
import type { LineStyle, PaneId } from '../chart/drawing/types';
import { normalizePaneOrder, normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import type { PresetEnableByTimeframe } from '../live/presets/presetFlags';
import {
  DEFAULT_LIVE_MAS,
  DEFAULT_DAILY_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  TRADE_VOLUME_POC_DEFAULT_BAND_PCT,
  TRADE_VOLUME_POC_DEFAULT_COLOR,
  TRADE_VOLUME_POC_DEFAULT_OPACITY,
  type LiveMAConfig,
  type BrokerLateEntrySideMode,
} from './liveIndicatorsPersistence';
import {
  FACTORY_INDICATOR_SETTINGS,
  INDICATORS_V2_STORAGE_KEY,
  loadIndicatorsV2Storage,
  persistIndicatorsV2,
  readIndicatorsV2Storage,
  resolveIndicatorSettings,
  type IndicatorSettings,
  type IndicatorSettingsByTimeframe,
} from './indicatorSettingsV2';
import { bindIndicatorOps, MA_PALETTE } from './indicatorOps';
import { applyPresetEnableByTimeframe } from './indicatorPresetOps';
import {
  attachIndicatorModalScope,
  detachIndicatorModalScope,
  dropIndicatorModalScopes,
  syncIndicatorModalTimeframe,
} from './chartPrefs';
import {
  profileKeyForTimeframe,
  type IndicatorPaneProfileKey,
  type PanePrefKey,
} from '../live/indicators/indicatorPaneProfiles';
import {
  instrumentToActiveCode,
  isLiveInstrument,
  stockInstrument,
  type LiveInstrument,
} from '../live/liveInstrument';
export type { MASource };

// Re-export so existing imports from `./livePage` keep working — single
// source of truth lives in `./liveIndicatorsPersistence` to break the
// circular import the persistence helper would otherwise have on the
// store module. ADR-0046.
export {
  DEFAULT_LIVE_MAS,
  DEFAULT_DAILY_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  TRADE_VOLUME_POC_DEFAULT_BAND_PCT,
  TRADE_VOLUME_POC_DEFAULT_COLOR,
  TRADE_VOLUME_POC_DEFAULT_OPACITY,
};
export type { BrokerLateEntrySideMode, LiveMAConfig, IndicatorSettings };
// 슬롯 색 palette 는 indicatorOps 로 이관 — 기존 임포트 호환 재수출.
export { MA_PALETTE };

/** Timeframes the live page supports.
 *
 * Backend (KIS) exposes only the base set directly: '1m', 'D', 'W', 'M'.
 * Aggregated minute frames (3m–60m) are computed client-side from the 1m
 * series; see ``aggregateCandles``. Daily/weekly/monthly frames render
 * the indicator pane empty (Addendum 9.4 — hoga indicators are intraday only). */
export const LIVE_TIMEFRAMES = [
  '1m', '3m', '5m', '10m', '15m', '30m', '60m', '120m', '240m', 'D', 'W', 'M',
] as const;
export type LiveTimeframe = (typeof LIVE_TIMEFRAMES)[number];

/** Server-side base timeframes (no client aggregation). */
export const BASE_TIMEFRAMES = ['1m', 'D', 'W', 'M'] as const;
export type BaseTimeframe = (typeof BASE_TIMEFRAMES)[number];

/** Minute subset of LiveTimeframe — round-trips to `/api/range` via wire
 * `bucket_ms`, gets the full 5-pane chart.
 *
 * ⚠ **60m 은 정규장 마감(15:30)이 버킷 경계가 아닌 첫 tf 다.** 1m~30m 은 전부 30분을
 * 나누므로 마감이 항상 경계였고, 정규장 봉과 시간외 봉이 한 버킷에 섞이는 일이
 * 구조적으로 불가능했다. 60m 의 `[15:00,16:00)` 은 그 경계를 가로지른다 — 실측상
 * 무해하지만(아래) **120m 이상은 무해하지 않다**. 2026-08-07 `005930` 실측, 정규장
 * 종가 대비 마감 포함 봉의 close 오차:
 *
 *   | tf   | KRX   | NXT    | UN     |
 *   |------|-------|--------|--------|
 *   | 60m  | 0.00% | −0.22% | 0.00%  |
 *   | 120m | 0.00% | +1.08% | +1.30% |
 *   | 240m | 0.00% | +1.08% | +1.30% |
 *
 * NXT·UN 은 08:00~19:59 를 통째로 싣는다. 60m 은 `[15:00,16:00)` 이 애프터마켓
 * 개시(16:00) 직전에서 끊겨 살아남지만, 120m `[15:00,17:00)` · 240m `[13:00,17:00)`
 * 은 애프터 1시간을 정규장 봉에 끌어들인다. 그래서 **그 둘만 집계 이전에 정규장으로
 * 클립한다**(`CLIPPED_TIMEFRAMES`) — 가상 축은 버킷 `t_ms` 로 admit 하므로 오염된
 * 봉을 걸러내지 못해 클립이 유일한 지점이다. */
export const MINUTE_TIMEFRAMES = [
  '1m', '3m', '5m', '10m', '15m', '30m', '60m', '120m', '240m',
] as const;
export type MinuteTimeframe = (typeof MINUTE_TIMEFRAMES)[number];

/** 과거봉·실시간 체결을 **집계 전에 정규장으로 클립**하는 tf.
 *
 * 왜 산술 조건(`23_400_000 % bucketMs === 0`, 즉 15:30 이 버킷 경계인가)이 아니라
 * 목록인가: 그 조건이면 **60m 도 걸린다**(23,400,000/3,600,000 = 6.5). 60m 는 실측
 * 오차가 0.00~0.22% 라 클립 없이 내보냈고(#1252), 산술 조건을 쓰면 그 결정이 조용히
 * 뒤집혀 60m 에서 시간외 봉이 사라진다. 동작을 바꾸는 것은 명시적이어야 한다.
 *
 * 클립하면 NXT·UN 의 프리마켓·애프터마켓 봉이 이 두 tf 에서만 사라진다 — 의도된
 * 비대칭이다. 240m 에서 시간외 전용 버킷은 `[05:00,09:00)` 에 1시간, `[17:00,21:00)`
 * 에 3시간만 들어 있어 폭이 버킷과 어긋난 봉이 되고, 넓은 tf 일수록 그 왜곡이 크다. */
export const CLIPPED_TIMEFRAMES = ['120m', '240m'] as const;

export function needsRegularSessionClip(tf: LiveTimeframe): boolean {
  return (CLIPPED_TIMEFRAMES as readonly string[]).includes(tf);
}

/** 표시 버킷 → **벤더에서 받을** 주기(ms).
 *
 * 지금까지 둘은 같았다(#1008: 표시 tf 를 그대로 `tic_scope` 로 요청). 120·240 이
 * 그 1:1 을 처음 깬다 — 키움 `ka10080` 이 안 주기도 하지만, **받아도 못 쓴다**:
 * 벤더 120m 봉은 `[15:00,17:00)` 이 이미 정규장+시간외 혼합이라 봉 단위로 클립할
 * 방법이 없다. 30m 로 받으면 15:30 이 입력에 경계로 남아(실측: KRX 30m 은 15:00 봉과
 * 15:30 봉이 분리) 클립이 성립하고, 120·240 경계는 30m 경계의 부분집합이라
 * `aggregateCandles` 가 걸치는 봉 없이 ×4·×8 로 접는다.
 *
 * 대가는 콜당 커버리지다 — 30m 는 900행에 ~34 거래일이라 60m(~128)의 1/4 이다.
 * `STEP_TRADING_DAYS` 가 이를 흡수한다(아래 주석). */
export function fetchBucketMsFor(tf: MinuteTimeframe): number {
  return needsRegularSessionClip(tf) ? 1_800_000 : TIMEFRAME_TO_MS[tf];
}

/** Calendar subset of LiveTimeframe — client-aggregated (`aggregateCalendar`),
 * candle + volume panes only (ADR-0041). */
export const CALENDAR_TIMEFRAMES = ['D', 'W', 'M'] as const;
export type CalendarTimeframe = (typeof CALENDAR_TIMEFRAMES)[number];

export function isMinuteTimeframe(tf: LiveTimeframe): tf is MinuteTimeframe {
  return (MINUTE_TIMEFRAMES as readonly string[]).includes(tf);
}

export function isCalendarTimeframe(tf: LiveTimeframe): tf is CalendarTimeframe {
  return (CALENDAR_TIMEFRAMES as readonly string[]).includes(tf);
}

/** Map a display timeframe to the base timeframe to fetch from the server.
 * Minute frames all source from '1m'; D/W/M pass through. */
export function baseFor(tf: LiveTimeframe): BaseTimeframe {
  if (tf === 'D' || tf === 'W' || tf === 'M') return tf;
  return '1m';
}

/** Bucket size in seconds for a minute display timeframe, or null for D/W/M
 * (calendar buckets — handled by the server). */
export function bucketSeconds(tf: LiveTimeframe): number | null {
  if (tf === '1m') return 60;
  if (tf === '3m') return 180;
  if (tf === '5m') return 300;
  if (tf === '10m') return 600;
  if (tf === '15m') return 900;
  if (tf === '30m') return 1800;
  if (tf === '60m') return 3600;
  if (tf === '120m') return 7200;
  if (tf === '240m') return 14400;
  return null;
}

const STORAGE_KEY = 'live.page.v1';
/** 공개 키 상수 — 워크스페이스 마이그레이션(ADR-0119 PR-C)이 레거시 시드로 읽는다. */
export const LIVE_PAGE_STORAGE_KEY = STORAGE_KEY;

type Persisted = {
  activeInstrument: LiveInstrument | null;
  activeCode: string | null;
  candleTimeframe: LiveTimeframe;
  lastMinuteTimeframe: MinuteTimeframe;
  /** Earliest stock-date the user has scrolled into (YYYYMMDD). null = today
   * only (no /api/range call needed yet). Resets when activeCode or timeframe
   * changes. */
  historicalFromDate: string | null;
};

/** The full active-view tuple the page renders. Written atomically by the active
 *  Live Tab (applyTabToPage → projectActiveView) so there is no setter ordering to
 *  get wrong (setActiveCode/setCandleTimeframe each reset historicalFromDate; an
 *  atomic write has nothing to reset-then-restore). */
export type ActiveViewProjection = {
  instrument?: LiveInstrument | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  /** 탭이 들고 온 분봉 창 기억. 생략(undefined) 시 레거시 derive 폴백
   *  (분봉이면 historicalFromDate, 아니면 null). */
  lastMinuteHistoricalFromDate?: string | null;
};

/**
 * 지표 슬라이스 (지도 #694 / 스펙 #699, PR-A).
 *
 * 최상위 `IndicatorSettings` 필드들은 항상 **`indicatorTimeframe` 으로 resolve 된
 * 값의 투영**이다 — 읽기 소비자(차트·드로어·레전드 수십 곳)는 무변경으로 현재
 * 봉의 설정을 본다(ADR-0113 "writer 만 교체" 패턴 재사용). 원본은
 * `indicatorsByTimeframe`(4버킷 sparse)이고, 세터는 ambient 버킷에 변경 필드만
 * 기록한 뒤 투영을 갱신한다. ambient 는 /live 가 candleTimeframe 으로,
 * /study 가 activeTab.timeframe 으로 `setIndicatorTimeframe` 을 통해 공급한다.
 */
type Store = Persisted & IndicatorSettings & {
  /** 사용자 소유 차트 pane 순서(전역 — 봉 무관, ADR-0114 §3 / #696). */
  paneOrder: PaneId[];
  /** 사용자 소유 Pane 크기 가중치(#703 — 전역, paneOrder 와 같은 레이아웃 슬라이스). */
  paneStretch: PaneStretchMap;
  /** 4버킷 sparse 오버라이드 원본 (`live.indicators.v2`). 공용 세트 — 분리되지
   *  않은 모든 창이 이것을 본다. */
  indicatorsByTimeframe: IndicatorSettingsByTimeframe;
  /** 공용 세트에서 분리된 창의 4버킷 원본. 키 = `live:<창id>`/`study:<창id>`,
   *  키의 존재가 곧 분리 멤버십(`indicatorSettingsV2` 의 `byWindow` 주석). */
  indicatorsByWindow: Record<string, IndicatorSettingsByTimeframe>;
  /** 지표 설정이 현재 투영된 봉 — 보는 차트의 timeframe 과 항상 일치해야 한다. */
  indicatorTimeframe: LiveTimeframe;
  /** 페이지가 현재 봉을 공급한다(/live=candleTimeframe·/study=activeTab.timeframe). */
  setIndicatorTimeframe: (tf: LiveTimeframe) => void;
  /** 직전 분봉 뷰에서 팬으로 넓힌 historicalFromDate의 런타임 기억.
   *  분봉을 떠날 때 저장되고, 분봉 복귀 시 LiveChartRoot가 초기 뷰 배치 직후
   *  이 값으로 extendHistoricalRange를 1-샷 dispatch해 지표·캔들 커버리지를
   *  복원한다(캔들 병합 캐시와 수명 대칭). 전환 자체는 여전히
   *  historicalFromDate=null 리셋 — 초기 뷰 배치·번들 atomize 게이트가
   *  "fresh (code,tf) 로드 = null" 불변식에 기대기 때문. 종목/탭 전환 시 초기화.
   *  persist 블롭(live.page.v1)에 직렬화는 되지만 readStorage 화이트리스트가
   *  무시하므로 재수화되지 않는다 — "런타임 전용"은 읽기 경로 기준. */
  lastMinuteHistoricalFromDate: string | null;
  projectActiveView: (view: ActiveViewProjection) => void;
  setActiveCode: (code: string | null) => void;
  setCandleTimeframe: (tf: LiveTimeframe) => void;
  extendHistoricalRange: (date: string) => void;
  resetHistoricalRange: () => void;
  hydrateFromStorage: () => void;
  setMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addMovingAverage: () => void;
  removeMovingAverage: (id: string) => void;
  setMovingAverageEnabled: (enabled: boolean) => void;
  setForeignNetEnabled: (enabled: boolean) => void;
  setInstitutionNetEnabled: (enabled: boolean) => void;
  /** 지정한 봉의 버킷에 pane 토글을 기록한다(레전드 ✕ 등 명시적 timeframe 호출용).
   *  ambient 봉과 같은 프로파일이면 투영도 함께 갱신된다. */
  setPanePrefForTimeframe: (timeframe: LiveTimeframe, key: PanePrefKey, enabled: boolean) => void;
  /** `setPanePrefForTimeframe` 의 스코프 판 — 분리된 창의 레전드 ✕ 가 공용 세트를
   *  건드리지 않게 한다. */
  setPanePrefScoped: (
    scopeKey: string | null,
    timeframe: LiveTimeframe,
    key: PanePrefKey,
    enabled: boolean,
  ) => void;
  /** 지정한 봉 버킷에 지표 변경을 기록한다 — 창마다 봉이 다른 멀티창에서 각 창의
   *  편집을 그 창의 봉 버킷으로 보내는 진입점(`windowView` 의 창 액션 백엔드).
   *  ambient 봉과 같은 프로파일일 때만 최상위 투영도 함께 갱신한다. */
  patchIndicatorsAt: (timeframe: LiveTimeframe, patch: Partial<IndicatorSettings>) => void;
  /** `patchIndicatorsAt` 의 스코프 판. `scopeKey`=null 이면 공용 세트(종전 동작),
   *  분리된 창이면 그 창의 버킷에만 쓴다. **분리 창 쓰기는 최상위 투영을 절대
   *  갱신하지 않는다** — 투영은 공용 세트의 ambient 봉 값이라, 창 편집이 여기를
   *  덮으면 Provider 밖 소비자(단일 차트·픽스처)가 남의 창 설정을 보게 된다. */
  patchIndicatorsScoped: (
    scopeKey: string | null,
    timeframe: LiveTimeframe,
    patch: Partial<IndicatorSettings>,
  ) => void;
  /** 지정한 봉 버킷의 오버라이드만 비운다 — `resetIndicators` 의 명시-봉 판. */
  resetIndicatorsAt: (timeframe: LiveTimeframe) => void;
  /** `resetIndicatorsAt` 의 스코프 판. 분리된 창의 "현재 봉 초기화"는 **그 창의
   *  버킷만** 비운다 — 공용으로 되돌리는 것은 `attachWindowIndicators` 라는 별개
   *  행동이다(초기화가 조용히 연동을 해제하면 되돌릴 방법이 없다). */
  resetIndicatorsScoped: (scopeKey: string | null, timeframe: LiveTimeframe) => void;
  /** 이 창을 공용 세트에서 분리한다 — 현재 공용 버킷 전체(4봉)를 복사해 심으므로
   *  분리 직후 화면이 바뀌지 않는다. 이미 분리됐으면 no-op(복사가 덮지 않는다). */
  detachWindowIndicators: (scopeKey: string) => void;
  /** 분리를 취소하고 공용 세트로 되돌린다 — 그 창의 오버라이드는 버려진다. */
  attachWindowIndicators: (scopeKey: string) => void;
  /** 사라진 창의 스코프를 회수한다(창 닫힘·레이아웃 프리셋 적용). 로드 시 일괄
   *  청소는 하지 않는다 — 딥링크 탭은 워크스페이스를 공유 저장소에 미러하지
   *  않으므로(`workspace.ts` 의 `isDeepLinkTab`), 다른 탭이 스냅샷을 근거로 쓸면
   *  **살아 있는** 창의 설정을 지운다. */
  dropWindowIndicatorScopes: (scopeKeys: readonly string[]) => void;
  /** 다른 탭이 쓴 `live.indicators.v2` 를 다시 읽어 스토어를 맞춘다(crossTabSync).
   *  **되쓰지 않는다** — 재기록하면 그 storage 이벤트가 다시 다른 탭들을 깨운다. */
  hydrateIndicatorsFromStorage: () => void;
  /** pane 순서를 통째로 교체한다(레전드 ↑/↓ 의 reorderVisible 결과; candle 은
   *  normalizePaneOrder 가 index 0 으로 고정, ADR-0114 §3). */
  setPaneOrder: (order: PaneId[]) => void;
  /** separator 드래그로 조정된 Pane 크기 가중치를 병합 저장한다(부분 patch —
   *  현재 안 마운트된 pane 의 저장값은 보존). */
  setPaneStretch: (patch: PaneStretchMap) => void;
  /** 레이아웃 프리셋의 지표 슬라이스를 한 번에 적용(단일 set + 단일 persist, ADR-0114 §4).
   *  대상은 **공용 세트뿐이다** — 분리된 창은 영향받지 않는다. 프리셋은 "모든
   *  창의 기본 구성"을 갈아끼우는 물건이고, 분리는 사용자가 그 창을 기본에서
   *  빼겠다고 명시한 상태라 프리셋이 그것을 덮으면 분리의 의미가 없다.
   *  #698·#699 PR-D: 프리셋 = 4버킷 전체 on/off 스냅샷. 각 봉 버킷의 enable
   *  오버라이드를 프리셋 값으로 **통째 교체**하되(결정론), 파라미터(색·기간)
   *  오버라이드는 보존한다(프리셋 범위 밖). paneStretch(레이아웃)도 함께 교체. */
  applyIndicatorPreset: (input: {
    paneOrder: PaneId[];
    byTimeframeEnable: PresetEnableByTimeframe;
    paneStretch: PaneStretchMap;
  }) => void;
  /** 현재 봉 버킷의 오버라이드만 비워 공장 기본값으로 되돌린다(#697 — 리셋은
   *  현재 봉만). 다른 봉·paneOrder(레이아웃)는 건드리지 않는다. chartPrefs 는
   *  별도 스토어라 호출부에서 함께 리셋한다. */
  resetIndicators: () => void;
  setVolumeEnabled: (enabled: boolean) => void;
  setMovingAverageHidden: (hidden: boolean) => void;
  setAskPeakEnabled: (enabled: boolean) => void;
  setAskPeakHidden: (hidden: boolean) => void;
  setAskPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setAskPeakAllPriceStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setAskPeakVisibleMaxStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setViLimitPriceLineStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setBidPeakEnabled: (enabled: boolean) => void;
  setBidPeakHidden: (hidden: boolean) => void;
  setBidPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setBidPeakAllPriceStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setTradeVolumePocEnabled: (enabled: boolean) => void;
  setTradeVolumePocHidden: (hidden: boolean) => void;
  setTradeVolumePocBandPct: (bandPct: number) => void;
  setTradeVolumePocStyle: (patch: { color?: string; opacity?: number }) => void;
  setDepthHeatmapEnabled: (enabled: boolean) => void;
  setDepthHeatmapHidden: (hidden: boolean) => void;
  setDepthHeatmapStyle: (patch: { bidColor?: string; askColor?: string; maxOpacity?: number }) => void;
  setVolumeDistributionEnabled: (enabled: boolean) => void;
  setVolumeDistributionHoverCutoffEnabled: (enabled: boolean) => void;
  setVolumeDistributionRangeCount: (count: number) => void;
  setVolumeDistributionStyle: (patch: { color?: string; maxColor?: string }) => void;
  setQuoteTotalsEnabled: (enabled: boolean) => void;
  setQuoteTotalsLevelLineEnabled: (enabled: boolean) => void;
  setQuoteTotalsBidLevelStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }) => void;
  setQuoteTotalsAskLevelStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }) => void;
  setRatioEnabled: (enabled: boolean) => void;
  setRatioLevelLineEnabled: (enabled: boolean) => void;
  setRatioLevelStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4; lineStyle?: LineStyle }) => void;
  setFillStrengthEnabled: (enabled: boolean) => void;
  setProgramTradeEnabled: (enabled: boolean) => void;
  setBrokerLateEntryEnabled: (enabled: boolean) => void;
  setBrokerLateEntryHidden: (hidden: boolean) => void;
  setBrokerLateEntryStartHHMM: (value: number) => void;
  setBrokerLateEntrySideMode: (mode: BrokerLateEntrySideMode) => void;
  setBrokerLateEntryStyle: (patch: { buyColor?: string; sellColor?: string }) => void;
  setDailyMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addDailyMovingAverage: () => void;
  removeDailyMovingAverage: (id: string) => void;
  setDailyMovingAverageEnabled: (enabled: boolean) => void;
  setDailyMovingAverageHidden: (hidden: boolean) => void;
};

const DEFAULTS: Persisted = {
  activeInstrument: null,
  activeCode: null,
  candleTimeframe: '1m',
  lastMinuteTimeframe: '1m',
  historicalFromDate: null,
};

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (SSR, privacy mode) — silent fallback.
  }
}

function isLiveTimeframe(v: unknown): v is LiveTimeframe {
  return typeof v === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(v);
}

function isMinuteFrameValue(v: unknown): v is MinuteTimeframe {
  return typeof v === 'string' && (MINUTE_TIMEFRAMES as readonly string[]).includes(v);
}

function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed) return {};
    const candleTimeframe = isLiveTimeframe(parsed.candleTimeframe) ? parsed.candleTimeframe : undefined;
    const derivedMinute = isMinuteFrameValue(parsed.lastMinuteTimeframe)
      ? parsed.lastMinuteTimeframe
      : isMinuteFrameValue(candleTimeframe)
        ? candleTimeframe
        : undefined;
    const next: Partial<Persisted> = {};
    if (isLiveInstrument(parsed.activeInstrument)) {
      next.activeInstrument = parsed.activeInstrument;
    } else if (typeof parsed.activeCode === 'string' && parsed.activeCode) {
      next.activeInstrument = stockInstrument(parsed.activeCode);
    } else if (parsed.activeInstrument === null || parsed.activeCode === null) {
      next.activeInstrument = null;
    }
    if (typeof parsed.activeCode === 'string' || parsed.activeCode === null) {
      next.activeCode = parsed.activeCode;
    } else if (next.activeInstrument !== undefined) {
      next.activeCode = instrumentToActiveCode(next.activeInstrument);
    }
    if (candleTimeframe !== undefined) {
      next.candleTimeframe = candleTimeframe;
    }
    if (derivedMinute !== undefined) {
      next.lastMinuteTimeframe = derivedMinute;
    }
    if (typeof parsed.historicalFromDate === 'string' || parsed.historicalFromDate === null) {
      next.historicalFromDate = parsed.historicalFromDate;
    }
    return next;
  } catch {
    return {};
  }
}


const initialIndicatorsV2 = loadIndicatorsV2Storage();
const initialPage = { ...DEFAULTS, ...readStorage() };

export const useLivePageStore = create<Store>((set, get) => {
  /** 세터 공통 경로: 변경 필드를 **지정한 봉**의 버킷에 기록하고 v2 로 영속한다.
   *  sparse 는 "공장값과의 diff" — 공장값과 같아진 항목은 다음 로드의 normalize 가
   *  걷어낸다(런타임 버킷은 단순 누적).
   *
   *  최상위 필드는 ambient 봉의 **투영**이므로 프로파일이 같을 때만 갱신한다.
   *  멀티창에서는 편집 대상 창의 봉이 ambient 와 다를 수 있는데, 거기서 최상위를
   *  덮으면 투영이 실제 버킷과 어긋난다(`setPanePrefForTimeframe` 과 같은 규율). */
  /** 지표 슬라이스 영속화 — **인자를 받지 않는다.**
   *
   *  호출부가 블롭을 손으로 조립하던 시절엔 축이 하나 늘 때마다 6개 호출부가
   *  조용히 낡았고, 그중 하나만 실행돼도 빠뜨린 축이 저장소에서 통째로 사라졌다
   *  (`setPaneOrder` 한 번에 창 분리 설정이 날아가는 모양). 스토어를 유일한
   *  원본으로 두면 그 실수가 구조적으로 불가능하다 — 새 축은 여기 한 곳만 고친다. */
  const persistIndicators = (): void => {
    const s = get();
    persistIndicatorsV2({
      paneOrder: s.paneOrder,
      paneStretch: s.paneStretch,
      byTimeframe: s.indicatorsByTimeframe,
      byWindow: s.indicatorsByWindow,
    });
  };

  /** 이 스코프가 편집하는 버킷 맵이 창 것인가(=분리됐는가). 값이 아니라 **키의
   *  존재**로 판정한다 — 공장값에서 분리하면 복사할 diff 가 없어 `{}` 다. */
  const isDetached = (s: Store, scopeKey: string | null): scopeKey is string =>
    scopeKey !== null && Object.hasOwn(s.indicatorsByWindow, scopeKey);

  const patchIndicatorsScoped = (
    scopeKey: string | null,
    timeframe: LiveTimeframe,
    patch: Partial<IndicatorSettings>,
  ): void => {
    const s = get();
    const profileKey = profileKeyForTimeframe(timeframe);
    const detached = isDetached(s, scopeKey);
    const source = detached ? s.indicatorsByWindow[scopeKey] : s.indicatorsByTimeframe;
    const buckets = { ...source, [profileKey]: { ...(source[profileKey] ?? {}), ...patch } };
    const next: Record<string, unknown> = detached
      ? { indicatorsByWindow: { ...s.indicatorsByWindow, [scopeKey]: buckets } }
      : { indicatorsByTimeframe: buckets };
    // 최상위 투영은 **공용 세트의** ambient 봉 값이다. 분리 창의 편집이 봉만 같다고
    // 여기를 덮으면 Provider 밖 소비자(단일 차트·픽스처)가 남의 창 설정을 보게 된다.
    if (!detached && profileKey === profileKeyForTimeframe(s.indicatorTimeframe)) {
      Object.assign(next, patch);
    }
    set(next as Partial<Store>);
    persistIndicators();
  };

  const patchIndicatorsAt = (
    timeframe: LiveTimeframe,
    patch: Partial<IndicatorSettings>,
  ): void => patchIndicatorsScoped(null, timeframe, patch);

  /** ambient 봉 버킷에 기록 — 지표 ops 45종의 기본 백엔드. */
  const patchIndicators = (patch: Partial<IndicatorSettings>): void => {
    patchIndicatorsAt(get().indicatorTimeframe, patch);
  };

  /** 봉 전환 시 투영 재계산. candleTimeframe 세터·페이지 동기화가 호출한다.
   *  chartPrefs 의 indicator-modal 투영(PR-B)도 같은 틱에 함께 맞춘다. */
  const projectIndicatorsFor = (tf: LiveTimeframe): Partial<Store> => {
    syncIndicatorModalTimeframe(tf);
    return {
      indicatorTimeframe: tf,
      ...resolveIndicatorSettings(get().indicatorsByTimeframe, tf),
    };
  };

  return {
    ...initialPage,
    ...resolveIndicatorSettings(initialIndicatorsV2.byTimeframe, initialPage.candleTimeframe),
    paneOrder: initialIndicatorsV2.paneOrder,
    paneStretch: initialIndicatorsV2.paneStretch,
    indicatorsByTimeframe: initialIndicatorsV2.byTimeframe,
    indicatorsByWindow: initialIndicatorsV2.byWindow,
    indicatorTimeframe: initialPage.candleTimeframe,
    lastMinuteHistoricalFromDate: null,

    // 지표 도메인 변이 setter 45종 — 시맨틱 SSOT 는 indicatorOps.ts (ADR-0119
    // C2c-2a). 전역 백엔드 = 호출 시점 fresh get() + ambient 봉 버킷 patch.
    ...bindIndicatorOps(() => get(), patchIndicators),

    setIndicatorTimeframe: (tf) => {
      // 같은 봉이어도 무조건 재투영 — 호출은 봉 전환·페이지 마운트 시뿐이라 싸고,
      // (테스트 등에서) 버킷이 setState 로 직접 주입된 경우의 투영 표류를 없앤다.
      if (!isLiveTimeframe(tf)) return;
      set(projectIndicatorsFor(tf));
    },

    // pane 토글은 "boolean 지표 필드 하나"라 일반 patch 와 시맨틱이 같다 —
    // 버킷 병합·투영 게이트·영속화가 전부 동일하므로 같은 경로로 보낸다.
    setPanePrefForTimeframe: (timeframe, key, enabled) =>
      patchIndicatorsScoped(null, timeframe, { [key]: enabled } as Partial<IndicatorSettings>),

    setPanePrefScoped: (scopeKey, timeframe, key, enabled) =>
      patchIndicatorsScoped(scopeKey, timeframe, { [key]: enabled } as Partial<IndicatorSettings>),

    setPaneOrder: (order) => {
      set({ paneOrder: normalizePaneOrder(order) });
      persistIndicators();
    },

    setPaneStretch: (patch) => {
      set({ paneStretch: normalizePaneStretch({ ...get().paneStretch, ...patch }) });
      persistIndicators();
    },

    applyIndicatorPreset: ({ paneOrder, byTimeframeEnable, paneStretch }) => {
      const s = get();
      // enable 15키 봉별 교체·파라미터 보존 — 순수 로직은 indicatorPresetOps 공유.
      const byTimeframe = applyPresetEnableByTimeframe(s.indicatorsByTimeframe, byTimeframeEnable);
      const nextPaneOrder = normalizePaneOrder(paneOrder);
      const nextPaneStretch = normalizePaneStretch(paneStretch);
      set({
        paneOrder: nextPaneOrder,
        paneStretch: nextPaneStretch,
        indicatorsByTimeframe: byTimeframe,
        ...resolveIndicatorSettings(byTimeframe, s.indicatorTimeframe),
      });
      persistIndicators();
    },

    patchIndicatorsAt,
    patchIndicatorsScoped,

    resetIndicatorsAt: (timeframe) => get().resetIndicatorsScoped(null, timeframe),

    resetIndicatorsScoped: (scopeKey, timeframe) => {
      // 지정 봉 버킷만 공장값으로(#697). 레이아웃(paneOrder·paneStretch)은
      // 보존 — 크기 리셋은 프리셋 "기본 레이아웃으로 초기화"가 담당(#703).
      const s = get();
      const profileKey = profileKeyForTimeframe(timeframe);
      const next: Record<string, unknown> = {};
      if (isDetached(s, scopeKey)) {
        // 분리된 창은 **자기 버킷만** 비운다. 공용으로 되돌리는 것은
        // `attachWindowIndicators` 라는 별개 행동이다 — 초기화가 조용히 연동을
        // 해제하면 사용자는 자기가 무엇을 잃었는지도 모른 채 되돌릴 수 없다.
        const buckets = { ...s.indicatorsByWindow[scopeKey] };
        delete buckets[profileKey];
        next.indicatorsByWindow = { ...s.indicatorsByWindow, [scopeKey]: buckets };
      } else {
        const byTimeframe = { ...s.indicatorsByTimeframe };
        delete byTimeframe[profileKey];
        next.indicatorsByTimeframe = byTimeframe;
        if (profileKey === profileKeyForTimeframe(s.indicatorTimeframe)) {
          Object.assign(next, FACTORY_INDICATOR_SETTINGS);
        }
      }
      set(next as Partial<Store>);
      persistIndicators();
    },

    detachWindowIndicators: (scopeKey) => {
      const s = get();
      if (Object.hasOwn(s.indicatorsByWindow, scopeKey)) return;
      // 버킷 **객체까지** 새로 만든다 — 맵만 얕게 복사하면 분리된 창과 공용 세트가
      // 같은 버킷 참조를 공유해, 이후 공용 편집이 분리 창으로 샌다.
      const copy: IndicatorSettingsByTimeframe = {};
      for (const [profileKey, bucket] of Object.entries(s.indicatorsByTimeframe)) {
        copy[profileKey as IndicatorPaneProfileKey] = { ...bucket };
      }
      set({ indicatorsByWindow: { ...s.indicatorsByWindow, [scopeKey]: copy } });
      persistIndicators();
      // 드로어의 호가 동작설정(급증 마커·극단값 필터 …)은 chartPrefs 소속이라
      // 같은 틱에 함께 분리한다 — 멤버십이 어긋나면 한 패널 안에서 절반만
      // 분리된 상태가 되고, 그 절반은 조용히 공용 세트로 샌다(ADR-0072).
      detachIndicatorModalScope(scopeKey);
    },

    attachWindowIndicators: (scopeKey) => {
      const s = get();
      if (!Object.hasOwn(s.indicatorsByWindow, scopeKey)) return;
      const byWindow = { ...s.indicatorsByWindow };
      delete byWindow[scopeKey];
      set({ indicatorsByWindow: byWindow });
      persistIndicators();
      attachIndicatorModalScope(scopeKey);
    },

    dropWindowIndicatorScopes: (scopeKeys) => {
      const s = get();
      const known = scopeKeys.filter((key) => Object.hasOwn(s.indicatorsByWindow, key));
      // chartPrefs 회수는 조건 없이 부른다 — 두 맵이 어긋난 상태(수동 setState 를
      // 쓰는 테스트·손상된 저장값)에서도 회수가 한쪽만 되고 끝나지 않게.
      dropIndicatorModalScopes(scopeKeys);
      if (known.length === 0) return; // 없는 키에 쓰기·persist 를 유발하지 않는다.
      const byWindow = { ...s.indicatorsByWindow };
      for (const key of known) delete byWindow[key];
      set({ indicatorsByWindow: byWindow });
      persistIndicators();
    },

    resetIndicators: () => {
      get().resetIndicatorsAt(get().indicatorTimeframe);
    },

    hydrateIndicatorsFromStorage: () => {
      const stored = readIndicatorsV2Storage();
      set({
        paneOrder: stored.paneOrder,
        paneStretch: stored.paneStretch,
        indicatorsByTimeframe: stored.byTimeframe,
        // 창 스코프도 함께 받는다 — 안 받으면 이 탭의 스토어엔 남의 분리 설정이
        // 없고, 이 탭의 다음 편집이 `persistIndicators` 로 그것을 덮어 지운다.
        indicatorsByWindow: stored.byWindow,
        ...resolveIndicatorSettings(stored.byTimeframe, get().indicatorTimeframe),
      });
    },

    projectActiveView: ({ instrument, code, timeframe, historicalFromDate, lastMinuteHistoricalFromDate }) => {
      // One atomic write — no reset-then-restore. tf is clamped like setCandleTimeframe
      // (belt-and-suspenders; callers already pass validated timeframes).
      const tf = LIVE_TIMEFRAMES.includes(timeframe) ? timeframe : get().candleTimeframe;
      const nextInstrument = instrument === undefined
        ? (code ? stockInstrument(code) : null)
        : instrument;
      const next = {
        activeInstrument: nextInstrument,
        activeCode: instrument === undefined
          ? code
          : (instrument === null && code === '' ? '' : instrumentToActiveCode(nextInstrument)),
        candleTimeframe: tf,
        lastMinuteTimeframe: isMinuteTimeframe(tf) ? tf : get().lastMinuteTimeframe,
        historicalFromDate,
        // 뷰 교체 시 이전 subject의 분봉 창 기억이 새 subject로 새지 않도록,
        // 투영되는 값으로 재시드한다(ADR-0113 단일 뷰 — liveNavigate가 null 전달).
        // 필드 생략(레거시 호출)이면 기존 derive 폴백: 분봉이면 pan, 아니면 null.
        lastMinuteHistoricalFromDate: lastMinuteHistoricalFromDate !== undefined
          ? lastMinuteHistoricalFromDate
          : (isMinuteTimeframe(tf) ? historicalFromDate : null),
      };
      // /live 의 ambient 지표 봉은 candleTimeframe 을 따른다 — 같은 원자적 쓰기로 투영.
      set({ ...next, ...projectIndicatorsFor(tf) });
      persist({ ...get(), ...next });
    },

    setActiveCode: (code) => {
      const activeInstrument = code ? stockInstrument(code) : null;
      set({
        activeInstrument,
        activeCode: code,
        historicalFromDate: null,
        lastMinuteHistoricalFromDate: null,
      });
      persist({ ...get(), activeInstrument, activeCode: code, historicalFromDate: null });
    },

    setCandleTimeframe: (tf) => {
      if (!LIVE_TIMEFRAMES.includes(tf)) return;
      const cur = get();
      const next = {
        candleTimeframe: tf,
        lastMinuteTimeframe: isMinuteTimeframe(tf) ? tf : cur.lastMinuteTimeframe,
        historicalFromDate: null,
        // 분봉을 떠나는 순간의 pan 창을 기억한다(분봉→분봉 전환 포함 — 같은 1m
        // 데이터의 재집계라 창 유지가 자연스럽다). 복원은 LiveChartRoot가 초기 뷰
        // 배치 직후 1-샷 dispatch — Store 타입의 필드 주석 참조.
        // `??` 폴백: 복원 dispatch가 아직 안 돈 창(빠른 D→분봉→재이탈, 콜드 로드
        // 배치 전)에는 historicalFromDate가 여전히 null이므로, null로 덮어쓰면
        // 기억이 영구 소실된다. hFD=null && 기억≠null은 그 "복원 대기" 상태뿐 —
        // 명시적 리셋은 resetHistoricalRange가 기억까지 직접 클리어하므로 폴백이
        // 리셋을 되살리는 일은 없다.
        lastMinuteHistoricalFromDate: isMinuteTimeframe(cur.candleTimeframe)
          ? cur.historicalFromDate ?? cur.lastMinuteHistoricalFromDate
          : cur.lastMinuteHistoricalFromDate,
      };
      set({ ...next, ...projectIndicatorsFor(tf) });
      persist({ ...get(), ...next });
    },

    extendHistoricalRange: (date) => {
      const cur = get().historicalFromDate;
      if (cur !== null && cur <= date) return; // already at or before this date
      set({ historicalFromDate: date });
      persist({ ...get(), historicalFromDate: date });
    },

    resetHistoricalRange: () => {
      set({ historicalFromDate: null, lastMinuteHistoricalFromDate: null });
      persist({ ...get(), historicalFromDate: null });
    },

    hydrateFromStorage: () => {
      const stored = readStorage();
      const merged = { ...DEFAULTS, ...stored };
      const lastMinuteTimeframe = stored.lastMinuteTimeframe
        ?? (isMinuteTimeframe(merged.candleTimeframe) ? merged.candleTimeframe : DEFAULTS.lastMinuteTimeframe);
      set({
        ...merged,
        lastMinuteTimeframe,
        ...projectIndicatorsFor(merged.candleTimeframe),
      });
    },
  };
});

// 콜드 로드: chartPrefs 의 indicator-modal 투영을 저장된 봉으로 1회 정렬(PR-B).
// (chartPrefs 스토어는 '1m' 투영으로 시작하고, 이후 전환은 projectIndicatorsFor 가 동기화.)
syncIndicatorModalTimeframe(initialPage.candleTimeframe);

/**
 * 다른 탭의 지표 변경을 받아 이 탭 스토어를 맞춘다 — `crossTabSync` 가 유일 호출자.
 *
 * 지표 설정은 사용자가 "앱 설정"으로 이해하는 값이라, 한 탭에서 바꾸면 열려 있는
 * 다른 탭도 리로드 없이 따라와야 한다(`crossTabSync` 도크스트링의 범위 기준).
 * `/live` 딥링크가 새 탭을 여는 구조라 낡은 탭은 예외가 아니라 평상 상태다.
 *
 * 재수화는 **되쓰지 않는다**(`hydrateIndicatorsFromStorage`) — 되쓰면 그 storage
 * 이벤트가 다시 상대 탭을 깨워 왕복이 멈추지 않는다.
 */
export function subscribeToIndicatorsStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== INDICATORS_V2_STORAGE_KEY) return;
    useLivePageStore.getState().hydrateIndicatorsFromStorage();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
