/**
 * Declarative registry of boolean chart toggles surfaced in the Settings
 * modal. Each entry is the single source of truth for one toggle: its key
 * (used as a `ChartViewPrefs` field), default value, and UI strings.
 *
 * Adding a toggle = one entry here. The type below (`ChartToggleKey`),
 * the `ChartViewPrefs` boolean fields, the default values, and the
 * `SettingsModal` row rendering all derive from this list.
 */
export const CHART_TOGGLES = [
  {
    key: 'auctionWindowMask',
    label: '동시호가 구간 지표 숨김',
    description: '15:20–15:30 KST 동시호가 구간에서 호가비·호가총합·체결강도를 표시하지 않습니다. (캔들/거래량 제외)',
    default: true,
  },
  {
    key: 'ratioOutlierFilterEnabled',
    label: '호가비 극단값 필터',
    description:
      '한쪽 호가가 임계 배수를 넘으면 그 시점의 호가비를 0 으로 마스킹합니다. (오토스케일을 잡아먹는 스파이크 제거)',
    default: true,
  },
  {
    key: 'fillStrengthCumulative',
    label: '체결강도 — 당일 누적',
    description:
      '체결강도 pane에 당일 누적 매수−매도 라인(체결강도 누적)을 표시합니다. 거래일마다 0에서 다시 시작.',
    default: true,
    category: 'indicators',
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

/** UI surface a toggle belongs to. Unset entries default to 'chart' (the
 *  SettingsModal's "차트" category). New indicator-scoped toggles set
 *  'indicators' so IndicatorsSection picks them up automatically. */
export type ChartToggleCategory = 'chart' | 'indicators';

/** Resolve a CHART_TOGGLES entry's category, defaulting to 'chart' when
 *  the field is absent. Direct `t.category` access on the registry union
 *  fails to compile on entries that omit the field — `as const` narrows
 *  each literal shape to exclude absent properties. The `'category' in t`
 *  predicate narrows the union so the access becomes safe. Consumers
 *  (SettingsModal, IndicatorsSection) call this instead of inlining the
 *  predicate so the narrowing trick lives in one place. */
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
] as const satisfies readonly NumericPrefDef[];

export type NumericPrefKey = (typeof CHART_NUMERIC_PREFS)[number]['key'];

/** Per-tab chart view preferences. Stored in a `Map<tabId, ChartViewPrefs>`
 *  on the store for parity with `Tab.bundles` (CQ1). Boolean fields come
 *  from `CHART_TOGGLES`; integer numeric fields come from
 *  `CHART_NUMERIC_PREFS`. */
export type ChartViewPrefs =
  & { [K in ChartToggleKey]: boolean }
  & { [K in NumericPrefKey]: number };

const TOGGLE_DEFAULTS = Object.fromEntries(
  CHART_TOGGLES.map((t) => [t.key, t.default]),
) as { [K in ChartToggleKey]: boolean };

const NUMERIC_DEFAULTS = Object.fromEntries(
  CHART_NUMERIC_PREFS.map((p) => [p.key, p.default]),
) as { [K in NumericPrefKey]: number };

export const DEFAULT_PREFS: ChartViewPrefs = {
  ...TOGGLE_DEFAULTS,
  ...NUMERIC_DEFAULTS,
};

import { create } from 'zustand';

type ChartPrefsStore = ChartViewPrefs & {
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  resetToDefaults: () => void;
};

export const useChartPrefsStore = create<ChartPrefsStore>((set) => ({
  ...DEFAULT_PREFS,
  setToggle: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  setNumericPref: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
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
