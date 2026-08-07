import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

/**
 * UI theme preference — a global per-user setting.
 *
 * - `obsidian`   — the dark trading-terminal theme (default).
 * - `ledger`     — the light paper/research theme (ivory + banker's green).
 * - `toss-light` — the Toss Securities benchmark light theme (white + toss blue).
 *                  **The default preference** (2026-08-07). Still never produced
 *                  by `auto` — being the default and being auto-reachable are
 *                  different things (see below).
 * - `toss-dark`  — the Toss Securities benchmark dark theme (near-black + toss blue).
 *                  Manual-select only, same as toss-light.
 * - `auto`       — pick per route: the chart-heavy live surfaces stay dark, the
 *                  review/analysis surfaces go light. See {@link effectiveTheme}.
 *
 * The *preference* (obsidian/ledger/toss-light/toss-dark/auto) is what we
 * persist; the *effective* theme (obsidian/ledger/toss-light/toss-dark) is what
 * drives `<html data-theme>`. The DOM sync lives in App.tsx (and an inline
 * bootstrap in index.html for the first paint) so the store stays a pure state
 * holder — see index.html's bootstrap, which must stay in sync with
 * {@link effectiveTheme}.
 *
 * The two toss-* themes are intentionally kept OUT of `auto`: `auto` only
 * chooses between dark (obsidian) and the default light (ledger) per route, so
 * the extra palettes don't force a "which dark? which light?" branch into the
 * route logic — they are opt-in via an explicit preference only.
 */
export type ThemePreference = 'obsidian' | 'ledger' | 'toss-light' | 'toss-dark' | 'auto';
export type EffectiveTheme = 'obsidian' | 'ledger' | 'toss-light' | 'toss-dark';

export const THEME_PREFERENCE_OPTIONS: readonly ThemePreference[] = [
  'obsidian',
  'ledger',
  'toss-light',
  'toss-dark',
  'auto',
];

const STORAGE_KEY = 'ui.themePreference.v1';

/**
 * Preference used when nothing is stored (2026-08-07, 사용자 결정).
 *
 * Was `auto`, which picks a theme *per route* — so a single nav click
 * (히트맵 → 스크리너) flipped the whole app between dark and light. An explicit
 * default removes the route branch entirely: one theme everywhere.
 *
 * The cost is documented and accepted: Toss Light's accent and `--price-down`
 * are both blue (measured ΔE 17.3, vs 80.8 in Ledger and 139.2 in Obsidian).
 * The separation rests on a convention — accent rides solid fills (buttons,
 * active tab, focus, crosshair), down-price rides text and borders. See the
 * Toss Light note in DESIGN.md before touching either token.
 *
 * ⚠️ `index.html` duplicates this value in its first-paint bootstrap (it must
 * run before any module loads). themePrefs.test.ts fails if the two diverge.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'toss-light';

/** Route prefixes that stay dark under `auto`. Everything else goes light. */
// '/market'(시장 종합)은 장중 모니터링 표면이라 /live·/heatmap 과 같은 Obsidian 쪽이다.
// export 인 이유는 소비처가 있어서가 아니라 **테스트가 index.html 의 복제본과
// 대조**하기 때문이다(themePrefs.test.ts). 이 목록만 고치면 첫 페인트가 어긋난다.
export const OBSIDIAN_ROUTE_PREFIXES = ['/live', '/heatmap', '/market'];

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
  themePreference: readStorage() ?? DEFAULT_THEME_PREFERENCE,

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

/**
 * Mirror another tab's preference change into this tab — the theme is a global
 * per-user setting, so it should be global across the user's *open tabs* too.
 *
 * The value already lives in localStorage, which every tab shares. What was
 * missing is that a tab only ever *reads* it twice: the index.html bootstrap at
 * first paint, and this store's initializer at module load. So a tab opened
 * before the change (the `/live` deep links open in new tabs — see
 * live/liveNavigate.ts) kept painting the old theme until it was reloaded.
 *
 * No echo loop: `storage` fires only in the tabs that did *not* write, and
 * `hydrateFromStorage` reads without re-persisting.
 *
 * The event payload (`newValue`) is deliberately ignored — re-reading through
 * `hydrateFromStorage` runs the same validation as the initializer, so there is
 * one parse/validate path instead of two that can drift.
 *
 * Applying it to `<html data-theme>` is still App.tsx's existing effect: the
 * store change re-runs it, and under `auto` each tab resolves against *its own*
 * pathname — which is the point of keeping the preference (not the effective
 * theme) as the shared value.
 *
 * Returns an unsubscribe function (useEffect cleanup shape).
 */
export function subscribeToThemePreferenceStorage(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    useThemePrefsStore.getState().hydrateFromStorage();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
