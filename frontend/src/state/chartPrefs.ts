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
    default: true,
  },
  {
    key: 'highLowLabelsEnabled',
    label: '고저 극값 라벨',
    description:
      '현재 보이는 차트 범위의 최고가·최저가 봉에 현재가의 극값 대비율(가격·%·시각) 라벨을 표시합니다. (고가=빨강, 저가=파랑)',
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
    description: '당일 고가보다 위에 있는 미체결 추정 매도벽이 체결 기준 최대벽과 다르면 두 라인을 함께 표시합니다.',
    default: true,
    category: 'indicator-modal',
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

/** UI surface a toggle belongs to. 'indicator-modal'은 「지표」 모달의
 *  호가 Config로 이동했음을 뜻하며 ⚙️ 설정 모달에는 렌더되지 않는다
 *  (LiveSettingsSections의 CATEGORY_ORDER가 포함하지 않음). Unset → 'chart'. */
export type ChartToggleCategory = 'chart' | 'indicator-modal';

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
    label: '급증 마커 시작 시각 (HHMM)',
    description: '이 시각 이후에 발생한 급증만 마커로 표시합니다. HHMM 형식 — 예: 930 = 09:30, 1000 = 10:00. 기본 900(장 시작 09:00, 전체 표시). 직전 고가 추적·재무장은 장 시작부터 계속되며, 가려지는 건 표시뿐입니다(장 초반 변동성 마커 숨김용).',
    default: 900,
    // HHMM 정수. 900(09:00, 정규장 시작)~1520(15:20, 마감 동시호가 시작 — 그 뒤는 어차피 마커 없음).
    // 분 자리(00–59)를 벗어난 값(예 960)은 hhmmToMinute에서 10:00으로 자연 환산되어 무해.
    min: 900,
    max: 1520,
    enabledBy: 'surgeMarkerEnabled',
  },
] as const satisfies readonly NumericPrefDef[];

export type NumericPrefKey = (typeof CHART_NUMERIC_PREFS)[number]['key'];

export const DAY_BOUNDARY_COLOR_DEFAULT = '#64748B';
export const DAY_BOUNDARY_LINE_WIDTH_DEFAULT: 1 | 2 | 3 | 4 = 1;
export type DayBoundaryLineWidth = 1 | 2 | 3 | 4;

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
};

import { create } from 'zustand';

type ChartPrefsStore = ChartViewPrefs & {
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  setDayBoundaryStyle: (patch: { color?: string; lineWidth?: DayBoundaryLineWidth }) => void;
  resetToDefaults: () => void;
};

export const useChartPrefsStore = create<ChartPrefsStore>((set) => ({
  ...DEFAULT_PREFS,
  setToggle: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  setNumericPref: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  setDayBoundaryStyle: (patch) =>
    set((s) => ({
      dayBoundaryColor: patch.color ?? s.dayBoundaryColor,
      dayBoundaryLineWidth: patch.lineWidth ?? s.dayBoundaryLineWidth,
    })),
  resetToDefaults: () => set(DEFAULT_PREFS),
}));

/**
 * Subscribe to a slice of the global `ChartViewPrefs`.
 *
 * Fine-grained: re-renders only when the selected slice changes (by
 * Zustand's default `Object.is` equality). Use this in chart components
 * and projectors instead of reading the whole prefs object — RatioPane
 * shouldn't re-render when the user flips `ratioOutlierThreshold`.
 *
 * Thin wrapper over `useChartPrefsStore` preserved so existing chart
 * projectors keep their `useActivePrefs(selector)` call shape.
 */
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  return useChartPrefsStore(selector);
}

import { hydrateChartPrefs, attachChartPrefsPersistence } from './chartPrefsPersistence';

hydrateChartPrefs(useChartPrefsStore);
attachChartPrefsPersistence(useChartPrefsStore);
