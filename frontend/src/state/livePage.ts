import { create } from 'zustand';
import { TIMEFRAME_TO_MS } from '../api/types';
import type { MASource } from '../chart/projectors/movingAverage';
import type { LineStyle, PaneId } from '../chart/drawing/types';
import { normalizePaneOrder, normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import {
  flattenPaneGroups,
  normalizePaneAxisMode,
  normalizePaneGroups,
  normalizePaneGroupStretch,
  paneGroupKey,
  paneGroupsFromOrder,
  type PaneAxisMode,
  type PaneAxisModeMap,
  type PaneGroups,
  type PaneGroupStretchMap,
} from '../chart/paneGroups';
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
  BROKER_LATE_ENTRY_SLOT_LIMIT,
  type BrokerLateEntryConfig,
  type BrokerLateEntrySideMode,
} from './liveIndicatorsPersistence';
import {
  FACTORY_INDICATOR_SETTINGS,
  INDICATORS_V2_STORAGE_KEY,
  cloneIndicatorBuckets,
  hasWindowIndicatorScope,
  loadIndicatorsV2Storage,
  persistIndicatorsV2,
  readIndicatorsV2Storage,
  resolveIndicatorSettings,
  INDICATOR_WINDOW_SCOPE_LIMIT,
  type IndicatorScope,
  type IndicatorSettings,
  type IndicatorSettingsByTimeframe,
} from './indicatorSettingsV2';
import { bindIndicatorOps, MA_PALETTE } from './indicatorOps';
import { applyPresetEnableByTimeframe } from './indicatorPresetOps';
import {
  dropIndicatorModalScopes,
  restoreIndicatorModalScopes,
  seedIndicatorModalScope,
  syncIndicatorModalTimeframe,
  type IndicatorModalByTimeframe,
} from './chartPrefs';
import {
  profileKeyForTimeframe,
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
  BROKER_LATE_ENTRY_SLOT_LIMIT,
};
export type {
  BrokerLateEntryConfig, BrokerLateEntrySideMode, LiveMAConfig, IndicatorSettings,
};
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

/**
 * `/live` 에서 열린 **저장 학습뷰의 기간** — 일봉이면 기간 밴드, 분봉이면 오른쪽 벽.
 *
 * 저장뷰 자체(`StudyViewListRow`)를 들지 않고 **원시 필드로 평탄화**한다. 이유는 두
 * 가지다. ① `api/studyViews` 가 여기서 `LiveTimeframe` 을 import 하므로 역방향
 * import 는 순환이다. ② 슬롯이 필요로 하는 것은 종목·구간·저장 당시 봉/줌뿐이고,
 * 메모·태그·타임스탬프까지 들면 저장뷰 스키마가 바뀔 때마다 `/live` 스토어가 흔들린다.
 * 변환은 생산부(`studyViews/savedRangeFocus.ts`)가 한다.
 *
 * **비영속이다.** `persistedPayload` 가 저장을 `Persisted` 5필드로 좁히므로 이 값은
 * `live.page.v1` 에 실리지 않는다 — `lastMinuteHistoricalFromDate` 와 같은 결이다.
 * 새로고침하면 해제되는 것이 의도다(저장뷰는 명시적으로 여는 것이지 복원 대상이 아니다).
 */
