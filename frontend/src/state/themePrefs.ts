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
 * drives `<html data-theme>`. The DOM sync has **two** writers, and the split
 * is load-bearing (see {@link subscribeThemeToDom}): a preference change is
 * applied *synchronously inside `set()`* by that subscription, and App.tsx's
 * effect owns the route axis (`auto` switching per pathname). An inline
 * bootstrap in index.html paints the first value — it must stay in sync with
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
 * Applying it to `<html data-theme>` is {@link subscribeThemeToDom}'s job: the
 * store change fires that listener, and under `auto` each tab resolves against
 * *its own* pathname — which is the point of keeping the preference (not the
 * effective theme) as the shared value.
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

/**
 * Apply the effective theme to `<html data-theme>` **the instant the preference
 * changes** — synchronously inside zustand's `set()`, before React flushes the
 * re-render it triggers.
 *
 * ⚠️ 이 동기성이 이 함수의 존재 이유다. App.tsx 의 이펙트만으로는 부족했고,
 * `useLayoutEffect` 로 바꿔도 부족하다 — **React 는 이펙트를 자식부터 실행한다**.
 * 테마 변경 커밋에서 차트(자식)의 생성 이펙트가 App(부모)의 DOM 쓰기보다 먼저
 * 돌아, `resolveTokensThemed` 가 **옛 CSS 변수**를 읽는다. 구독 리스너는 그
 * 커밋 자체보다 앞서므로 이후의 모든 렌더·이펙트가 새 속성을 본다.
 *
 * 이게 없으면 증상은 "테마가 안 바뀐다" 가 아니라 **"바로 안 바뀌고 스크롤하면
 * 바뀐다"** 로 나타난다 — 캔버스는 CSS 변수를 못 읽어 다시 그릴 때까지 옛 색을
 * 유지하고, 우발적 리렌더가 뒤늦게 고쳐 주기 때문이다(실측 2026-08-29: 클릭
 * 직후 캔버스 상위 3색의 **픽셀 카운트까지 동일**, 즉 리드로우 0회).
 *
 * 라우트 축(`auto` 의 pathname 전환)은 App.tsx 의 이펙트가 계속 소유한다 —
 * 여기서는 `window.location.pathname` 으로 현재 라우트를 읽으므로 두 writer 가
 * 같은 값을 쓴다(멱등 이중 쓰기라 무해).
 *
 * Returns an unsubscribe function (useEffect cleanup shape).
 */
export function subscribeThemeToDom(): () => void {
  return useThemePrefsStore.subscribe((state) => {
    document.documentElement.setAttribute(
      'data-theme',
      effectiveTheme(state.themePreference, window.location.pathname),
    );
  });
}

/**
 * 테마 변경을 **구독자의 리렌더로** 만든다. 반환값이 없는 것이 의도다 — 호출부가
 * 원하는 건 값이 아니라 리렌더이고, 실제 테마 문자열은 `currentThemeKey()` 가
 * DOM 에서 읽는다(그쪽이 {@link subscribeThemeToDom} 덕에 이미 새 값이다).
 *
 * 캔버스 루트(`LiveChartRoot`)가 이걸 필요로 하는 이유: `data-theme` 는 React
 * 밖의 DOM 변경이라 그 자체로는 어떤 컴포넌트도 리렌더시키지 않는다. 구독이
 * 없으면 차트는 다음 **우발적** 리렌더까지 옛 팔레트로 남는다.
 *
 * effective theme 이 그대로인 pref 변경(`/live` 에서 auto → obsidian)은 리렌더만
 * 되고 리마운트는 안 된다 — viewKey 세그먼트가 preference 가 아니라 effective
 * theme 을 쓰기 때문이다.
 */
export function useThemeChangeRerender(): void {
  useThemePrefsStore((s) => s.themePreference);
}
