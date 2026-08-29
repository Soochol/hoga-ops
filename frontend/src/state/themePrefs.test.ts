import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  effectiveTheme,
  OBSIDIAN_ROUTE_PREFIXES,
  subscribeThemeToDom,
  subscribeToThemePreferenceStorage,
  THEME_PREFERENCE_OPTIONS,
  useThemePrefsStore,
  type ThemePreference,
} from './themePrefs';
// vite 의 `?raw` 로 소스 텍스트를 인라인한다 — routeSplitting.test.ts 와 같은 방식
// (`node:fs` 는 이 프로젝트의 타입 범위 밖이다).
import INDEX_HTML from '../../index.html?raw';

const STORAGE_KEY = 'ui.themePreference.v1';

beforeEach(() => {
  localStorage.clear();
  // Reset the singleton store to its default between tests.
  useThemePrefsStore.setState({ themePreference: 'auto' });
});
afterEach(() => localStorage.clear());

describe('effectiveTheme', () => {
  it('maps auto → obsidian on live/heatmap/market, ledger elsewhere', () => {
    expect(effectiveTheme('auto', '/live')).toBe('obsidian');
    expect(effectiveTheme('auto', '/live/anything')).toBe('obsidian');
    expect(effectiveTheme('auto', '/heatmap')).toBe('obsidian');
    // '/market' 은 목록에 있는데 이 테스트에도 index.html 에도 없었다 — 커버리지
    // 구멍이 드리프트 위치와 정확히 일치했다.
    expect(effectiveTheme('auto', '/market')).toBe('obsidian');
    expect(effectiveTheme('auto', '/study')).toBe('ledger');
    expect(effectiveTheme('auto', '/screener')).toBe('ledger');
    expect(effectiveTheme('auto', '/settings')).toBe('ledger');
    expect(effectiveTheme('auto', '/')).toBe('ledger');
  });

  it('ignores the route for an explicit preference', () => {
    expect(effectiveTheme('obsidian', '/study')).toBe('obsidian');
    expect(effectiveTheme('ledger', '/live')).toBe('ledger');
    // toss-* are manual-only: an explicit preference is returned as-is on
    // every route, and `auto` never resolves to them (see the maps above).
    expect(effectiveTheme('toss-light', '/live')).toBe('toss-light');
    expect(effectiveTheme('toss-light', '/settings')).toBe('toss-light');
    expect(effectiveTheme('toss-dark', '/live')).toBe('toss-dark');
    expect(effectiveTheme('toss-dark', '/settings')).toBe('toss-dark');
  });

  it('does not treat a look-alike prefix as a live route', () => {
    // '/liveries' must NOT match '/live'.
    expect(effectiveTheme('auto', '/liveries')).toBe('ledger');
  });
});

