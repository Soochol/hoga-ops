import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import App from './App';
import { useRightRailStore } from './state/rightRail';
import { DEFAULT_THEME_PREFERENCE, useThemePrefsStore } from './state/themePrefs';

vi.mock('./api/eventStream', () => ({
  useEventStream: () => {},
  lastHeartbeat: () => 0,
  subscribeToScreenerUpdateEvents: () => () => {},
  subscribeToKiwoomFullHouseEvents: () => () => {},
}));

vi.mock('./capture/useCaptureQueue', () => ({
  useCaptureQueueSync: () => {},
}));

vi.mock('./inventory/useInventoryRecaptureOrigins', () => ({
  useInventoryRecaptureOriginsCleanup: () => {},
}));

vi.mock('./nav/CaptureInlineStatus', () => ({
  CaptureInlineStatus: () => null,
}));

vi.mock('./rightrail/RightRail', () => ({
  default: () => <aside data-testid="right-rail" />,
}));

vi.mock('./watchlist/WatchlistDrawer', () => ({
  WatchlistDrawer: () => <aside data-testid="watchlist-drawer" />,
}));

vi.mock('./heatmap/HeatmapDrawer', () => ({
  HeatmapDrawer: () => <aside data-testid="heatmap-drawer" />,
}));

vi.mock('./screener/ScreenerDrawer', () => ({
  ScreenerDrawer: () => <aside data-testid="screener-drawer" />,
}));

vi.mock('./studyViews/StudyViewsDrawer', () => ({
  StudyViewsDrawer: () => <aside data-testid="study-views-drawer" />,
}));

vi.mock('./signalAlerts/SignalAlertToastHost', () => ({
  default: () => <aside data-testid="signal-alert-toast-host" />,
}));

vi.mock('./signalAlerts/useSignalAlertEvents', () => ({
  useSignalAlertEvents: () => {},
}));

// 설정 본체는 이제 `live/SettingsSections` 하나다 — App 은 그것을 lazy 로 열고,
// `pages/Settings` 는 `/settings` 라우트 프레임으로만 남아 App 이 참조하지 않는다.
vi.mock('./live/SettingsSections', () => ({
  default: () => <div>settings panel body</div>,
}));

function wrap(ui: ReactNode, initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<App />}>
            <Route path="/live" element={<div>live page</div>} />
            <Route path="/study" element={<div>study page</div>} />
            <Route path="/ad-hoc" element={<div>ad hoc page</div>} />
            <Route path="/heatmap" element={ui} />
            <Route path="/inventory" element={ui} />
            <Route path="/screener" element={ui} />
            <Route path="/capture" element={ui} />
            <Route path="/settings" element={ui} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  document.title = 'before-test';
  useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App document title', () => {
  it.each([
    ['/heatmap', '히트맵'],
    ['/screener', '스크리너'],
    ['/inventory', '보관함'],
    ['/capture', '캡처'],
    // `/settings` 는 빠졌다 — 라우트가 아니라 드로어라 탭 제목을 가질 페이지가 없다.
  ])('sets %s to the matching top menu label', (path, expected) => {
    wrap(<div>{expected}</div>, path);
    expect(document.title).toBe(expected);
  });

  it('leaves /live to the LivePage title writer', () => {
    wrap(<div>unused</div>, '/live?code=005930');
    expect(document.title).toBe('before-test');
  });

  it('leaves /study to the StudyPage title writer', () => {
    // `/live` 와 같은 이유로 표에서 빠졌다 — 저장뷰가 열려 있으면 제목이 nav 라벨
    // 「복기」가 아니라 **종목명 + 저장뷰 이름**이고, 그 재료는 페이지만 안다.
    wrap(<div>unused</div>, '/study');
    expect(document.title).toBe('before-test');
  });

  it('uses hoga-ops for routes without a side menu item', () => {
    wrap(<div>unused</div>, '/ad-hoc');
    expect(document.title).toBe('hoga-ops');
  });
});

