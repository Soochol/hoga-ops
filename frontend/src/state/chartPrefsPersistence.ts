import {
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  DEFAULT_PREFS,
  type ChartViewPrefs,
  type DayBoundaryLineWidth,
} from './chartPrefs';
import type { useChartPrefsStore } from './chartPrefs';
import { attachPersistence } from './persistentSubscriber';

export const CHART_PREFS_KEY = 'hoga.chart.prefs.v1';
const WRITE_DEBOUNCE_MS = 250;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DAY_BOUNDARY_WIDTHS = new Set([1, 2, 3, 4]);

function isDayBoundaryLineWidth(v: unknown): v is DayBoundaryLineWidth {
  return typeof v === 'number' && DAY_BOUNDARY_WIDTHS.has(v);
}

export function mergePrefs(raw: unknown): ChartViewPrefs {
  const out: ChartViewPrefs = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const t of CHART_TOGGLES) {
    const v = obj[t.key];
    if (typeof v === 'boolean') (out as Record<string, unknown>)[t.key] = v;
  }
  for (const p of CHART_NUMERIC_PREFS) {
    const v = obj[p.key];
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= p.min && v <= p.max) {
      (out as Record<string, unknown>)[p.key] = v;
    }
  }
  if (typeof obj.dayBoundaryColor === 'string' && HEX_COLOR_RE.test(obj.dayBoundaryColor)) {
    out.dayBoundaryColor = obj.dayBoundaryColor.toUpperCase();
  }
  if (isDayBoundaryLineWidth(obj.dayBoundaryLineWidth)) {
    out.dayBoundaryLineWidth = obj.dayBoundaryLineWidth;
  }
  return out;
}

export function hydrateChartPrefs(store: typeof useChartPrefsStore): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CHART_PREFS_KEY);
    if (raw === null) return;
    const parsed = mergePrefs(JSON.parse(raw));
    store.setState(parsed);
  } catch {
    // localStorage unavailable / parse failure — fall back to DEFAULT_PREFS
  }
}

/**
 * Subscribe `useChartPrefsStore` to localStorage under `hoga.chart.prefs.v1`.
 *
 * Adapter shape: `attachPersistence` in `persistentSubscriber.ts` takes
 * `{ storageKey, toSnapshot, debounceMs }` and calls `JSON.stringify` on
 * the snapshot itself, so `toSnapshot` returns the plain prefs object
 * (action functions stripped) rather than a pre-serialized string.
 */
export function attachChartPrefsPersistence(store: typeof useChartPrefsStore): () => void {
  return attachPersistence(store, {
    storageKey: CHART_PREFS_KEY,
    debounceMs: WRITE_DEBOUNCE_MS,
    // Derive the snapshot from the registry so new action methods on the store
    // don't need an explicit ignore here — only registry-defined fields persist.
    toSnapshot: (s) =>
      Object.fromEntries(
        Object.keys(DEFAULT_PREFS).map((k) => [k, s[k as keyof ChartViewPrefs]]),
      ) as ChartViewPrefs,
  });
}