describe('useThemePrefsStore', () => {
  it('falls back to DEFAULT_THEME_PREFERENCE when nothing is stored', () => {
    // 저장값이 없을 때 스토어가 무엇으로 시작하는지는 모듈 로드 시점에 한 번
    // 정해지므로(beforeEach 가 덮어쓴다) 상수 자체를 못박는다. 라우트별 테마
    // 전환을 없앤 결정이라 `auto` 로 되돌아가면 그 결정이 조용히 풀린다.
    expect(DEFAULT_THEME_PREFERENCE).toBe('toss-light');
    expect(THEME_PREFERENCE_OPTIONS).toContain(DEFAULT_THEME_PREFERENCE);
  });

  it('persists a set preference and rejects invalid values', () => {
    useThemePrefsStore.getState().setThemePreference('ledger');
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ themePreference: 'ledger' });

    useThemePrefsStore.getState().setThemePreference('nonsense' as ThemePreference);
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger'); // unchanged
  });

  it('hydrates a valid stored value and falls back on a corrupt one', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'obsidian' }));
    useThemePrefsStore.getState().hydrateFromStorage();
    expect(useThemePrefsStore.getState().themePreference).toBe('obsidian');

    localStorage.setItem(STORAGE_KEY, '{ not json');
    useThemePrefsStore.setState({ themePreference: 'ledger' });
    useThemePrefsStore.getState().hydrateFromStorage(); // no valid value → no change
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
  });

  /**
   * index.html 의 첫 페인트 부트스트랩은 이 모듈을 import 할 수 없다(모듈 그래프
   * 로드 전에 돌아야 FOUC·잘못된 테마 차트 캐시를 막는다). 그래서 기본값과 auto
   * 라우트 맵이 **복제**돼 있고, 실제로 한 번 어긋났다 — `OBSIDIAN_ROUTE_PREFIXES`
   * 에 '/market' 이 추가됐는데 index.html 은 안 따라가서, auto 로 /market 에
   * 진입하면 ledger 로 칠했다가 obsidian 으로 뒤집혔다.
   *
   * 복제를 없앨 수 없으니 이탈을 실패로 만든다.
   */
  describe('index.html 첫 페인트 부트스트랩 동기', () => {
    it('기본 선호값이 DEFAULT_THEME_PREFERENCE 와 같다', () => {
      // 부트스트랩엔 기본값이 **두 군데** 있다. 3항 연산자(저장값 없음)와 유효성
      // 폴백(저장값이 깨짐). 둘을 따로 잡는다 — 처음엔 `pref = '…'` 하나로만
      // 훑었더니 3항 쪽을 놓쳐서, 기본값을 auto 로 되돌려도 테스트가 통과했다.
      const ternary = INDEX_HTML.match(/themePreference\s*:\s*'([a-z-]+)'/);
      const fallback = INDEX_HTML.match(/pref\s*=\s*'([a-z-]+)'/);
      expect(ternary, '저장값 없음 분기를 찾지 못했다').not.toBeNull();
      expect(fallback, '유효성 폴백 분기를 찾지 못했다').not.toBeNull();
      expect(ternary![1]).toBe(DEFAULT_THEME_PREFERENCE);
      expect(fallback![1]).toBe(DEFAULT_THEME_PREFERENCE);
    });

    it('auto 다크 라우트 목록이 OBSIDIAN_ROUTE_PREFIXES 와 같다', () => {
      const line = INDEX_HTML.split('\n').find((l) => l.includes('var dark ='));
      expect(line, 'index.html 의 `var dark =` 줄을 찾지 못했다').toBeDefined();
      const routes = [...line!.matchAll(/'(\/[a-z]+)\/?'/g)].map((m) => m[1]);
      expect([...new Set(routes)].sort()).toEqual([...OBSIDIAN_ROUTE_PREFIXES].sort());
    });

    it('허용 선호값 목록이 THEME_PREFERENCE_OPTIONS 와 같다', () => {
      const line = INDEX_HTML.split('\n').find((l) => l.includes("pref !== 'obsidian'"));
      expect(line).toBeDefined();
      const opts = [...line!.matchAll(/pref !== '([a-z-]+)'/g)].map((m) => m[1]);
      expect(opts.sort()).toEqual([...THEME_PREFERENCE_OPTIONS].sort());
    });
  });

  /**
   * 탭 전역 동기. `storage` 는 **쓰지 않은 탭에서만** 발생하므로, 이 구독은 원리적으로
   * 자기 자신의 쓰기를 되받지 않는다(에코 없음). 여기서는 그 이벤트가 실제로 저장소를
   * 다시 읽게 만드는지, 그리고 해제가 먹는지를 본다.
   */
  describe('subscribeToThemePreferenceStorage', () => {
    it('다른 탭의 쓰기를 반영하고, 해제하면 더 이상 반영하지 않는다', () => {
      const unsubscribe = subscribeToThemePreferenceStorage();

      // 순서가 중요하다: hydrateFromStorage 는 event.newValue 가 아니라 저장소를
      // 다시 읽으므로, 값을 먼저 써 두지 않으면 이벤트만 쏴도 아무 일이 없다.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'obsidian' }));
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
      expect(useThemePrefsStore.getState().themePreference).toBe('obsidian');

      unsubscribe();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'ledger' }));
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
      expect(useThemePrefsStore.getState().themePreference).toBe('obsidian'); // 그대로
    });

    it('다른 키의 storage 이벤트는 무시한다', () => {
      // 키 필터가 없으면 모든 스토어의 쓰기(watchlist·workspace·live.page…)마다
      // hydrate 가 돌고, 그때 우연히 테마 키에 남아 있던 값이 되살아난다.
      const unsubscribe = subscribeToThemePreferenceStorage();

      localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'obsidian' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'live.page.v1' }));

      expect(useThemePrefsStore.getState().themePreference).toBe('auto'); // beforeEach 값
      unsubscribe();
    });
  });

  it('exposes exactly the five options', () => {
    expect([...THEME_PREFERENCE_OPTIONS]).toEqual([
      'obsidian',
      'ledger',
      'toss-light',
      'toss-dark',
      'auto',
    ]);
  });
});