export type SavedRangeFocus = {
  viewId: string;
  code: string;
  label: string;
  /** 저장 구간 경계 실시각. 밴드·벽이 둘 다 이 두 값에서 나온다. */
  fromMs: number;
  toMs: number;
  /** 안내 문구용 YYYYMMDD. ms 에서 재유도하지 않고 저장뷰가 준 값을 그대로 쓴다. */
  fromDate: string;
  toDate: string;
  /** 저장 당시 봉. 창의 봉과 **다를 수 있다** — 그때 `savedBarSpan` 을 쓰면 안 된다. */
  savedTimeframe: LiveTimeframe;
  /** 저장 당시 가시 봉 수. 봉이 일치할 때만 유효하다(봉 수는 봉 종류에 상대적이다). */
  savedBarSpan: number;
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
/** 삭제 undo 토스트 1건 — 문구 + 되돌릴 대상(스코프·봉)과 되돌릴 값(patch). */
export type IndicatorUndoToast = {
  /** 토스트 문구. 예: "이동평균선 20 삭제됨". */
  label: string;
  /** **삭제 시점의** 스코프 — 그 창의 버킷으로 되돌린다. */
  scope: IndicatorScope;
  /** **삭제 시점의** 봉 — 그 버킷으로 되돌린다. */
  timeframe: LiveTimeframe;
  /** 삭제 직전 값(배열 전체 스냅샷). */
  patch: Partial<IndicatorSettings>;
};

type Store = Persisted & IndicatorSettings & {
  /** 사용자 소유 차트 pane 순서(전역 — 봉 무관, ADR-0114 §3 / #696).
   *  이제 `paneGroups` 의 평탄화 **투영**이다 — 두 필드는 모든 레이아웃 액션이
   *  함께 갱신하므로 어긋나지 않는다(flat 소비자 호환용으로 남는다). */
  paneOrder: PaneId[];
  /** pane 병합 그룹(순열+분할) — 레이아웃의 원본(`chart/paneGroups.ts`). */
  paneGroups: PaneGroups;
  /** 병합 그룹별 y축 모드 오버라이드(shared/isolated/left) — 키는 구성(정렬 join),
   *  없는 키는 화이트리스트 기본값(`resolveAxisMode`). */
  paneAxisMode: PaneAxisModeMap;
  /** 병합 그룹별 stretch 오버라이드 — 없는 키는 멤버 최대값 파생. */
  paneGroupStretch: PaneGroupStretchMap;
  /** 사용자 소유 Pane 크기 가중치(#703 — 전역, paneOrder 와 같은 레이아웃 슬라이스). */
  paneStretch: PaneStretchMap;
  /** 앱 전역 4버킷 sparse 오버라이드 원본 (`live.indicators.v2`). 창 세트의
   *  **시드·폴백 뿌리**다. (ADR-0146 의 페이지 축은 ADR-0157 로 걷혔다.) */
  indicatorsByTimeframe: IndicatorSettingsByTimeframe;
  /** **창별** 4버킷 원본. 키 = `live:<창id>` — 접두는 축이 아니라 **영속 키의
   *  화석**이다(`IndicatorScope` 주석). 키의 존재가 곧
   *  "이 창은 자기 세트를 갖는다"(ADR-0152 — `indicatorSettingsV2` 의 `byWindow`
   *  주석). 차트 창은 마운트 시드로 항상 엔트리를 갖고, 창이 사라지면 회수된다. */
  indicatorsByWindow: Record<string, IndicatorSettingsByTimeframe>;
  /** 지표 설정이 현재 투영된 봉 — 보는 차트의 timeframe 과 항상 일치해야 한다. */
  indicatorTimeframe: LiveTimeframe;
  /**
   * 인스턴스 삭제 undo 토스트의 트리거 데이터 — **런타임 전용**(영속 안 됨).
   *
   * 레전드 칩 ✕ 가 파괴적 원클릭이라 복구 수단이 인수 조건이다. 모델은 드로잉의
   * `clearToast` 선례를 그대로 복제한다: undo 스택 pop 이 아니라 **삭제 직전
   * 스냅샷을 되돌리는 평범한 변이**라, 토스트가 떠 있는 동안 다른 편집이 있었어도
   * 정확하고 그 복원 자체가 다시 undo 가능하다.
   *
   * `scope`·`timeframe` 은 **삭제 시점에 평가해 싣는다**(호출 시점 재평가 아님).
   * 토스트 중 사용자가 봉을 바꾸거나 다른 창을 포커스해도 복원이 원래 창×봉
   * 버킷에 착지해야 하기 때문이다.
   */
  indicatorUndoToast: IndicatorUndoToast | null;
  /** 삭제 시점 스냅샷을 슬롯에 싣는다(op 적용 **후** 호출). */
  setIndicatorUndoToast: (payload: IndicatorUndoToast) => void;
  /** 복원 없이 닫기(자동 소멸·수동 닫기). */
  dismissIndicatorUndoToast: () => void;
  /** 스냅샷을 되돌리고 닫는다 — 캡처된 스코프·봉으로 간다. */
  restoreIndicatorUndoToast: () => void;
  /** 페이지가 현재 봉을 공급한다(/live=candleTimeframe·/study=activeTab.timeframe). */
  setIndicatorTimeframe: (tf: LiveTimeframe) => void;
  /** 직전 분봉 뷰에서 팬으로 넓힌 historicalFromDate의 런타임 기억.
   *  분봉을 떠날 때 저장되고, 분봉 복귀 시 LiveChartRoot가 초기 뷰 배치 직후
   *  이 값으로 extendHistoricalRange를 1-샷 dispatch해 지표·캔들 커버리지를
   *  복원한다(캔들 병합 캐시와 수명 대칭). 전환 자체는 여전히
   *  historicalFromDate=null 리셋 — 초기 뷰 배치·번들 atomize 게이트가
   *  "fresh (code,tf) 로드 = null" 불변식에 기대기 때문. 종목/탭 전환 시 초기화.
   *  **런타임 전용이 이제 쓰기 경로에서도 참이다** — `persistedPayload` 가 저장을
   *  `Persisted` 5필드로 좁히므로 이 값은 `live.page.v1` 에 실리지 않는다(그전에는
   *  실리되 `readStorage` 화이트리스트가 무시해 재수화만 안 됐다). */
  lastMinuteHistoricalFromDate: string | null;
  /** `/live` 에서 열린 저장뷰의 기간 슬롯. **단일** — 다른 저장뷰를 열면 교체된다. */
  savedRangeFocus: SavedRangeFocus | null;
  focusSavedRange: (focus: SavedRangeFocus) => void;
  clearSavedRange: () => void;
  projectActiveView: (view: ActiveViewProjection) => void;
  setActiveCode: (code: string | null) => void;
  extendHistoricalRange: (date: string) => void;
  /** 좌측 팬 창을 **앞으로** 당긴다(축소) — `extend` 의 반대 방향.
   *
   *  `extend` 는 단조 감소 가드가 있어 창이 **뒤로만** 간다. 그래서 한 번 3개월까지
   *  넓히면 다시 줌인해도 안 줄어들고, 1시간을 보면서도 3개월치 지표 번들을 계속
   *  들고 있게 된다(2026-08-21 실측 sidecar 29.2MB). 이 액션이 그 단조성을 끊는다.
   *
   *  **진동 방지는 호출부 책임이다** — 이 값은 `indicatorCoverageFromDate` 로 되돌아와
   *  `planCoverageGapFill` 의 재요청 판정에 쓰이므로, 뷰포트 좌단보다 충분히 과거를
   *  줘야 한다(`useViewportBackfill` 의 히스테리시스 상수 참조). 여기서는 **뒤로 가는
   *  호출만 막는다**(그건 `extend` 의 일이다). */
  contractHistoricalRange: (date: string) => void;
  resetHistoricalRange: () => void;
  hydrateFromStorage: () => void;
  setMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addMovingAverage: () => void;
  removeMovingAverage: (id: string) => void;
  setAllMovingAveragesEnabled: (enabled: boolean) => void;
  setForeignNetEnabled: (enabled: boolean) => void;
  setInstitutionNetEnabled: (enabled: boolean) => void;
  /** 지정한 봉의 버킷에 pane 토글을 기록한다(레전드 ✕ 등 명시적 timeframe 호출용).
   *  ambient 봉과 같은 프로파일이면 투영도 함께 갱신된다. */
  setPanePrefForTimeframe: (timeframe: LiveTimeframe, key: PanePrefKey, enabled: boolean) => void;
  /** `setPanePrefForTimeframe` 의 스코프 판 — 한 창의 레전드 ✕ 가 다른 창이나
   *  다른 페이지의 세트를 건드리지 않게 한다. */
  setPanePrefScoped: (
    scope: IndicatorScope,
    timeframe: LiveTimeframe,
    key: PanePrefKey,
    enabled: boolean,
  ) => void;
  /** 지정한 (스코프 × 봉) 버킷에 지표 변경을 기록한다 — 각 창의 편집을 그 창의
   *  버킷으로 보내는 진입점(`windowView` 의 창 액션 백엔드). 스코프가 비면
   *  (Provider 밖 — 단일 차트·픽스처) `/live` 페이지 세트로 간다.
   *
   *  **최상위 투영은 `/live` 페이지 세트의 ambient 봉 값이다.** 그래서 창 쓰기와
   *  `/study` 쓰기는 투영을 절대 갱신하지 않는다 — 봉이 같다고 여기를 덮으면
   *  Provider 밖 소비자가 남의 창 설정을 보게 된다. */
  patchIndicatorsScoped: (
    scope: IndicatorScope,
    timeframe: LiveTimeframe,
    patch: Partial<IndicatorSettings>,
  ) => void;
  /** 지정한 (스코프 × 봉) 버킷의 오버라이드만 비운다 — `resetIndicators` 의 명시 판.
   *  **창 스코프에서는 엔트리를 지우지 않고 그 봉 버킷만 비운다** — 엔트리를 지우면
   *  그 창이 조용히 페이지 세트로 되붙어, 초기화가 사용자 모르게 연동을 만든다. */
  resetIndicatorsScoped: (scope: IndicatorScope, timeframe: LiveTimeframe) => void;
  /**
   * 이 창에 자기 세트를 심는다 — **이미 있으면 no-op**(멱등).
   *
   * 시드 소스는 ① `sourceWindowKey` 의 창 세트 ② 그 페이지 세트 순이다. ①이
   * 새 창 추가(포커스 창 복사), ②가 그 밖의 모든 경로(업그레이드 직후의 기존 창·
   * 프리셋 적용·딥링크 탭·기본 배치)다.
   *
   * 멱등이 계약인 이유: 창 컴포넌트의 마운트 effect 가 안전망으로 매번 부르는데,
   * 여기서 덮어쓰면 탭 전환·재마운트마다 사용자가 만진 값이 시드로 되돌아간다.
   */
  seedWindowIndicatorScope: (scope: IndicatorScope, sourceWindowKey?: string | null) => void;
  /** 프리셋 payload 의 창별 세트를 심는다 (ADR-0159) — **시드와 달리 무조건
   *  덮어쓴다**(프리셋 적용 = 저장된 값으로 교체). 두 스토어 동반이므로
   *  `chartPrefs` 의 modal 세트도 같은 호출로 함께 심는다. */
  restoreWindowIndicatorScopes: (
    entries: readonly {
      windowKey: string;
      indicators: IndicatorSettingsByTimeframe;
      modal: IndicatorModalByTimeframe;
    }[],
  ) => void;
  /** 사라진 창의 세트를 회수한다(창 닫힘·레이아웃 프리셋 적용·스냅샷 교체).
   *  **로드 시 일괄 청소는 하지 않는다** — 딥링크 탭은 워크스페이스를 공유 저장소에
   *  미러하지 않으므로(`workspace.ts` 의 `isDeepLinkTab`), 다른 탭이 스냅샷을 근거로
   *  쓸면 **살아 있는** 창의 설정을 지운다. */
  dropWindowIndicatorScopes: (scopeKeys: readonly string[]) => void;
  /** 다른 탭이 쓴 `live.indicators.v2` 를 다시 읽어 스토어를 맞춘다(crossTabSync).
   *  **되쓰지 않는다** — 재기록하면 그 storage 이벤트가 다시 다른 탭들을 깨운다. */
  hydrateIndicatorsFromStorage: () => void;
  /** pane 순서를 통째로 교체한다(candle 은 normalizePaneOrder 가 index 0 으로
   *  고정, ADR-0114 §3). **그룹을 싱글턴으로 리셋한다** — flat 순서를 쓰는
   *  호출자(프리셋·구 경로)는 병합 정보가 없으므로 순서가 곧 전체 레이아웃이다.
   *  병합을 보존하는 이동은 `setPaneGroups` 로 간다. */
  setPaneOrder: (order: PaneId[]) => void;
  /** pane 병합 그룹을 통째로 교체한다(레전드 ↑/↓·병합/분리 드래그의 결과).
   *  `paneOrder` 투영도 함께 갱신되고, 축 공유 오버라이드는 새 구성과 매칭되는
   *  키만 남긴다(해체된 그룹의 키는 자연 소멸). */
  setPaneGroups: (groups: PaneGroups) => void;
  /** 병합 그룹 하나의 y축 모드를 지정한다(칩 메뉴 「y축 공유/분리/왼쪽 축」). */
  setPaneAxisMode: (members: readonly PaneId[], mode: PaneAxisMode) => void;
  /** 병합 그룹 하나의 stretch 를 그룹 키에 기록한다(separator 드래그 캡처). */
  setPaneGroupStretch: (members: readonly PaneId[], factor: number) => void;
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
  setPeakWallPaneSlotEnabled: (
    side: 'ask' | 'bid',
    family: 'Traded' | 'Unreached' | 'AllWall',
    enabled: boolean,
  ) => void;
  setAskPeakEnabled: (enabled: boolean) => void;
  setAskPeakHidden: (hidden: boolean) => void;
  setAskPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setViLimitPriceLineStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
  setBidPeakEnabled: (enabled: boolean) => void;
  setBidPeakHidden: (hidden: boolean) => void;
  setBidPeakStyle: (patch: { color?: string; lineWidth?: 1 | 2 | 3 | 4 }) => void;
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
  setAllBrokerLateEntriesEnabled: (enabled: boolean) => void;
  setBrokerLateEntry: (id: string, patch: Partial<Omit<BrokerLateEntryConfig, 'id'>>) => void;
  addBrokerLateEntry: () => void;
  removeBrokerLateEntry: (id: string) => void;
  setDailyMovingAverage: (id: string, patch: Partial<LiveMAConfig>) => void;
  addDailyMovingAverage: () => void;
  removeDailyMovingAverage: (id: string) => void;
  setAllDailyMovingAveragesEnabled: (enabled: boolean) => void;
};

const DEFAULTS: Persisted = {
  activeInstrument: null,
  activeCode: null,
  candleTimeframe: '1m',
  lastMinuteTimeframe: '1m',
  historicalFromDate: null,
};

/**
 * 저장 페이로드를 `Persisted` 의 5필드로 **좁힌다**.
 *
 * ⚠ 이 좁힘이 load-bearing 이다. 호출부는 전부 `persist({ ...get(), ...next })` 형태인데
 * **스프레드 객체 리터럴은 TS 초과 프로퍼티 검사를 통과**하므로, 파라미터 타입이 5필드여도
 * 실제로는 스토어 전체가 들어온다. 그대로 `JSON.stringify` 하면 **되읽히지도 않는** 지표
 * flat 74개가 함께 실렸다 — 실측 85키 3,059B 중 유효분은 5키 119B 로, 나머지 96% 가
 * 사문이었다(그것도 공장 기본값 기준이고, 봉·종목·범위 전환마다 매번 쓴다).
 *
 * 되읽는 쪽은 원래 안전했다 — `readStorage` 가 같은 5키 화이트리스트다. 그래서 이 좁힘은
 * 낭비만 없애고 동작은 바꾸지 않는다. 이 키의 다른 리더인
 * `workspaceMigration.readLegacyWorkspaceSeed` 도 `activeInstrument`·`activeCode`·
 * `candleTimeframe`·`lastMinuteTimeframe` 넷만 읽어 전부 이 안에 있다.
 */
function persistedPayload(state: Persisted): Persisted {
  return {
    activeInstrument: state.activeInstrument,
    activeCode: state.activeCode,
    candleTimeframe: state.candleTimeframe,
    lastMinuteTimeframe: state.lastMinuteTimeframe,
    historicalFromDate: state.historicalFromDate,
  };
}

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedPayload(state)));
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
      paneGroups: s.paneGroups,
      paneAxisMode: s.paneAxisMode,
      paneGroupStretch: s.paneGroupStretch,
      paneStretch: s.paneStretch,
      byTimeframe: s.indicatorsByTimeframe,
      byWindow: s.indicatorsByWindow,
    });
  };

  /** 이 스코프가 편집할 대상이 창 엔트리인가 — 값이 아니라 **키의 존재**로
   *  판정한다(공장값 상태의 창은 `{}` 이고, 그건 유효한 자기 세트다). */
  const ownsWindowBuckets = (s: Store, scope: IndicatorScope): scope is IndicatorScope & {
    windowKey: string;
  } => hasWindowIndicatorScope(s.indicatorsByWindow, scope.windowKey);

  /** 스코프가 가리키는 버킷 맵을 통째로 교체하는 set patch 를 만든다. */
  const bucketsPatch = (
    s: Store,
    scope: IndicatorScope,
    buckets: IndicatorSettingsByTimeframe,
  ): Record<string, unknown> => {
    if (ownsWindowBuckets(s, scope)) {
      return { indicatorsByWindow: { ...s.indicatorsByWindow, [scope.windowKey]: buckets } };
    }
    return { indicatorsByTimeframe: buckets };
  };

  /**
   * 창 스코프 쓰기 **직전에** 그 창의 엔트리를 보장한다 — 없으면 페이지 세트에서
   * 심는다. 반환값은 심은 뒤의 fresh state.
   *
   * 왜 마운트 시드만으로 부족한가: `WindowViewValue` 를 만드는 곳은 창 컴포넌트
   * 둘만이 아니다(지표 드로어 둘이 더 있다). 편집 표면이 마운트 시드를 안 거친
   * 창을 향하면 쓰기가 **페이지 세트로 새고**, 증상은 "드로어에서 켰는데 차트가
   * 안 바뀜" 이다 — 사용자가 이 기능을 검수하는 바로 그 동작이 실패한다.
   * 그래서 보장을 컴포넌트 배선이 아니라 **쓰기 경로 한 곳**에 둔다.
   */
  const ensureWindowScope = (scope: IndicatorScope): Store => {
    const s = get();
    if (!scope.windowKey) return s;
    if (hasWindowIndicatorScope(s.indicatorsByWindow, scope.windowKey)) return s;
    get().seedWindowIndicatorScope(scope);
    return get();
  };

  const patchIndicatorsScoped = (
    scope: IndicatorScope,
    timeframe: LiveTimeframe,
    patch: Partial<IndicatorSettings>,
  ): void => {
    const s = ensureWindowScope(scope);
    const profileKey = profileKeyForTimeframe(timeframe);
    const owned = ownsWindowBuckets(s, scope);
    const source = owned
      ? s.indicatorsByWindow[scope.windowKey as string]
      : s.indicatorsByTimeframe;
    const buckets = { ...source, [profileKey]: { ...(source[profileKey] ?? {}), ...patch } };
    const next = bucketsPatch(s, scope, buckets);
    // 최상위 투영은 **앱 세트의** ambient 봉 값이다. 창 편집이 봉만 같다고 여기를
    // 덮으면 Provider 밖 소비자(단일 차트·픽스처)가 남의 창 설정을 본다.
    if (!owned && profileKey === profileKeyForTimeframe(s.indicatorTimeframe)) {
      Object.assign(next, patch);
    }
    set(next as Partial<Store>);
    persistIndicators();
  };

  /** Provider 밖(전역 경로) 스코프 — 앱 세트의 ambient 봉. */
  const AMBIENT_SCOPE: IndicatorScope = { windowKey: null };

  /** ambient 봉 버킷에 기록 — 지표 ops 55종의 기본 백엔드. */
  const patchIndicators = (patch: Partial<IndicatorSettings>): void => {
    patchIndicatorsScoped(AMBIENT_SCOPE, get().indicatorTimeframe, patch);
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
    paneGroups: initialIndicatorsV2.paneGroups,
    paneAxisMode: initialIndicatorsV2.paneAxisMode,
    paneGroupStretch: initialIndicatorsV2.paneGroupStretch,
    paneStretch: initialIndicatorsV2.paneStretch,
    indicatorsByTimeframe: initialIndicatorsV2.byTimeframe,
    indicatorsByWindow: initialIndicatorsV2.byWindow,
    indicatorTimeframe: initialPage.candleTimeframe,
    indicatorUndoToast: null,
    setIndicatorUndoToast: (payload) => set({ indicatorUndoToast: payload }),
    dismissIndicatorUndoToast: () => set({ indicatorUndoToast: null }),
    restoreIndicatorUndoToast: () => {
      const payload = get().indicatorUndoToast;
      if (!payload) return;
      // 캡처된 스코프·봉으로 되돌린다 — 지금 보고 있는 창/봉이 아니다.
      patchIndicatorsScoped(payload.scope, payload.timeframe, payload.patch);
      set({ indicatorUndoToast: null });
    },
    lastMinuteHistoricalFromDate: null,
    savedRangeFocus: null,

    // 지표 도메인 변이 setter 55종 — 시맨틱 SSOT 는 indicatorOps.ts (ADR-0119
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
      patchIndicatorsScoped(
        AMBIENT_SCOPE, timeframe, { [key]: enabled } as Partial<IndicatorSettings>,
      ),

    setPanePrefScoped: (scope, timeframe, key, enabled) =>
      patchIndicatorsScoped(scope, timeframe, { [key]: enabled } as Partial<IndicatorSettings>),

    setPaneOrder: (order) => {
      // flat 순서 쓰기 = 그룹 싱글턴 리셋 (액션 선언부 주석 참조) → 그룹 단위
      // 오버라이드(축 모드·그룹 stretch)도 매칭 그룹이 없어져 전부 걷힌다.
      const normalized = normalizePaneOrder(order);
      const groups = paneGroupsFromOrder(normalized);
      set({
        paneOrder: normalized,
        paneGroups: groups,
        paneAxisMode: normalizePaneAxisMode(get().paneAxisMode, groups),
        paneGroupStretch: normalizePaneGroupStretch(get().paneGroupStretch, groups),
      });
      persistIndicators();
    },

    setPaneGroups: (groups) => {
      const normalized = normalizePaneGroups(groups);
      set({
        paneGroups: normalized,
        paneOrder: flattenPaneGroups(normalized),
        // 새 구성과 매칭되는 키만 유지 — 해체·재구성된 그룹의 오버라이드는 기본값으로.
        paneAxisMode: normalizePaneAxisMode(get().paneAxisMode, normalized),
        paneGroupStretch: normalizePaneGroupStretch(get().paneGroupStretch, normalized),
      });
      persistIndicators();
    },

    setPaneAxisMode: (members, mode) => {
      if (members.length <= 1) return;
      set({
        paneAxisMode: {
          ...get().paneAxisMode,
          [paneGroupKey(members)]: mode,
        },
      });
      persistIndicators();
    },

    setPaneGroupStretch: (members, factor) => {
      if (members.length <= 1) return;
      if (!Number.isFinite(factor) || factor <= 0) return;
      set({
        paneGroupStretch: normalizePaneGroupStretch(
          { ...get().paneGroupStretch, [paneGroupKey(members)]: factor },
          get().paneGroups,
        ),
      });
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
        // 프리셋 payload 엔 그룹이 없다(레이아웃 프리셋은 flat 순서만 나른다) —
        // 적용 = 결정론적 교체이므로 그룹도 싱글턴으로 리셋되고 축 오버라이드도 걷힌다.
        paneGroups: paneGroupsFromOrder(nextPaneOrder),
        paneAxisMode: {},
        paneGroupStretch: {},
        paneStretch: nextPaneStretch,
        indicatorsByTimeframe: byTimeframe,
        ...resolveIndicatorSettings(byTimeframe, s.indicatorTimeframe),
      });
      persistIndicators();
    },

    patchIndicatorsScoped,

    resetIndicatorsScoped: (scope, timeframe) => {
      // 지정 봉 버킷만 공장값으로(#697). 레이아웃(paneOrder·paneStretch)은
      // 보존 — 크기 리셋은 프리셋 "기본 레이아웃으로 초기화"가 담당(#703).
      // 쓰기 경로와 같은 보장을 받는다 — 안 그러면 창의 "현재 봉 초기화" 가
      // 엔트리 없는 창에서 **앱 세트를** 지운다(모든 창에 번지는 사고).
      const s = ensureWindowScope(scope);
      const profileKey = profileKeyForTimeframe(timeframe);
      const next: Record<string, unknown> = {};
      if (ownsWindowBuckets(s, scope)) {
        // **엔트리는 남긴다** — 지우면 이 창이 앱 세트로 되붙어, 초기화가
        // 사용자 모르게 연동을 만든다(`byWindow` 주석의 멤버십 규약).
        const buckets = { ...s.indicatorsByWindow[scope.windowKey] };
        delete buckets[profileKey];
        next.indicatorsByWindow = { ...s.indicatorsByWindow, [scope.windowKey]: buckets };
      } else {
        const byTimeframe = { ...s.indicatorsByTimeframe };
        delete byTimeframe[profileKey];
        next.indicatorsByTimeframe = byTimeframe;
        if (profileKey === profileKeyForTimeframe(s.indicatorTimeframe)) {
          Object.assign(next, FACTORY_INDICATOR_SETTINGS);
        }
      }
      // 대기 중인 삭제 undo 는 여기서 무효화한다. 남겨 두면 리셋 직후의 실행취소가
      // 방금 공장값으로 돌린 버킷에 옛 슬롯 배열을 다시 심어, **리셋을 부분적으로
      // 되돌린다** — 사용자가 보기엔 "초기화했는데 이평선만 옛날 것" 이다.
      next.indicatorUndoToast = null;
      set(next as Partial<Store>);
      persistIndicators();
    },

    resetIndicators: () => {
      get().resetIndicatorsScoped(AMBIENT_SCOPE, get().indicatorTimeframe);
    },

    seedWindowIndicatorScope: (scope, sourceWindowKey) => {
      const key = scope.windowKey;
      if (!key) return;
      const s = get();
      // 멱등 — 마운트 effect 가 매번 부르므로, 여기서 덮으면 탭 전환·재마운트마다
      // 사용자가 만진 값이 시드로 되돌아간다.
      if (hasWindowIndicatorScope(s.indicatorsByWindow, key)) return;
      // 손상된 저장소가 창 엔트리를 무한 증식시키는 것을 막는다. 상한을 넘으면
      // 시드를 포기할 뿐이고, 그 창은 앱 세트를 보는 종전 동작으로 돈다.
      if (Object.keys(s.indicatorsByWindow).length >= INDICATOR_WINDOW_SCOPE_LIMIT) return;
      const fromWindow = sourceWindowKey ? s.indicatorsByWindow[sourceWindowKey] : undefined;
      const source = fromWindow ?? s.indicatorsByTimeframe;
      // 버킷 **객체까지** 새로 만든다 — 맵만 얕게 복사하면 두 창이 같은 버킷
      // 참조를 공유해, 한쪽 편집이 다른 쪽으로 샌다.
      set({ indicatorsByWindow: { ...s.indicatorsByWindow, [key]: cloneIndicatorBuckets(source) } });
      // 두 스토어의 멤버십은 항상 동반이다(ADR-0072) — 한쪽만 심으면 같은 드로어
      // 안에서 어떤 행은 창별, 어떤 행은 페이지 공유가 된다.
      seedIndicatorModalScope(scope, sourceWindowKey ?? null);
      persistIndicators();
    },

    restoreWindowIndicatorScopes: (entries) => {
      if (entries.length === 0) return;
      const s = get();
      const next = { ...s.indicatorsByWindow };
      const modalEntries: { windowKey: string; buckets: IndicatorModalByTimeframe }[] = [];
      for (const { windowKey, indicators, modal } of entries) {
        if (!windowKey) continue;
        // 상한은 **새 엔트리에만** — 이미 있는 키를 덮는 것은 맵을 키우지 않는다.
        if (!Object.hasOwn(next, windowKey)
          && Object.keys(next).length >= INDICATOR_WINDOW_SCOPE_LIMIT) continue;
        next[windowKey] = indicators;
        modalEntries.push({ windowKey, buckets: modal });
      }
      set({ indicatorsByWindow: next });
      // 두 스토어의 멤버십은 항상 동반이다(ADR-0072) — 한쪽만 심으면 같은 드로어
      // 안에서 어떤 행은 프리셋 값, 어떤 행은 옛 값이 된다.
      restoreIndicatorModalScopes(modalEntries);
      persistIndicators();
    },

    dropWindowIndicatorScopes: (scopeKeys) => {
      if (scopeKeys.length === 0) return;
      const s = get();
      const present = scopeKeys.filter((k) => Object.hasOwn(s.indicatorsByWindow, k));
      if (present.length === 0) return;
      const next = { ...s.indicatorsByWindow };
      for (const k of present) delete next[k];
      set({ indicatorsByWindow: next });
      dropIndicatorModalScopes(present);
      persistIndicators();
    },

    hydrateIndicatorsFromStorage: () => {
      const stored = readIndicatorsV2Storage();
      set({
        paneOrder: stored.paneOrder,
        paneGroups: stored.paneGroups,
        paneAxisMode: stored.paneAxisMode,
        paneGroupStretch: stored.paneGroupStretch,
        paneStretch: stored.paneStretch,
        indicatorsByTimeframe: stored.byTimeframe,
        // `/study` 세트도 함께 받는다 — 안 받으면 이 탭의 스토어엔 다른 탭이 바꾼
        // 값이 없고, 이 탭의 다음 편집이 `persistIndicators` 로 그것을 덮어 지운다.
        // 창 세트도 같은 이유로 함께 받는다. 이것이 #712 와 갈리는 지점이다 —
        // 창별 설정이 전역 저장소에 있으므로 크로스탭 동기화가 그대로 덮는다.
        indicatorsByWindow: stored.byWindow,
        ...resolveIndicatorSettings(stored.byTimeframe, get().indicatorTimeframe),
      });
    },

    focusSavedRange: (focus) => set({ savedRangeFocus: focus }),

    /**
     * 슬롯 해제. 호출부는 **명시적인 것만** 이어야 한다 — 칩 ×, 사용자의 종목 변경
     * (`activateLiveInstrument`), 창 드롭(`setWindowSymbol`).
     *
     * ⚠ **`projectActiveView` 에 걸지 말 것.** 거기엔 `mirrorActiveGroupToLivePage`
     * (창 포커스 전환 미러)도 들어와서, 다른 종목 창을 **클릭만 해도** 저장뷰가
     * 풀린다. 봉 전환도 트리거가 아니다 — 일봉 밴드와 분봉 벽은 같은 슬롯의 두
     * 표현이라 봉을 오갈 수 있어야 기능이 성립한다(2026-08-21 사용자 결정).
     */
    clearSavedRange: () => set({ savedRangeFocus: null }),

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

    extendHistoricalRange: (date) => {
      const cur = get().historicalFromDate;
      if (cur !== null && cur <= date) return; // already at or before this date
      set({ historicalFromDate: date });
      persist({ ...get(), historicalFromDate: date });
    },
    contractHistoricalRange: (date) => {
      const cur = get().historicalFromDate;
      // 뒤로 가는 호출은 무시한다 — 넓히는 건 extendHistoricalRange 의 일이다.
      if (cur === null || cur >= date) return;
      set({ historicalFromDate: date });
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
