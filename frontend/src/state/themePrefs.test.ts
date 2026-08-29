import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
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
  // Reset the singleton store to a non-default value between tests, so a test
  // that asserts the default can't pass by accident.
  useThemePrefsStore.setState({ themePreference: 'ledger' });
});
afterEach(() => localStorage.clear());

describe('useThemePrefsStore', () => {
  it('저장된 `auto` 는 기본값으로 폴백한다 (2026-08-30 제거)', () => {
    // `auto` 는 **유효값이었다** — 이 폴백은 제거가 만든 새 경로이지 기존 동작이
    // 아니다. 마이그레이션 코드를 안 쓴 근거가 여기 걸려 있으므로, 화이트리스트가
    // 느슨해지면(예: 검증을 typeof 문자열로만 바꾸면) 여기서 빨개져야 한다.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ themePreference: 'auto' }));
    useThemePrefsStore.getState().hydrateFromStorage();
    expect(useThemePrefsStore.getState().themePreference).toBe('ledger'); // beforeEach 값 = 변화 없음

    // 모듈 로드 시점의 초기값 경로도 같은 화이트리스트를 탄다.
    expect(THEME_PREFERENCE_OPTIONS).not.toContain('auto' as ThemePreference);
  });

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
   * 로드 전에 돌아야 FOUC·잘못된 테마 차트 캐시를 막는다). 그래서 **기본값과 허용
   * 목록이 복제**돼 있다.
   *
   * 복제는 실제로 어긋난 적이 있다 — `auto` 시절 라우트 맵이 한쪽에만 '/market' 을
   * 얻어서, auto 로 /market 에 진입하면 ledger 로 칠했다가 obsidian 으로 뒤집혔다
   * (그 블록이 막으려던 FOUC 그 자체). 라우트 맵은 `auto` 와 함께 사라졌지만 나머지
   * 두 복제는 남았고, 같은 방식으로 어긋날 수 있다.
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

      expect(useThemePrefsStore.getState().themePreference).toBe('ledger'); // beforeEach 값
      unsubscribe();
    });
  });

  it('exposes exactly the four options', () => {
    expect([...THEME_PREFERENCE_OPTIONS]).toEqual([
      'obsidian',
      'ledger',
      'toss-light',
      'toss-dark',
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
    // pathname 도 여기서 되돌린다. 테스트 본문 끝에서 되돌리면 **그 테스트가 실패한
    // 순간 복구가 실행되지 않아** 뒤 테스트들이 남은 경로에서 돌고, 실패가 번져서
    // 어느 것이 진짜 결함인지 안 보인다(라우트 무관성 red-check 에서 실측: 목표 1개
    // 대신 3개가 빨개졌다).
    window.history.pushState({}, '', '/');
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

  it('라우트와 무관하게 선호를 그대로 쓴다', () => {
    // `auto` 제거(2026-08-30)가 만든 계약이다: **선호가 곧 테마**이고 pathname 은
    // 입력이 아니다. 라우트 분기가 되살아나면 여기서 빨개진다 — 그게 두 번째 DOM
    // writer 와 index.html 라우트 맵 복제를 다시 불러오는 첫 걸음이다.
    const unsubscribe = subscribeThemeToDom();

    window.history.pushState({}, '', '/live'); // auto 시절 obsidian 이던 라우트
    useThemePrefsStore.getState().setThemePreference('toss-light');
    expect(root.getAttribute('data-theme')).toBe('toss-light');

    window.history.pushState({}, '', '/screener'); // auto 시절 ledger 이던 라우트
    useThemePrefsStore.getState().setThemePreference('obsidian');
    expect(root.getAttribute('data-theme')).toBe('obsidian');
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
