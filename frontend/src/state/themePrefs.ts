import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';

/**
 * UI theme preference — a global per-user setting.
 *
 * - `obsidian`   — the dark trading-terminal theme.
 * - `ledger`     — the light paper/research theme (ivory + banker's green).
 * - `toss-light` — the Toss Securities benchmark light theme (white + toss blue).
 *                  **The default preference** (2026-08-07).
 * - `toss-dark`  — the Toss Securities benchmark dark theme (near-black + toss blue).
 *
 * **선호가 곧 테마다** — 네 값은 그대로 `<html data-theme>` 가 된다. 라우트별로
 * 갈리는 `auto` 가 있던 시절에는 preference(5개)와 effective theme(4개)이 다른
 * 개념이었고 `effectiveTheme(pref, pathname)` 이 그 사이를 옮겼다. 2026-08-30 에
 * `auto` 를 제거하면서 그 층이 통째로 사라졌다(사유는 DEFAULT_THEME_PREFERENCE 참조).
 *
 * DOM 쓰기의 **유일한 지점**은 {@link subscribeThemeToDom} 이다 — 선호 변경이
 * `set()` 안에서 동기로 반영된다. index.html 의 인라인 부트스트랩이 첫 페인트 값을
 * 칠하고, 그 복제는 themePrefs.test.ts 가 지킨다.
 */
export type ThemePreference = 'obsidian' | 'ledger' | 'toss-light' | 'toss-dark';

export const THEME_PREFERENCE_OPTIONS: readonly ThemePreference[] = [
  'obsidian',
  'ledger',
  'toss-light',
  'toss-dark',
];

const STORAGE_KEY = 'ui.themePreference.v1';

/**
 * Preference used when nothing is stored (2026-08-07, 사용자 결정).
 *
 * Was `auto`, which picked a theme *per route* — so a single nav click
 * (히트맵 → 스크리너) flipped the whole app between dark and light. An explicit
 * default removes the route branch entirely: one theme everywhere.
 *
 * **`auto` 자체는 2026-08-30 에 제거됐다**(사용자 결정). 기본값에서 밀려난 뒤로
 * 남은 값어치는 "그 뒤집힘을 원하는 사람을 위한 옵션" 뿐이었는데, 그 옵션 하나가
 * 지고 있던 비용이 컸다: ① index.html 부트스트랩에 라우트 맵이 **복제**돼 있었고
 * 실제로 한 번 어긋나 FOUC 를 냈다(`/market`), ② 그 복제를 지키는 가드 테스트,
 * ③ 라우트 축을 위한 **두 번째 DOM writer**(App.tsx), ④ 그 writer 가 자식 이펙트보다
 * 늦어 생기는 순서 갭(#1656 이 의도적으로 남긴 엣지), ⑤ preference ≠ effective
 * theme 이라는 개념 이중화. 다섯 가지가 `auto` 와 함께 사라졌다.
 *
 * 저장된 `'auto'` 는 마이그레이션 없이 이 기본값으로 폴백한다 — `readStorage` 가
 * 화이트리스트 검증이라 목록에 없는 값은 `null` 이 된다.
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
 * Applying it to `<html data-theme>` is {@link subscribeThemeToDom}'s job — the
 * store change fires that listener in every tab that mirrored the value.
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
 * Write the preference to `<html data-theme>` **the instant it changes** —
 * synchronously inside zustand's `set()`, before React flushes the re-render it
 * triggers. **이 앱에서 `data-theme` 를 쓰는 유일한 지점이다**(첫 페인트 부트스트랩
 * 제외). `auto` 가 있던 시절엔 App.tsx 의 이펙트가 라우트 축을 나눠 가졌지만,
 * 그 축이 사라지면서 writer 가 하나로 줄었다.
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
 * **등록 시 현재 값을 한 번 쓴다** — 구독만 걸면 *변경*에만 반응하므로 마운트 시점의
 * 동기화가 사라진다. 정상 경로에서는 index.html 부트스트랩이 같은 localStorage 를
 * 같은 화이트리스트로 읽어 이미 일치하지만, 부트스트랩이 **예외로 떨어지면**
 * (localStorage 차단 등) `catch` 가 'obsidian' 을 써 놓고 스토어는 다른 값으로
 * 서 있다. 그 어긋남을 고칠 것이 아무것도 없어진다 — `auto` 시절 App 이펙트가
 * 마운트 때 우연히 해 주던 일이라, 옮기면서 같이 잃기 쉽다(실제로 잃었고 App.test
 * 의 탭 전역 테스트가 잡았다).
 *
 * Returns an unsubscribe function (useEffect cleanup shape).
 */
export function subscribeThemeToDom(): () => void {
  const apply = (pref: ThemePreference) =>
    document.documentElement.setAttribute('data-theme', pref);
  apply(useThemePrefsStore.getState().themePreference);
  return useThemePrefsStore.subscribe((state) => apply(state.themePreference));
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
 * `auto` 가 있던 시절엔 「effective theme 이 그대로인 pref 변경」(`/live` 에서
 * auto → obsidian)이 있어서 리렌더만 되고 리마운트는 안 되는 경우가 존재했다.
 * 선호가 곧 테마인 지금은 모든 선호 변경이 곧 테마 변경이라 항상 리마운트로 간다.
 */
export function useThemeChangeRerender(): void {
  useThemePrefsStore((s) => s.themePreference);
}