describe('App shell layout', () => {
  it('renders a column shell (main stack | full-height right panel) with the main stack as 3 rows', () => {
    const { container } = wrap(<div>Heatmap</div>, '/heatmap');
    const shell = container.firstElementChild as HTMLElement;
    const mainStack = screen.getByTestId('app-main-stack');

    expect(screen.getByRole('navigation', { name: '주요 메뉴' })).toBeInTheDocument();
    // 열 기반 셸: 우측 패널(레일)이 full-height 열, 왼쪽 스택이 1fr — 헤더는 우측 패널 위를 양보.
    expect(shell.style.gridTemplateColumns).toBe('1fr var(--rail-w)');
    // 행도 명시해야 한다. 예전에는 이 단언이 `''`(미지정)이었는데, 그러면
    // `grid-auto-rows: auto` 가 되고 auto 트랙은 콘텐츠가 원하는 만큼 커진다 —
    // h-screen 보다 낮은 뷰포트에서 셸이 화면 밖으로 밀렸다(뷰포트 260px 에서 트랙
    // 341px). 아이템의 min-h-0 은 *트랙* 최소값을 풀지 못한다.
    expect(shell.style.gridTemplateRows).toBe('minmax(0, 1fr)');
    // 왼쪽 스택: top nav / 페이지 / 하단 바(auto — 바 null 이면 0 으로 접힘) 3행.
    expect(mainStack.style.gridTemplateRows).toBe('var(--h-top-nav) minmax(0, 1fr) auto');
  });

  it('holds a responsive floor instead of compressing below it (min-w, not 100vw)', () => {
    const { container } = wrap(<div>Heatmap</div>, '/heatmap');
    const shell = container.firstElementChild as HTMLElement;

    // 바닥은 토큰 1개(--app-floor-min-w)가 소유한다. 유효 폭이 바닥보다 좁아지면
    // 셸이 계속 눌리는 대신 #root 가 가로 스크롤을 얻는다(스크롤 소유자는
    // global.css). jsdom 은 레이아웃을 안 하므로 여기서는 "정책이 선언돼 있는가"만
    // 지킨다 — 실제 전환 폭은 /browse 실측(1026px)으로 확인.
    expect(shell.className).toContain('min-w-app-floor');
    // 세로 바닥도 대칭으로 있어야 한다 — 없으면 줌인 시 /live 창이 계속 납작해져
    // 호가 단수가 조용히 잘린다(ADR-0122).
    expect(shell.className).toContain('min-h-app-floor');
    // w-screen(100vw) 금지: 100vw 는 세로 스크롤바 폭을 포함해, 바닥 아래에서 셸이
    // 항상 뷰포트보다 넓어지고 가로 스크롤바가 세로 스크롤바를 부른다.
    expect(shell.className).not.toContain('w-screen');
  });

  it('adds exactly one right panel column before the fixed rail when a panel is open', () => {
    useRightRailStore.setState({ activePanel: 'watchlist', lastPanel: 'watchlist' });

    wrap(<div>Heatmap</div>, '/heatmap');

    expect(screen.getByTestId('app-content-grid')).toHaveStyle({
      gridTemplateColumns: '1fr var(--watchlist-panel-w) var(--rail-w)',
    });
    expect(screen.getByTestId('watchlist-drawer')).toBeInTheDocument();
  });

  // 드로어·설정 패널은 lazy(초기 번들에서 제외 — App.tsx 주석 참고)라 마운트가
  // 비동기다. `findBy*` 는 청크가 해석될 때까지 기다린다. 레이아웃(그리드 열)은
  // Suspense 가 DOM 요소를 만들지 않으므로 fallback 단계에서도 이미 확정이다.
  it('mounts the heatmap drawer when the heatmap panel is active', async () => {
    useRightRailStore.setState({ activePanel: 'heatmap', lastPanel: 'heatmap' });

    wrap(<div>Heatmap</div>, '/heatmap');

    expect(screen.getByTestId('app-content-grid')).toHaveStyle({
      gridTemplateColumns: '1fr var(--watchlist-panel-w) var(--rail-w)',
    });
    expect(await screen.findByTestId('heatmap-drawer')).toBeInTheDocument();
  });

  it('opens Settings as a right drawer without leaving the current page', async () => {
    wrap(<div>unused</div>, '/live');

    fireEvent.click(screen.getByRole('button', { name: '설정' }));

    // 모달 껍데기(ModalShell)는 정적이라 즉시 뜬다 — 안쪽 패널만 lazy 다.
    const dialog = screen.getByRole('dialog', { name: '설정' });
    // `/live`·`/study` 툴바 ⚙ 와 **같은 크롬**(우측 드로어)이다. 옛 중앙 모달
    // (720×560 하드코딩)은 설정 표면이 하나로 합쳐지면서 사라졌다 — 진입점이 달라도
    // 폭·앵커·nav 가 같아야 「설정은 하나」가 화면에서도 참이다.
    expect(dialog).toHaveClass('fixed', 'inset-0', 'items-stretch', 'justify-end');
    expect(await within(dialog).findByText('settings panel body')).toBeInTheDocument();
    expect(screen.getByText('live page')).toBeInTheDocument();
  });

  it('closes the Settings drawer with Escape', async () => {
    wrap(<div>unused</div>, '/live');

    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    // 패널이 실제로 마운트된 뒤 닫아야 "열렸다가 닫혔다"를 검증한다 — 기다리지 않으면
    // lazy 해석 전에 Escape 를 눌러 빈 모달을 닫는 셈이 된다.
    await screen.findByText('settings panel body');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
    expect(screen.getByText('live page')).toBeInTheDocument();
  });

  // ↓ 두 건은 `SettingsDrawer.test.tsx` 에서 이관됐다. 그 래퍼 컴포넌트가 사라지고
  //   App 이 ModalShell 을 직접 세우면서, 드로어 크롬 계약의 검증 자리도 여기가 됐다.

  it('drawer card is a full-height, left-bordered panel (ADR-0116)', async () => {
    wrap(<div>unused</div>, '/live');

    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    // Suspense 는 DOM 요소를 만들지 않으므로 본문의 부모가 곧 ModalShell 카드다.
    const card = (await screen.findByText('settings panel body')).parentElement!;
    expect(card).toHaveClass('border-l');
    expect(card).toHaveClass('h-full');
  });

  it('closes the Settings drawer on backdrop press', async () => {
    wrap(<div>unused</div>, '/live');

    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    await screen.findByText('settings panel body');
    // 백드롭 닫힘은 click 이 아니라 **mousedown** 기준이다 — click 이면 카드 안에서
    // 드래그(텍스트 선택)를 시작해 백드롭에서 놓을 때 공통 조상에서 발화해 오작동으로
    // 닫힌다(ModalShell 계약).
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '설정' }));

    expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull();
  });
});

