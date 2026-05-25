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

/** Per-MA configuration. Indexed slot in `ChartViewPrefs.movingAverages`
 *  aligns 1:1 with `MA_COLORS` (T1). Period range (2..400) is validated
 *  at the UI layer (T5), not in the store. */
export type MAConfig = {
  period: number;
  enabled: boolean;
};

/** Number of Moving Average slots surfaced in the UI. Single source of
 *  truth — DEFAULT_MOVING_AVERAGES.length, the bounds check in
 *  setMovingAverage, and the loop assembling MOVING_AVERAGE_SPEC.series
 *  all derive their fixed cardinality from this constant. Bumping it
 *  requires updating DEFAULT_MOVING_AVERAGES (add a default entry) and
 *  tokens.css (add --ma-N for the new slot); the rest follows. */
export const MA_SLOT_COUNT = 5;

/** Valid MA slot index. Derived from MA_SLOT_COUNT; do not hand-write the union. */
export type MAIndex = 0 | 1 | 2 | 3 | 4;

// Type-level guard: this expression fails to typecheck if MAIndex doesn't
// cover exactly [0..MA_SLOT_COUNT-1]. Adjust both together.
type _MAIndexCheck =
  [MAIndex, typeof MA_SLOT_COUNT] extends [0 | 1 | 2 | 3 | 4, 5] ? true : never;
const _maIndexCheckOk: _MAIndexCheck = true;
void _maIndexCheckOk;

/**
 * Canonical MA slot defaults (period + enabled). Frozen so direct mutation
 * trips at runtime; DEFAULT_PREFS holds a deep mutable copy so each tab
 * gets an independently mutable array via the `setMovingAverage` action.
 *
 * To add a new slot: append here (the new index will need a matching
 * --ma-N token in tokens.css and a bump of MA_SLOT_COUNT). MAIndex and
 * the type-level guard will then fail to compile until updated.
 */
export const DEFAULT_MOVING_AVERAGES: readonly MAConfig[] = Object.freeze([
  { period: 5, enabled: true },
  { period: 10, enabled: true },
  { period: 20, enabled: true },
  { period: 60, enabled: true },
  { period: 120, enabled: true },
]);

/**
 * Declarative registry of integer numeric prefs surfaced in the Settings
 * modal. Sister of `CHART_TOGGLES`: adding a pref = one entry here, and
 * (a) the `ChartViewPrefs` type field, (b) `DEFAULT_PREFS` value, (c) the
 * generic store setter (`setNumericPref` in tabs.ts), (d) `mergePrefs`
 * validation in tabsPersistence.ts, and (e) the `NumericPrefRow` render
 * in SettingsModal.tsx all derive from this list — no per-pref code in
 * any of those modules.
 *
 * `enabledBy` (optional): when set, the SettingsModal dims and disables
 * the row when the named toggle is off — the value is preserved, the
 * pref is just inert. The projector that reads the pref is responsible
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
 *  `CHART_NUMERIC_PREFS`; structural prefs (e.g. `volumeProfileMode`,
 *  `movingAverages`) sit alongside as explicit fields. */
export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
  movingAverages: MAConfig[];
} & { [K in ChartToggleKey]: boolean }
  & { [K in NumericPrefKey]: number };

const TOGGLE_DEFAULTS = Object.fromEntries(
  CHART_TOGGLES.map((t) => [t.key, t.default]),
) as { [K in ChartToggleKey]: boolean };

const NUMERIC_DEFAULTS = Object.fromEntries(
  CHART_NUMERIC_PREFS.map((p) => [p.key, p.default]),
) as { [K in NumericPrefKey]: number };

export const DEFAULT_PREFS: ChartViewPrefs = {
  volumeProfileMode: 'range',
  movingAverages: DEFAULT_MOVING_AVERAGES.map((c) => ({ ...c })),
  ...TOGGLE_DEFAULTS,
  ...NUMERIC_DEFAULTS,
};

/**
 * Store-injection seam to break the chartPrefs.ts ↔ tabs.ts module cycle.
 *
 * Why: ESM hoists `import` statements regardless of source position.
 * A top-level `import { useTabsStore } from './tabs'` here would force
 * tabs.ts to evaluate while chartPrefs.ts's namespace is still empty —
 * and tabs.ts's `seedInitialState()` reads `CHART_TOGGLES` at module
 * load, which would then be undefined.
 *
 * tabs.ts calls `registerTabsStore(useTabsStore)` immediately after
 * `create(...)`. By the time any React component renders and invokes
 * `useActivePrefs`, registration has happened. The runtime null-check
 * is a tripwire if a non-React caller fires before tabs.ts loads.
 */
type ActiveTabPrefsStoreApi = {
  <U>(selector: (state: { activeTabId: string; getPrefs: (id: string) => ChartViewPrefs }) => U): U;
};
let _activeTabPrefsStore: ActiveTabPrefsStoreApi | null = null;
export function registerTabsStore(store: ActiveTabPrefsStoreApi): void {
  _activeTabPrefsStore = store;
}

/**
 * Subscribe to a slice of the active tab's `ChartViewPrefs`.
 *
 * Fine-grained: re-renders only when the selected slice changes (by
 * Zustand's default `Object.is` equality). Use this in chart components
 * and projectors instead of reading the whole prefs object — RatioPane
 * shouldn't re-render when the user flips `volumeProfileMode`.
 *
 * Replaces the prior `useChartPrefs()` + `ChartPrefsContext` pattern,
 * which threaded the whole prefs object through context and forced
 * every consumer to re-render on any pref change.
 */
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  if (_activeTabPrefsStore === null) {
    throw new Error(
      'useActivePrefs called before tabs store registered. Ensure ./tabs is imported.',
    );
  }
  return _activeTabPrefsStore((s) => selector(s.getPrefs(s.activeTabId)));
}
