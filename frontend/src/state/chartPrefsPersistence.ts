import { CHART_TOGGLES, CHART_NUMERIC_PREFS, DEFAULT_PREFS, type ChartViewPrefs } from './chartPrefs';
import type { useChartPrefsStore } from './chartPrefs';
import { attachPersistence } from './persistentSubscriber';

export const CHART_PREFS_KEY = 'hoga.chart.prefs.v1';
const WRITE_DEBOUNCE_MS = 250;

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
  // volumeProfileMode + movingAverages handled inline until Phase I removes them.
  if (obj.volumeProfileMode === 'range' || obj.volumeProfileMode === 'per-day') {
    out.volumeProfileMode = obj.volumeProfileMode;
  }
  if (Array.isArray(obj.movingAverages)) {
    out.movingAverages = obj.movingAverages.map((ma, i) => ({
      period: typeof (ma as { period?: number }).period === 'number'
        ? (ma as { period: number }).period
        : DEFAULT_PREFS.movingAverages[i]?.period ?? 20,
      enabled: typeof (ma as { enabled?: boolean }).enabled === 'boolean'
        ? (ma as { enabled: boolean }).enabled
        : DEFAULT_PREFS.movingAverages[i]?.enabled ?? false,
    }));
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
    toSnapshot: (s) => {
      const {
        setToggle: _setToggle,
        setNumericPref: _setNumericPref,
        setVolumeProfileMode: _setVolumeProfileMode,
        setMovingAverage: _setMovingAverage,
        resetToDefaults: _resetToDefaults,
        ...prefs
      } = s;
      void _setToggle;
      void _setNumericPref;
      void _setVolumeProfileMode;
      void _setMovingAverage;
      void _resetToDefaults;
      return prefs;
    },
  });
}
