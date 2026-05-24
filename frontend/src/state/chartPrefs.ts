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
    label: '호가비 동시호가 마스킹',
    description: '15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.',
    default: true,
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

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

/** Per-tab chart view preferences. Stored in a `Map<tabId, ChartViewPrefs>`
 *  on the store for parity with `Tab.bundles` (CQ1). Boolean fields come
 *  from `CHART_TOGGLES`; non-boolean prefs (e.g. `volumeProfileMode`,
 *  `movingAverages`) sit alongside as explicit fields. */
export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
  movingAverages: MAConfig[];
} & { [K in ChartToggleKey]: boolean };

const TOGGLE_DEFAULTS = Object.fromEntries(
  CHART_TOGGLES.map((t) => [t.key, t.default]),
) as { [K in ChartToggleKey]: boolean };

export const DEFAULT_PREFS: ChartViewPrefs = {
  volumeProfileMode: 'range',
  movingAverages: DEFAULT_MOVING_AVERAGES.map((c) => ({ ...c })),
  ...TOGGLE_DEFAULTS,
};

// useActivePrefs lives in this module too (Task 3). Adding the import
// here would create an unused-import error until then; deferred to T3.