/**
 * 테마는 사용자 단위 설정이므로 **열려 있는 탭 전체**에 걸린다. 저장소(localStorage)는
 * 원래부터 탭 공유였지만 각 탭은 그 값을 첫 페인트에 한 번 읽을 뿐이라, `/live` 딥링크로
 * 먼저 띄워 둔 탭(liveNavigate.ts 의 window.open)은 리로드 전까지 옛 테마였다.
 *
 * 배선이 App 에 있다는 것 자체가 검증 대상이다 — App 은 전 라우트를 감싸는 레이아웃
 * 라우트라 여기 한 곳이면 모든 탭이 덮인다.
 */
describe('App 테마 — 브라우저 탭 전역', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    useThemePrefsStore.setState({ themePreference: DEFAULT_THEME_PREFERENCE });
  });

  it('다른 탭이 선호를 바꾸면 리로드 없이 data-theme 가 따라온다', () => {
    useThemePrefsStore.setState({ themePreference: 'toss-light' });
    wrap(<div>unused</div>, '/study');
    expect(document.documentElement.getAttribute('data-theme')).toBe('toss-light');

    // 다른 탭의 쓰기를 재현한다. 저장소가 먼저 바뀌고 이벤트가 뒤따르는 순서가
    // 실제와 같아야 한다 — 구독은 event.newValue 가 아니라 저장소를 다시 읽는다.
    localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: 'obsidian' }));
    fireEvent(window, new StorageEvent('storage', { key: 'ui.themePreference.v1' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian');
  });

  it('auto 는 탭마다 자기 경로로 풀린다 (공유되는 것은 선호값이지 결과 테마가 아니다)', () => {
    useThemePrefsStore.setState({ themePreference: 'ledger' });
    wrap(<div>unused</div>, '/live');

    localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: 'auto' }));
    fireEvent(window, new StorageEvent('storage', { key: 'ui.themePreference.v1' }));

    // 이 탭은 /live 라 obsidian. 같은 이벤트를 받은 /study 탭은 ledger 로 푼다.
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian');
  });

  it('언마운트하면 구독을 놓는다', () => {
    useThemePrefsStore.setState({ themePreference: 'toss-light' });
    const { unmount } = wrap(<div>unused</div>, '/study');
    unmount();

    localStorage.setItem('ui.themePreference.v1', JSON.stringify({ themePreference: 'obsidian' }));
    fireEvent(window, new StorageEvent('storage', { key: 'ui.themePreference.v1' }));

    expect(useThemePrefsStore.getState().themePreference).toBe('toss-light');
  });
});
