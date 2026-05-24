import type { Tab, TabSelection, ChartViewPrefs, ChartToggleKey } from './tabs';
import {
  RATIO_OUTLIER_THRESHOLD_MAX,
  RATIO_OUTLIER_THRESHOLD_MIN,
} from './chartPrefs';
import { TIMEFRAME_LABELS, type Timeframe } from '../api/types';

/** Versioned storage key. Schema-breaking changes bump the suffix and let
 *  the previous key be garbage-collected naturally — no migration code. */
export const STORAGE_KEY = 'replay.tabs.v1';

/** Per-tab snapshot. `prefs` is `Partial` because forward-compat merge against
 *  `DEFAULT_PREFS` at load time tolerates schema additions. */
export type PersistedTab = {
  selection: TabSelection | null;
  prefs: Partial<ChartViewPrefs>;
};

export type ReplayTabsSnapshot = {
  version: 1;
  savedAt: number;
  activeIndex: number;
  tabs: PersistedTab[];
};

/** Runtime dependencies injected by `tabs.ts` so `tabsPersistence` stays
 *  acyclic with respect to value imports. */
export type SnapshotDeps = {
  defaultPrefs: ChartViewPrefs;
  freshTab: () => Tab;
  /** Registry of boolean toggle keys (e.g. derived from `CHART_TOGGLES`).
   *  Drives `mergePrefs` so a new toggle in `tabs.ts` round-trips
   *  through persistence without editing this module. */
  chartToggleKeys: ReadonlyArray<ChartToggleKey>;
};

export type ToSnapshotInput = {
  tabs: readonly Tab[];
  activeTabId: string;
  prefs: ReadonlyMap<string, ChartViewPrefs>;
};

/** Pure projection: live store state → durable snapshot.
 *  Excludes bundles / cursorMs / status / id — see spec table. */
export function toSnapshot(input: ToSnapshotInput): ReplayTabsSnapshot {
  const { tabs, activeTabId, prefs } = input;
  const foundIdx = tabs.findIndex((t) => t.id === activeTabId);
  const activeIndex = foundIdx >= 0 ? foundIdx : 0;
  return {
    version: 1,
    savedAt: Date.now(),
    activeIndex,
    tabs: tabs.map((t) => ({
      selection: t.selection,
      // Untouched tabs round-trip as `{}` so a future default change is not
      // silently overridden by a baked-in old default at load time.
      prefs: prefs.get(t.id) ?? {},
    })),
  };
}

const TIMEFRAME_SET = new Set<string>(TIMEFRAME_LABELS);
const CODE_RE = /^\d{6}$/;
const DATE_RE = /^\d{8}$/;

/** Returns `value` iff every field is valid; otherwise `null`. Used at load
 *  time to defang malformed entries without dropping the whole tab. */
export function validateSelection(value: unknown): TabSelection | null {
  if (value === null) return null;
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || !CODE_RE.test(v.code)) return null;
  if (typeof v.fromDate !== 'string' || !DATE_RE.test(v.fromDate)) return null;
  if (typeof v.toDate !== 'string' || !DATE_RE.test(v.toDate)) return null;
  if (typeof v.timeframe !== 'string' || !TIMEFRAME_SET.has(v.timeframe)) return null;
  return {
    code: v.code,
    fromDate: v.fromDate,
    toDate: v.toDate,
    timeframe: v.timeframe as Timeframe,
  };
}

type VolumeProfileMode = ChartViewPrefs['volumeProfileMode'];
const VOLUME_PROFILE_MODES = new Set<VolumeProfileMode>(['range', 'per-day']);

