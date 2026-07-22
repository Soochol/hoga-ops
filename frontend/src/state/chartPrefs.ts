/**
 * Declarative registry of boolean chart toggles. Each entry surfaces in the
 * ⚙️ Settings modal OR (for `category: 'indicator-modal'` entries) the 「지표」
 * modal's hoga Configs, depending on category. Each entry is the single source
 * of truth for one toggle: its key (used as a `ChartViewPrefs` field), default
 * value, and UI strings.
 *
 * Adding a toggle = one entry here. The type below (`ChartToggleKey`),
 * the `ChartViewPrefs` boolean fields, the default values, and the toggle row
 * rendering all derive from this list.
 */
export const CHART_TOGGLES = [
  {
    key: 'auctionWindowMask',
    label: '동시호가 구간 지표 숨김',
    description: '15:20–15:30 KST 동시호가 구간에서 호가비·호가총합·체결강도를 표시하지 않습니다. (캔들/거래량 제외)',
    default: true,
  },
  {
    key: 'dayBoundaryEnabled',
    label: '날짜 구분선',
    description: '분봉 차트에서 거래일이 바뀌는 지점에 세로 점선을 표시합니다.',
    default: true,
  },
  {
    key: 'horizontalGridLinesEnabled',
    label: '가로 구분선',
    description: '차트 배경의 가격축 방향 가로 격자선을 표시합니다.',
    default: true,
  },
  {
    key: 'verticalGridLinesEnabled',
    label: '세로 구분선',
    description: '차트 배경의 시간축 방향 세로 격자선을 표시합니다.',
    default: true,
  },
  {
    key: 'candlePaneCandleOnlyScale',
    label: '캔들 기준 Y축',
    description: '캔들 pane의 가격축을 캔들 고가·저가 기준으로만 맞춥니다. 이동평균선 등 상단 지표는 축 범위를 넓히지 않습니다.',
    default: false,
  },
  {
    key: 'candleAlwaysOnTop',
    label: '캔들이 항상 위',
    description: '캔들 pane에서 이동평균선 등 같은 pane의 보조 지표보다 캔들을 위에 그립니다.',
    default: false,
  },
  {
    key: 'ratioOutlierFilterEnabled',
    label: '호가비 극단값 필터',
    description:
      '한쪽 호가가 임계 배수를 넘으면 그 시점의 호가비를 0 으로 마스킹합니다. (오토스케일을 잡아먹는 스파이크 제거)',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'fillStrengthCumulative',
    label: '체결강도 — 당일 누적',
    description:
      '체결강도 pane에 당일 누적 매수−매도 라인(체결강도 누적)을 표시합니다. 거래일마다 0에서 다시 시작.',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'volumeFillStrengthCumulative',
    label: '거래량 — 체결강도 누적',
    description:
      '거래량 판에서 체결강도 누적(매수−매도)을 상대값으로 표시합니다. 거래량 y축 기준으로 스케일링됩니다.',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'candleTooltipEnabled',
    label: '캔들 정보 툴팁',
    description: '캔들에 마우스를 올리면 시·고·저·종·직전대비·거래량·거래량비를 툴팁으로 표시합니다.',
    default: false,
  },
  {
    key: 'highLowLabelsEnabled',
    label: '고저 극값 라벨',
    description:
      '현재 보이는 차트 범위의 최고가·최저가 봉에 현재가의 극값 대비율(가격·%·시각) 라벨을 표시합니다. (고가=빨강, 저가=파랑)',
    default: true,
  },
  {
    key: 'viLimitPriceDotsEnabled',
    label: 'VI/상하한가 선',
    description: '가격이 VI 가격대 또는 상하한가에 닿은 경우 캔들 차트에 가격선으로 표시합니다.',
    default: true,
  },
  {
    key: 'surgeMarkerEnabled',
    label: '총잔량 급증 마커',
    description: '매도/매수총잔량이 당일 직전 고가에 다시 근접(기본 95%)하는 순간 총잔량 라인에 마커를 표시합니다. 한 번 표시 후 직전 고가의 85% 아래로 빠져야 재표시(히스테리시스).',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'quoteTotalsIntraMax',
    label: '분봉 내 최댓값 기준',
    description: '그 분의 마지막값(종가) 대신 분봉 내 최대 총잔량을 표시합니다. (캔들 고가와 같은 직관)',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'ratioIntraMax',
    label: '분봉 내 최댓값 기준',
    description:
      '그 분 중 |호가비|가 가장 컸던 순간값을 표시합니다(부호 유지). 극단값 필터가 켜져 있으면 스파이크는 0으로 가려질 수 있습니다 — 날것을 보려면 필터를 끄세요.',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakIntraMax',
    label: '분봉 내 최댓값 기준',
    description:
      '분봉 종가 호가창 대신 분봉 내 순간 최대 매도벽까지 포함해 당일 최대벽을 찾습니다(과거 거래일에만 효과 — 오늘은 항상 실시간 최댓값).',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakShowAllPrices',
    label: '미체결 최대 매도벽 표시',
    description: '체결된 벽과 미체결된 벽을 각각 표시합니다.',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakLabelEnabled',
    label: '최대벽 라벨 표시',
    description: '당일 매도 최대벽 라벨을 차트 오른쪽에 표시합니다. 끄면 수평선은 그대로 두고 라벨만 숨깁니다.',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakVisibleTimeCutoff',
    label: '보이는 최신 봉 기준',
    description: '오른쪽 끝에 보이는 분봉 시각까지의 후보만 사용해 당일 매도 최대벽을 계산합니다.',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakIntraMax',
    label: '분봉 내 최댓값 기준',
    description:
      '분봉 종가 호가창 대신 분봉 내 순간 최대 매수벽까지 포함해 당일 최대벽을 찾습니다(과거 거래일에만 효과 — 오늘은 항상 실시간 최댓값).',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakShowAllPrices',
    label: '미체결 최대 매수벽 표시',
    description: '체결된 벽과 미체결된 벽을 각각 표시합니다.',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakLabelEnabled',
    label: '최대벽 라벨 표시',
    description: '당일 매수 최대벽 라벨을 차트 오른쪽에 표시합니다. 끄면 수평선은 그대로 두고 라벨만 숨깁니다.',
    default: true,
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakVisibleTimeCutoff',
    label: '보이는 최신 봉 기준',
    description: '오른쪽 끝에 보이는 분봉 시각까지의 후보만 사용해 당일 매수 최대벽을 계산합니다.',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'depthHeatmapIntraMax',
    label: '분봉 내 최댓값 기준',
    description:
      '분봉 종가 호가창 대신 그 분봉 내 총잔량이 가장 컸던 순간의 10호가를 히트맵 소스로 사용합니다. 강도 정규화도 같은 최댓값 소스를 기준으로 맞춥니다.',
    default: false,
    category: 'indicator-modal',
  },
  {
    key: 'tradeHighlightEnabled',
    label: '대량 체결 강조',
    description:
      '체결가 × 체결량이 기준 금액 이상인 체결의 체결량 칸을 배경색으로 강조합니다.',
    default: true,
    category: 'trade-window',
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

/** UI surface a toggle belongs to. 'indicator-modal'은 「지표」 모달의
 *  호가 Config로 이동했음을 뜻하며 ⚙️ 설정 모달에는 렌더되지 않는다
 *  (LiveSettingsSections의 CATEGORY_ORDER가 포함하지 않음).
 *  'trade-window'는 ⚙️ 설정 모달의 「체결창」 nav 항목. Unset → 'chart'. */
export type ChartToggleCategory = 'chart' | 'indicator-modal' | 'trade-window';

/** Resolve a CHART_TOGGLES entry's category, defaulting to 'chart' when
 *  the field is absent. Direct `t.category` access on the registry union
 *  fails to compile on entries that omit the field — `as const` narrows
 *  each literal shape to exclude absent properties. The `'category' in t`
 *  predicate narrows the union so the access becomes safe. Consumers
 *  (LiveSettingsSections, indicator Configs) call this instead of inlining
 *  the predicate so the narrowing trick lives in one place. */
export function categoryOf(
  t: (typeof CHART_TOGGLES)[number],
): ChartToggleCategory {
  return 'category' in t ? t.category : 'chart';
}

/**
 * Declarative registry of integer numeric prefs surfaced in the Settings
 * modal. Sister of `CHART_TOGGLES`: adding a pref = one entry here, and
 * (a) the `ChartViewPrefs` type field, (b) `DEFAULT_PREFS` value, (c) the
 * `setNumericPref` setter on `useChartPrefsStore`, (d) `mergePrefs`
 * validation in `chartPrefsPersistence.ts`, and (e) the `NumericPrefRow`
 * render in `LiveSettingsModal.tsx` all derive from this list — no
 * per-pref code in any of those modules.
 *
 * `enabledBy` (optional): when set, `LiveSettingsModal` dims and disables
 * the row when the named toggle is off and renders it indented beneath
 * its gating toggle. The value is preserved while disabled. The projector
 * that reads the pref is responsible
 * for honoring the same toggle (the pref alone is not load-bearing).
 *
 * 두 번째 의미(PR-B #699): enabledBy 가 indicator-modal 토글이면 이 수치도
 * **per-timeframe 버킷화 대상**으로 분류된다(`INDICATOR_MODAL_NUMERIC_KEYS`).
 * 게이트 토글과 함께 드로어에 렌더되는 항목이기 때문 — chart 카테고리 수치를
 * indicator-modal 토글에 게이트하면 의도치 않게 봉별 저장이 되니 주의.
 */
export type NumericPrefDef = {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly default: number;
  /** Inclusive lower bound. UI enforces; `mergePrefs` validates. */
  readonly min: number;
  /** Inclusive upper bound. */
  readonly max: number;
  /** Optional companion toggle that gates this pref's UI affordance. */
  readonly enabledBy?: ChartToggleKey;
  /** UI surface this pref belongs to. Unset → chart settings modal. */
  readonly category?: ChartToggleCategory;
  /** Render hint. `'time'` → HH:MM 시각 입력(TimeOfDayInput). 값은 여전히
   *  HHMM 정수로 저장. 미지정 → 일반 숫자 입력. */
  readonly kind?: 'time';
};

export const CHART_NUMERIC_PREFS = [
  {
    key: 'ratioOutlierThreshold',
    label: '호가비 극단값 임계 배수',
    description:
      '한쪽 호가가 다른 쪽의 이 배수 이상이면 그 시점의 호가비를 0 으로 마스킹합니다. (차트 Y축 라벨 단위)',
    default: 100,
    // Threshold is expressed in chart-label units (i.e. max(ask/bid, bid/ask)):
    // 2 is the smallest value that admits any data (ratio < 2x is "balanced
    // enough"); 10000 is a generous ceiling that effectively disables the
    // filter without removing the seam entirely.
    min: 2,
    max: 10_000,
    enabledBy: 'ratioOutlierFilterEnabled',
  },
  {
    key: 'surgeApproachPct',
    label: '급증 근접 문턱 — 직전 고가 대비(%)',
    description: '총잔량이 당일 직전 고가의 이 비율(%)까지 다시 차오르면 급증 마커를 1회 표시합니다. 기본 95%. 낮출수록 더 일찍·자주 잡습니다.',
    default: 95,
    min: 80,
    max: 100,
    enabledBy: 'surgeMarkerEnabled',
  },
  {
    key: 'surgeRearmPct',
    label: '급증 재무장 문턱 — 직전 고가 대비(%)',
    description: '한 번 표시한 뒤, 총잔량이 직전 고가의 이 비율(%) 아래로 빠져야 다시 표시 가능(히스테리시스 — 고점 근처 출렁임 도배 방지). 기본 85%. 근접 문턱보다 낮게.',
    default: 85,
    min: 50,
    max: 95,
    enabledBy: 'surgeMarkerEnabled',
  },
  {
    key: 'surgeStartHHMM',
    label: '급증 마커 시작 시각',
    description: '이 시각 이후에 발생한 급증만 마커로 표시합니다. 기본 09:00(장 시작, 전체 표시). 직전 고가 추적·재무장은 장 시작부터 계속되며, 가려지는 건 표시뿐입니다(장 초반 변동성 마커 숨김용).',
    default: 900,
    // HHMM 정수. 900(09:00, 정규장 시작)~1520(15:20, 마감 동시호가 시작 — 그 뒤는 어차피 마커 없음).
    // 분 자리(00–59)를 벗어난 값(예 960)은 hhmmToMinute에서 10:00으로 자연 환산되어 무해.
    min: 900,
    max: 1520,
    enabledBy: 'surgeMarkerEnabled',
    kind: 'time',
  },
  {
    key: 'askPeakAllPriceRankLimit',
    label: '체결된 벽 표시 개수',
    description: '체결된 벽 후보를 수량순으로 몇 등까지 차트에 표시할지 선택합니다.',
    default: 1,
    min: 1,
    max: 3,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakUntradedRankLimit',
    label: '미체결된 벽 표시 개수',
    description: '미체결된 벽 후보를 수량순으로 몇 등까지 차트에 표시할지 선택합니다.',
    default: 1,
    min: 1,
    max: 3,
    category: 'indicator-modal',
  },
  {
    key: 'askPeakVisibleMaxRankLimit',
    label: '보이는 영역 최대벽 표시 개수',
    description: '현재 보이는 캔들 영역 안에서 최대벽을 수량순으로 몇 등까지 표시할지 선택합니다.',
    default: 1,
    min: 0,
    max: 3,
    // AskPeakConfig(지표 드로어)가 직접 렌더 — ⚙️ 설정에는 나오지 않는 드로어 항목.
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakAllPriceRankLimit',
    label: '체결된 벽 표시 개수',
    description: '체결된 벽 후보를 수량순으로 몇 등까지 차트에 표시할지 선택합니다.',
    default: 1,
    min: 1,
    max: 3,
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakUntradedRankLimit',
    label: '미체결된 벽 표시 개수',
    description: '미체결된 벽 후보를 수량순으로 몇 등까지 차트에 표시할지 선택합니다.',
    default: 1,
    min: 1,
    max: 3,
    category: 'indicator-modal',
  },
  {
    key: 'bidPeakVisibleMaxRankLimit',
    label: '보이는 영역 최대벽 표시 개수',
    description: '현재 보이는 캔들 영역 안에서 최대벽을 수량순으로 몇 등까지 표시할지 선택합니다.',
    default: 1,
    min: 0,
    max: 3,
    // BidPeakConfig(지표 드로어)가 직접 렌더 — ⚙️ 설정에는 나오지 않는 드로어 항목.
    category: 'indicator-modal',
  },
  {
    key: 'tradeHighlightThresholdManwon',
    label: '기준 금액 (만원)',
    description:
      '체결가 × 체결량이 이 금액(만원) 이상이면 대량 체결로 강조합니다. 기본 5,000만원.',
    default: 5000,
    // 100만원(소형주 대량 기준)~100억(사실상 비활성 상한). 만원 단위 정수.
    min: 100,
    max: 1_000_000,
    enabledBy: 'tradeHighlightEnabled',
    category: 'trade-window',
  },
] as const satisfies readonly NumericPrefDef[];

export type NumericPrefKey = (typeof CHART_NUMERIC_PREFS)[number]['key'];

export const DAY_BOUNDARY_COLOR_DEFAULT = '#64748B';
export const DAY_BOUNDARY_LINE_WIDTH_DEFAULT: 1 | 2 | 3 | 4 = 1;
export type DayBoundaryLineWidth = 1 | 2 | 3 | 4;
export type ViLimitPriceLineWidth = 1 | 2 | 3 | 4;
export const VI_LIMIT_PRICE_LINE_DEFAULT_COLOR = '#EAB308';
export const VI_LIMIT_PRICE_LINE_DEFAULT_WIDTH: ViLimitPriceLineWidth = 3;

/** 체결창 대량 체결 강조 배경색 기본값 — 매물대 당일 최대(maxColor)와 같은 노랑 계열
 *  ("눈에 띄는 물량" 시맨틱 공유). 렌더 시 알파를 얹으므로 6자리 hex 로 저장한다. */
export const TRADE_HIGHLIGHT_COLOR_DEFAULT = '#EAB308';

/** Per-tab chart view preferences. Stored in a `Map<tabId, ChartViewPrefs>`
 *  on the store for parity with `Tab.bundles` (CQ1). Boolean fields come
 *  from `CHART_TOGGLES`; integer numeric fields come from
 *  `CHART_NUMERIC_PREFS`. */
export type ChartViewPrefs =
  & { [K in ChartToggleKey]: boolean }
  & { [K in NumericPrefKey]: number }
  & {
    dayBoundaryColor: string;
    dayBoundaryLineWidth: DayBoundaryLineWidth;
    tradeHighlightColor: string;
    // VI/상하한가 선 스타일 — 원래 지표 버킷(창×봉)에 있었는데, 정작 자기
    // 토글(`viLimitPriceDotsEnabled`)은 여기 전역이라 한 기능이 두 저장소로
    // 쪼개져 있었다. 형제 스타일(날짜 구분선·체결 강조)도 전부 전역이라
    // VI 만 예외였다 — 토글 옆으로 합친다(#759 구현 중 발견).
    viLimitPriceLineColor: string;
    viLimitPriceLineWidth: ViLimitPriceLineWidth;
  };

const TOGGLE_DEFAULTS = Object.fromEntries(
  CHART_TOGGLES.map((t) => [t.key, t.default]),
) as { [K in ChartToggleKey]: boolean };

const NUMERIC_DEFAULTS = Object.fromEntries(
  CHART_NUMERIC_PREFS.map((p) => [p.key, p.default]),
) as { [K in NumericPrefKey]: number };

export const DEFAULT_PREFS: ChartViewPrefs = {
  ...TOGGLE_DEFAULTS,
  ...NUMERIC_DEFAULTS,
  dayBoundaryColor: DAY_BOUNDARY_COLOR_DEFAULT,
  dayBoundaryLineWidth: DAY_BOUNDARY_LINE_WIDTH_DEFAULT,
  tradeHighlightColor: TRADE_HIGHLIGHT_COLOR_DEFAULT,
  viLimitPriceLineColor: VI_LIMIT_PRICE_LINE_DEFAULT_COLOR,
  viLimitPriceLineWidth: VI_LIMIT_PRICE_LINE_DEFAULT_WIDTH,
};

/**
 * 지표 드로어 스코프(per-timeframe 버킷화 대상, #696·#699 PR-B) 키 분류.
 *
 * 드로어에 렌더되는 chartPrefs = indicator-modal 카테고리 토글 + (그 토글이
 * `enabledBy` 로 게이트하는 수치 ∪ indicator-modal 카테고리 수치). 이 키들은
 * 현재 봉(분/D/W/M) 버킷에 저장되고, 나머지(차트 전반 토글·날짜선 스타일)는
 * 종전대로 전역 flat 이다.
 */
export const INDICATOR_MODAL_TOGGLE_KEYS: readonly ChartToggleKey[] = CHART_TOGGLES
  .filter((t) => categoryOf(t) === 'indicator-modal')
  .map((t) => t.key);

const INDICATOR_MODAL_TOGGLE_SET = new Set<string>(INDICATOR_MODAL_TOGGLE_KEYS);

export const INDICATOR_MODAL_NUMERIC_KEYS: readonly NumericPrefKey[] = CHART_NUMERIC_PREFS
  .filter((p) => ('category' in p && p.category === 'indicator-modal')
    || ('enabledBy' in p && INDICATOR_MODAL_TOGGLE_SET.has(p.enabledBy)))
  .map((p) => p.key);

export type IndicatorModalPrefKey = ChartToggleKey | NumericPrefKey;

export const INDICATOR_MODAL_PREF_KEYS: readonly IndicatorModalPrefKey[] = [
  ...INDICATOR_MODAL_TOGGLE_KEYS,
  ...INDICATOR_MODAL_NUMERIC_KEYS,
];

const INDICATOR_MODAL_PREF_SET = new Set<string>(INDICATOR_MODAL_PREF_KEYS);

export function isIndicatorModalPrefKey(key: string): key is IndicatorModalPrefKey {
  return INDICATOR_MODAL_PREF_SET.has(key);
}

/** indicator-modal 키의 per-timeframe sparse 오버라이드 (기본값과의 diff). */
export type IndicatorModalByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<Record<IndicatorModalPrefKey, boolean | number>>>>;

/** 주어진 봉의 indicator-modal 유효값 = 레지스트리 기본값 ⊕ 해당 버킷. */
export function resolveIndicatorModalPrefs(
  byTimeframe: IndicatorModalByTimeframe,
  timeframe: LiveTimeframe,
): Partial<ChartViewPrefs> {
  const bucket = byTimeframe[profileKeyForTimeframe(timeframe)] ?? {};
  const out: Record<string, boolean | number> = {};
  for (const key of INDICATOR_MODAL_PREF_KEYS) {
    out[key] = (bucket[key] ?? DEFAULT_PREFS[key]) as boolean | number;
  }
  return out as Partial<ChartViewPrefs>;
}

import { useContext } from 'react';
import { create } from 'zustand';
import {
  profileKeyForTimeframe,
  type IndicatorPaneProfileKey,
} from '../live/indicators/indicatorPaneProfiles';
import { WindowViewContext } from '../live/workspace/windowViewContext';
import type { LiveTimeframe } from './livePage';

type ChartPrefsStore = ChartViewPrefs & {
  /** indicator-modal 키의 4버킷 원본 — 최상위 필드는 ambient 봉 투영(PR-A 패턴). */
  indicatorModalByTimeframe: IndicatorModalByTimeframe;
  /** indicator-modal 투영이 현재 따르는 봉 — livePage 의 ambient 와 동기화된다. */
  indicatorModalTimeframe: LiveTimeframe;
  setIndicatorModalTimeframe: (tf: LiveTimeframe) => void;
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  /** 봉을 명시한 쓰기 — indicator-modal 키는 **그 봉의 버킷**에 기록한다.
   *  차트 전반(flat) 키는 봉과 무관하므로 tf 를 무시한다. 창-스코프 편집 표면
   *  (`useChartPrefActions`)이 대상 창의 봉을 실어 이 경로로만 쓴다. */
  setPrefAt: (tf: LiveTimeframe, key: ChartToggleKey | NumericPrefKey, value: boolean | number) => void;
  /** 지정한 봉의 indicator-modal 버킷만 비운다(드로어 "현재 봉 초기화"). */
  resetIndicatorModalBucketAt: (tf: LiveTimeframe) => void;
  setDayBoundaryStyle: (patch: { color?: string; lineWidth?: DayBoundaryLineWidth }) => void;
  setTradeHighlightColor: (color: string) => void;
  setViLimitPriceLineStyle: (patch: { color?: string; lineWidth?: ViLimitPriceLineWidth }) => void;
  /** 지표 드로어 "현재 봉 초기화"(PR-C #699): indicator-modal 의 **현재 봉 버킷만**
   *  비우고 재투영한다. 차트 전반 flat(그리드·툴팁 등 ⚙️ 설정 항목)은 드로어 밖이라
   *  건드리지 않는다. */
  resetIndicatorModalBucket: () => void;
  /** 전체 초기화: 차트 전반 flat + **전 봉 버킷**을 기본값으로. */
  resetToDefaults: () => void;
};

export const useChartPrefsStore = create<ChartPrefsStore>((set, get) => {
  /** 키 종류별 단일 쓰기 경로: indicator-modal 키는 `tf` 의 버킷에 기록, 차트 전반
   *  키는 flat 그대로. 최상위 투영은 **그 버킷이 현재 ambient 봉일 때만** 갱신한다
   *  — 다른 봉 버킷을 편집하면서 최상위(=ambient 투영)까지 덮으면 Provider 밖
   *  소비자(`/study`·단일 차트)가 자기 봉이 아닌 값을 보게 된다. */
  const writePrefAt = (
    tf: LiveTimeframe,
    key: ChartToggleKey | NumericPrefKey,
    value: boolean | number,
  ): void => {
    if (!isIndicatorModalPrefKey(key)) {
      set({ [key]: value } as Partial<ChartPrefsStore>);
      return;
    }
    const s = get();
    const profileKey = profileKeyForTimeframe(tf);
    const bucket = { ...(s.indicatorModalByTimeframe[profileKey] ?? {}), [key]: value };
    const patch: Record<string, unknown> = {
      indicatorModalByTimeframe: { ...s.indicatorModalByTimeframe, [profileKey]: bucket },
    };
    if (profileKey === profileKeyForTimeframe(s.indicatorModalTimeframe)) patch[key] = value;
    set(patch as Partial<ChartPrefsStore>);
  };

  /** ambient 봉 기준 쓰기 — Provider 밖(레거시 단일 뷰·`/study`) 호출자용. */
  const writePref = (key: ChartToggleKey | NumericPrefKey, value: boolean | number): void =>
    writePrefAt(get().indicatorModalTimeframe, key, value);

  return {
    ...DEFAULT_PREFS,
    indicatorModalByTimeframe: {},
    indicatorModalTimeframe: '1m',

    setIndicatorModalTimeframe: (tf) => {
      // 같은 봉이어도 무조건 재투영(PR-A 의 setIndicatorTimeframe 과 동일한 이유).
      set({
        indicatorModalTimeframe: tf,
        ...resolveIndicatorModalPrefs(get().indicatorModalByTimeframe, tf),
      });
    },

    setToggle: (key, value) => writePref(key, value),

    setNumericPref: (key, value) => writePref(key, value),

    setPrefAt: (tf, key, value) => writePrefAt(tf, key, value),

    setDayBoundaryStyle: (patch) =>
      set((s) => ({
        dayBoundaryColor: patch.color ?? s.dayBoundaryColor,
        dayBoundaryLineWidth: patch.lineWidth ?? s.dayBoundaryLineWidth,
      })),

    setTradeHighlightColor: (color) => set({ tradeHighlightColor: color }),

    setViLimitPriceLineStyle: (patch) =>
      set((s) => ({
        viLimitPriceLineColor: patch.color ?? s.viLimitPriceLineColor,
        viLimitPriceLineWidth: patch.lineWidth ?? s.viLimitPriceLineWidth,
      })),

    resetIndicatorModalBucket: () => get().resetIndicatorModalBucketAt(get().indicatorModalTimeframe),

    resetIndicatorModalBucketAt: (tf) => {
      const s = get();
      const profileKey = profileKeyForTimeframe(tf);
      const byTimeframe = { ...s.indicatorModalByTimeframe };
      delete byTimeframe[profileKey];
      // 최상위 투영은 ambient 봉으로 다시 계산한다 — 지운 버킷이 ambient 가 아니면
      // 투영은 그대로 유지되는 게 맞다(writePrefAt 의 게이트와 같은 이유).
      set({
        indicatorModalByTimeframe: byTimeframe,
        ...resolveIndicatorModalPrefs(byTimeframe, s.indicatorModalTimeframe),
      });
    },

    resetToDefaults: () => set({ ...DEFAULT_PREFS, indicatorModalByTimeframe: {} }),
  };
});

/** livePage 의 ambient 봉 전환이 호출하는 동기화 진입점 — 두 스토어의 투영을
 *  같은 틱에 맞춘다(livePage → chartPrefs 단방향 의존, 순환 없음). */
export function syncIndicatorModalTimeframe(tf: LiveTimeframe): void {
  useChartPrefsStore.getState().setIndicatorModalTimeframe(tf);
}

/**
 * 스토어 스냅샷을 **주어진 봉 기준**으로 읽은 `ChartViewPrefs`.
 *
 * 최상위 필드는 ambient 봉 투영일 뿐이라, 창마다 봉이 다른 멀티창에서는 그대로
 * 읽으면 안 된다 — indicator-modal 키는 그 봉의 버킷으로 다시 덮는다.
 *
 * 메모: 스냅샷 객체 identity × 봉 프로파일. zustand 는 `set` 마다 새 state 객체를
 * 만들므로 WeakMap 항목이 자연 무효화된다. selector 가 매 호출 새 객체를 받지
 * 않게 하는 게 목적 — 안 그러면 useSyncExternalStore 의 스냅샷 안정성이 깨져
 * 틱마다 무의미한 재렌더가 난다.
 */
const prefsByTimeframeCache = new WeakMap<
  object,
  Map<IndicatorPaneProfileKey, ChartViewPrefs>
>();

export function prefsForTimeframe(state: ChartPrefsStore, tf: LiveTimeframe): ChartViewPrefs {
  const profileKey = profileKeyForTimeframe(tf);
  let byProfile = prefsByTimeframeCache.get(state);
  if (!byProfile) {
    byProfile = new Map();
    prefsByTimeframeCache.set(state, byProfile);
  }
  const hit = byProfile.get(profileKey);
  if (hit) return hit;
  const merged = {
    ...state,
    ...resolveIndicatorModalPrefs(state.indicatorModalByTimeframe, tf),
  } as ChartViewPrefs;
  byProfile.set(profileKey, merged);
  return merged;
}

/** 이 서브트리가 속한 창의 봉 — Provider 밖(단일 차트·`/study`)이면 null. */
function useWindowPrefsTimeframe(): LiveTimeframe | null {
  return useContext(WindowViewContext)?.timeframe ?? null;
}

/**
 * Subscribe to a slice of `ChartViewPrefs`.
 *
 * Fine-grained: re-renders only when the selected slice changes (by
 * Zustand's default `Object.is` equality). Use this in chart components
 * and projectors instead of reading the whole prefs object — RatioPane
 * shouldn't re-render when the user flips `ratioOutlierThreshold`.
 *
 * **창 스코프(멀티창 결함 수정)**: Provider 안에서는 indicator-modal 키를 그 창의
 * 봉 버킷으로 resolve 해 넘긴다. 종전에는 모든 창이 전역 슬롯
 * (`indicatorModalTimeframe` — 포커스 전환을 따라다니는 값)의 버킷을 읽어서,
 * 예컨대 분봉 창에서 끈 「총잔량 급증 마커」가 슬롯이 D 를 가리키는 동안 되살아났다
 * (그 창을 클릭해 포커스를 주면 슬롯이 재동기화되어 다시 사라짐 — 자기치유형 증상).
 * Provider 밖에서는 종전대로 ambient 투영을 읽는다(`/study` 무변경 계약).
 */
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  const tf = useWindowPrefsTimeframe();
  return useChartPrefsStore((s) => selector(tf ? prefsForTimeframe(s, tf) : s));
}

/** 창 스코프로 resolve 된 prefs 전체 — 드로어의 설정 행처럼 여러 키를 한꺼번에
 *  읽는 UI 용(`useActivePrefs` 와 같은 봉 규칙). */
export function useScopedChartPrefs(): ChartViewPrefs {
  const tf = useWindowPrefsTimeframe();
  return useChartPrefsStore((s) => (tf ? prefsForTimeframe(s, tf) : s));
}

/** 창 스코프 편집 표면 — 대상 창의 봉 버킷에 기록한다(`useIndicatorActions` 의
 *  chartPrefs 대응물). Provider 밖이면 ambient 봉으로 폴백. */
export function useChartPrefActions(): {
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  resetIndicatorModalBucket: () => void;
} {
  const tf = useWindowPrefsTimeframe();
  // 스토어 액션은 생성 시 1회 만들어지는 안정 참조 — 매 렌더 새 클로저를 만들어도
  // 대상 봉만 다르므로, useMemo 없이도 의미가 흔들리지 않는다. 다만 봉이 바뀌면
  // 새 클로저가 새 버킷을 향해야 하므로 클로저 캡처는 tf 로 유지한다.
  const store = useChartPrefsStore;
  return {
    setToggle: (key, value) =>
      tf ? store.getState().setPrefAt(tf, key, value) : store.getState().setToggle(key, value),
    setNumericPref: (key, value) =>
      tf ? store.getState().setPrefAt(tf, key, value) : store.getState().setNumericPref(key, value),
    resetIndicatorModalBucket: () =>
      tf
        ? store.getState().resetIndicatorModalBucketAt(tf)
        : store.getState().resetIndicatorModalBucket(),
  };
}

import { hydrateChartPrefs, attachChartPrefsPersistence } from './chartPrefsPersistence';

hydrateChartPrefs(useChartPrefsStore);
attachChartPrefsPersistence(useChartPrefsStore);
