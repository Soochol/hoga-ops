import { createContext } from 'react';
import { create } from 'zustand';
import { HIGH_LOW_WINDOW_PREF_KEYS, normalizeChartDisplayPrefs } from './chartDisplayPrefs';
import { persistJson, readJsonObject } from './persist';

/** Add a typed section here to share validation, persistence and preset transport.
 * Settings belong to a window, independently of its symbol or timeframe. */
const WINDOW_SETTINGS_REGISTRY = {
  chart: { kind: 'chart', normalize: normalizeChartDisplayPrefs },
} as const;
export type WindowSettings = { [K in keyof typeof WINDOW_SETTINGS_REGISTRY]?: ReturnType<(typeof WINDOW_SETTINGS_REGISTRY)[K]['normalize']> };
export type WindowSettingsSection = keyof WindowSettings;
export const WINDOW_SETTINGS_KEY = 'hoga.window.settings.v1';
export const WindowSettingsScope = createContext<string | null>(null);

function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function normalizeWindowSettings(raw: unknown, kind?: string, fillDefaults = false): WindowSettings {
  const source = object(raw);
  return Object.fromEntries(Object.entries(WINDOW_SETTINGS_REGISTRY)
    .filter(([key, def]) => (!kind || def.kind === kind) && (fillDefaults || Object.hasOwn(source, key)))
    .map(([key, def]) => [key, def.normalize(source[key])])) as WindowSettings;
}

export function normalizeWindowSettingsSnapshot(raw: unknown, legacyChartPrefs?: unknown): { schema_version: 1; byWindow: Record<string, WindowSettings> } {
  const source = object(raw);
  const entries = source.schema_version === 1 ? Object.entries(object(source.byWindow)) : [];
  return { schema_version: 1, byWindow: Object.fromEntries(entries
    .filter(([id, value]) => id && !['__proto__', 'prototype', 'constructor'].includes(id) && value && typeof value === 'object' && !Array.isArray(value))
    .slice(0, 1024).map(([id, value]) => {
      const settings = object(value);
      const chart = object(settings.chart);
      // Existing chart sections predate these fields. Inherit only absent keys;
      // explicit false, theme colors and widths always win over legacy globals.
      const inherited = Object.fromEntries(HIGH_LOW_WINDOW_PREF_KEYS
        .filter(key => !Object.hasOwn(chart, key)).map(key => [key, object(legacyChartPrefs)[key]]));
      return [id, normalizeWindowSettings(Object.hasOwn(settings, 'chart')
        ? { ...settings, chart: { ...inherited, ...chart } } : settings)];
    })) };
}

type WindowSettingsStore = {
  byWindow: Record<string, WindowSettings>;
  seed: (id: string, defaults: WindowSettings, sourceId?: string | null) => void;
  patch: <K extends WindowSettingsSection>(id: string, section: K, patch: Partial<NonNullable<WindowSettings[K]>>) => void;
  restore: (entries: readonly { id: string; settings: WindowSettings }[]) => void;
  drop: (ids: readonly string[]) => void;
};

export const useWindowSettingsStore = create<WindowSettingsStore>((set, get) => ({
  byWindow: normalizeWindowSettingsSnapshot(readJsonObject(WINDOW_SETTINGS_KEY), readJsonObject('hoga.chart.prefs.v1')).byWindow,
  seed: (id, defaults, sourceId) => {
    const current = get().byWindow[id];
    if (current && Object.keys(defaults).every(section => Object.hasOwn(current, section))) return;
    const source = sourceId ? get().byWindow[sourceId] : undefined;
    const inherited = Object.fromEntries(Object.keys(defaults).filter(key => source && Object.hasOwn(source, key))
      .map(key => [key, source![key as WindowSettingsSection]]));
    const settings = normalizeWindowSettings({ ...defaults, ...inherited, ...current });
    if (!Object.keys(settings).length) return;
    set(state => ({ byWindow: { ...state.byWindow, [id]: settings } }));
  },
  patch: (id, section, patch) => set(state => ({ byWindow: { ...state.byWindow, [id]: {
    ...state.byWindow[id],
    [section]: WINDOW_SETTINGS_REGISTRY[section].normalize({ ...state.byWindow[id]?.[section], ...patch }),
  } } })),
  restore: entries => {
    if (!entries.length) return;
    set(state => ({ byWindow: { ...state.byWindow,
      ...Object.fromEntries(entries.map(({ id, settings }) => [id, {
        ...state.byWindow[id], ...normalizeWindowSettings(settings),
      }])),
    } }));
  },
  drop: ids => {
    if (!ids.some(id => Object.hasOwn(get().byWindow, id))) return;
    set(state => {
      const byWindow = { ...state.byWindow };
      for (const id of ids) delete byWindow[id];
      return { byWindow };
    });
  },
}));

// Settings edits are infrequent. Persist synchronously so an immediate reload
// or preset switch cannot discard the last toggle. Byte equality stops tab echoes.
const stop = useWindowSettingsStore.subscribe(state => {
  const snapshot = { schema_version: 1, byWindow: state.byWindow };
  try {
    if (localStorage.getItem(WINDOW_SETTINGS_KEY) === JSON.stringify(snapshot)) return;
    persistJson(WINDOW_SETTINGS_KEY, snapshot);
  } catch { /* Storage can be unavailable in private mode. */ }
});
if (import.meta.hot) import.meta.hot.dispose(stop);

export function subscribeToWindowSettingsStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== WINDOW_SETTINGS_KEY) return;
    useWindowSettingsStore.setState({ byWindow: normalizeWindowSettingsSnapshot(readJsonObject(WINDOW_SETTINGS_KEY), readJsonObject('hoga.chart.prefs.v1')).byWindow });
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
