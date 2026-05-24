import type { Tab, TabSelection, ChartViewPrefs } from './tabs';
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
};

export type ToSnapshotInput = {
  tabs: readonly Tab[];
  activeTabId: string;
  prefs: ReadonlyMap<string, ChartViewPrefs>;
  defaultPrefs: ChartViewPrefs;
};

/** Pure projection: live store state → durable snapshot.
 *  Excludes bundles / cursorMs / status / id — see spec table. */
export function toSnapshot(input: ToSnapshotInput): ReplayTabsSnapshot {
  const { tabs, activeTabId, prefs, defaultPrefs } = input;
  const foundIdx = tabs.findIndex((t) => t.id === activeTabId);
  const activeIndex = foundIdx >= 0 ? foundIdx : 0;
  return {
    version: 1,
    savedAt: Date.now(),
    activeIndex,
    tabs: tabs.map((t) => ({
      selection: t.selection,
      prefs: prefs.get(t.id) ?? defaultPrefs,
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

const VOLUME_PROFILE_MODES = new Set(['range', 'per-day'] as const);

function isValidMA(m: unknown): m is { period: number; enabled: boolean } {
  if (m === null || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return typeof o.period === 'number' && Number.isFinite(o.period) && typeof o.enabled === 'boolean';
}

/** Merge a `Partial<ChartViewPrefs>` over `defaults`. Unknown keys ignored;
 *  malformed values fall back to the default for that key. */
export function mergePrefs(
  partial: Partial<ChartViewPrefs> | undefined,
  defaults: ChartViewPrefs,
): ChartViewPrefs {
  const p = (partial ?? {}) as Record<string, unknown>;
  const out: ChartViewPrefs = {
    volumeProfileMode: defaults.volumeProfileMode,
    movingAverages: defaults.movingAverages.map((m) => ({ ...m })),
    auctionWindowMask: defaults.auctionWindowMask,
  };
  if (typeof p.volumeProfileMode === 'string'
      && VOLUME_PROFILE_MODES.has(p.volumeProfileMode as 'range' | 'per-day')) {
    out.volumeProfileMode = p.volumeProfileMode as 'range' | 'per-day';
  }
  if (typeof p.auctionWindowMask === 'boolean') {
    out.auctionWindowMask = p.auctionWindowMask;
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