describe('subscribeThemeToDom', () => {
  const root = document.documentElement;
  let prevTheme: string | null = null;

  beforeEach(() => {
    prevTheme = root.getAttribute('data-theme');
  });
  afterEach(() => {
    // 속성이 다음 테스트로 새면 `currentThemeKey()` 를 읽는 차트/토큰 테스트가
    // 조용히 다른 팔레트를 본다.
    if (prevTheme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prevTheme);
  });

  it('선호 변경을 `set()` 안에서 **동기로** DOM 에 반영한다', () => {
    // 이 테스트의 대상은 값이 아니라 **시점**이다. 이펙트(또는 layoutEffect) 기반
    // 구현이면 이 시점의 DOM 은 아직 옛 값이고, 그 한 커밋의 지연이 캔버스를 옛
    // 팔레트로 그리게 한다 — 사용자에게는 "스크롤해야 바뀐다" 로 보였다.
    const unsubscribe = subscribeThemeToDom();
    root.setAttribute('data-theme', 'toss-light');

    useThemePrefsStore.getState().setThemePreference('obsidian');

    // `await` 도 `act()` 도 없다. 그게 단언의 내용이다.
    expect(root.getAttribute('data-theme')).toBe('obsidian');
    unsubscribe();
  });

  it('`auto` 는 현재 pathname 으로 해석한다', () => {
    const unsubscribe = subscribeThemeToDom();
    window.history.pushState({}, '', '/live');

    useThemePrefsStore.getState().setThemePreference('auto');
    expect(root.getAttribute('data-theme')).toBe('obsidian');

    window.history.pushState({}, '', '/screener');
    useThemePrefsStore.getState().setThemePreference('ledger');
    useThemePrefsStore.getState().setThemePreference('auto');
    expect(root.getAttribute('data-theme')).toBe('ledger');

    window.history.pushState({}, '', '/');
    unsubscribe();
  });

  it('구독 해제 후에는 쓰지 않는다', () => {
    const unsubscribe = subscribeThemeToDom();
    unsubscribe();
    root.setAttribute('data-theme', 'toss-light');

    useThemePrefsStore.getState().setThemePreference('obsidian');

    expect(root.getAttribute('data-theme')).toBe('toss-light');
  });

  it('다른 탭의 변경(hydrateFromStorage)도 같은 경로로 반영된다', () => {
    // `subscribeToThemePreferenceStorage` 는 `set()` 을 태우므로 이 구독이 그대로
    // 이어받는다 — 크로스탭 동기화에 별도 DOM writer 를 만들지 않는 근거다.
    const unsubscribeDom = subscribeThemeToDom();
    const unsubscribeStorage = subscribeToThemePreferenceStorage();
    root.setAttribute('data-theme', 'toss-light');

    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'toss-dark' }));
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));

    expect(root.getAttribute('data-theme')).toBe('toss-dark');
    unsubscribeStorage();
    unsubscribeDom();
  });
});