function isValidMA(m: unknown): m is { period: number; enabled: boolean } {
  if (m === null || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return typeof o.period === 'number' && Number.isFinite(o.period) && typeof o.enabled === 'boolean';
}

/** Merge a `Partial<ChartViewPrefs>` over `defaults`. Unknown keys ignored;
 *  malformed values fall back to the default for that key. Boolean toggles
 *  are validated against the injected `toggleKeys` registry — so adding a
 *  new entry to `CHART_TOGGLES` in `tabs.ts` Just Works without editing
 *  this module. */
export function mergePrefs(
  partial: Partial<ChartViewPrefs> | undefined,
  defaults: ChartViewPrefs,
  toggleKeys: ReadonlyArray<ChartToggleKey>,
): ChartViewPrefs {
  const p = (partial ?? {}) as Record<string, unknown>;
  const out: ChartViewPrefs = {
    ...defaults,
    movingAverages: defaults.movingAverages.map((m) => ({ ...m })),
  };
  if (typeof p.volumeProfileMode === 'string'
      && VOLUME_PROFILE_MODES.has(p.volumeProfileMode as VolumeProfileMode)) {
    out.volumeProfileMode = p.volumeProfileMode as VolumeProfileMode;
  }
  // Validate the numeric outlier threshold. Falls back to default for any
  // non-finite or out-of-range value rather than clamping silently — keeps
  // localStorage corruption from masquerading as user intent.
  if (
    typeof p.ratioOutlierThreshold === 'number'
    && Number.isFinite(p.ratioOutlierThreshold)
    && p.ratioOutlierThreshold >= RATIO_OUTLIER_THRESHOLD_MIN
    && p.ratioOutlierThreshold <= RATIO_OUTLIER_THRESHOLD_MAX
  ) {
    out.ratioOutlierThreshold = Math.floor(p.ratioOutlierThreshold);
  }
  for (const key of toggleKeys) {
    if (typeof p[key] === 'boolean') {
      out[key] = p[key] as boolean;
    }
  }
  if (
    Array.isArray(p.movingAverages)
    && p.movingAverages.length === defaults.movingAverages.length
    && p.movingAverages.every(isValidMA)
  ) {
    out.movingAverages = p.movingAverages.map((m) => ({ ...(m as { period: number; enabled: boolean }) }));
  }
  return out;
}

/** Reads + validates the v1 payload. Returns `null` when absent, corrupt, or
 *  version-mismatched. Selection-level salvage (invalid selection → null,
 *  keeping the entry) happens here; prefs validation is deferred to
 *  `mergePrefs` (called from `fromSnapshot`). The caller is responsible
 *  for the "empty tabs → seed a fresh tab" fallback. */
export function loadPersisted(): ReplayTabsSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1) return null;
  if (!Array.isArray(p.tabs)) return null;
  const tabs: PersistedTab[] = p.tabs.map((entry) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return {
      selection: validateSelection(e.selection),
      // mergePrefs runs at hydrate time; here we just keep the raw partial.
      prefs: (e.prefs && typeof e.prefs === 'object'
        ? (e.prefs as Partial<ChartViewPrefs>)
        : {}),
    };
  });
  const activeIndexRaw = typeof p.activeIndex === 'number' ? p.activeIndex : 0;
  const activeIndex =
    tabs.length === 0 || activeIndexRaw < 0 || activeIndexRaw >= tabs.length
      ? 0
      : Math.floor(activeIndexRaw);
  const savedAt = typeof p.savedAt === 'number' ? p.savedAt : 0;
  return { version: 1, savedAt, activeIndex, tabs };
}

/** Hydrate a stored snapshot into live store shape. Returns the three slots
 *  (`tabs`, `prefs`, `activeTabId`) the caller must atomically `set()` to
 *  keep them consistent — see spec §"prefs Map 시드".
 *
 *  Pure with respect to `deps`: this module never reaches for `nanoid` or
 *  `DEFAULT_PREFS` itself, which keeps `state/tabs.ts ↔ tabsPersistence.ts`
 *  acyclic for value imports (only the type imports remain). */
export function fromSnapshot(
  snapshot: ReplayTabsSnapshot,
  deps: SnapshotDeps,
): { tabs: Tab[]; prefs: Map<string, ChartViewPrefs>; activeTabId: string } {
  if (snapshot.tabs.length === 0) {
    const seed = deps.freshTab();
    return { tabs: [seed], prefs: new Map(), activeTabId: seed.id };
  }
  const tabs: Tab[] = [];
  const prefs = new Map<string, ChartViewPrefs>();
  for (const persisted of snapshot.tabs) {
    const t = deps.freshTab();
    // Carry the persisted selection (already validated by loadPersisted).
    t.selection = persisted.selection;
    tabs.push(t);
    prefs.set(t.id, mergePrefs(persisted.prefs, deps.defaultPrefs, deps.chartToggleKeys));
  }
  const idx = Math.min(Math.max(0, snapshot.activeIndex), tabs.length - 1);
  return { tabs, prefs, activeTabId: tabs[idx].id };
}
