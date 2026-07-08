import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

/**
 * UI theme preference — a global per-user setting.
 *
 * - `obsidian` — the dark trading-terminal theme (default).
 * - `ledger`   — the light paper/research theme.
 * - `auto`     — pick per route: the chart-heavy live surfaces stay dark, the
 *                review/analysis surfaces go light. See {@link effectiveTheme}.
 *
 * The *preference* (obsidian/ledger/auto) is what we persist; the *effective*
 * theme (obsidian/ledger) is what drives `<html data-theme>`. The DOM sync lives
 * in App.tsx (and an inline bootstrap in index.html for the first paint) so the
 * store stays a pure state holder — see index.html's bootstrap, which must stay
 * in sync with {@link effectiveTheme}.
 */
export type ThemePreference = 'obsidian' | 'ledger' | 'auto';
export type EffectiveTheme = 'obsidian' | 'ledger';

export const THEME_PREFERENCE_OPTIONS: readonly ThemePreference[] = ['obsidian', 'ledger', 'auto'];

const STORAGE_KEY = 'ui.themePreference.v1';

/** Route prefixes that stay dark under `auto`. Everything else goes light. */
const OBSIDIAN_ROUTE_PREFIXES = ['/live', '/heatmap'];

/**
 * Resolve a preference + current pathname to the theme that should be applied.
 * `auto` maps the chart-heavy live surfaces to obsidian and the rest to ledger;
 * an explicit preference ignores the route.
 */
export function effectiveTheme(pref: ThemePreference, pathname: string): EffectiveTheme {
  if (pref !== 'auto') return pref;
  return OBSIDIAN_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
    ? 'obsidian'
    : 'ledger';
}

function readStorage(): ThemePreference | null {
  const obj = readJsonObject(STORAGE_KEY);
  const value = obj.themePreference;
  if (typeof value === 'string' && THEME_PREFERENCE_OPTIONS.includes(value as ThemePreference)) {
    return value as ThemePreference;
  }
  return null;
}

interface Store {
  themePreference: ThemePreference;
  setThemePreference: (value: ThemePreference) => void;
  hydrateFromStorage: () => void;
}

export const useThemePrefsStore = create<Store>((set) => ({
  themePreference: readStorage() ?? 'auto',

  setThemePreference: (value) => {
    if (!THEME_PREFERENCE_OPTIONS.includes(value)) return;
    set({ themePreference: value });
    persistJson(STORAGE_KEY, { themePreference: value });
  },

  hydrateFromStorage: () => {
    const stored = readStorage();
    if (stored) set({ themePreference: stored });
  },
}));
