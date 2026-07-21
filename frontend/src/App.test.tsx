import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import App from './App';
import { useRightRailStore } from './state/rightRail';

vi.mock('./api/eventStream', () => ({
  useEventStream: () => {},
  lastHeartbeat: () => 0,
  subscribeToScreenerUpdateEvents: () => () => {},
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

vi.mock('./pages/Settings', () => ({
  SettingsPanel: () => <div>settings panel body</div>,
  default: () => <div>settings page route</div>,
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
    ['/heatmap', 'Heatmap'],
    ['/screener', 'Screener'],
    ['/inventory', 'Inventory'],
    ['/capture', 'Capture'],
    ['/settings', 'Settings'],
  ])('sets %s to the matching top menu label', (path, expected) => {
    wrap(<div>{expected}</div>, path);
    expect(document.title).toBe(expected);
  });

  it('leaves /live to the LivePage title writer', () => {
    wrap(<div>unused</div>, '/live?code=005930');
    expect(document.title).toBe('before-test');
  });

  it('sets /study to the matching top menu label', () => {
    wrap(<div>unused</div>, '/study');
    expect(document.title).toBe('Study');
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

  it('mounts the heatmap drawer when the heatmap panel is active', () => {
    useRightRailStore.setState({ activePanel: 'heatmap', lastPanel: 'heatmap' });

    wrap(<div>Heatmap</div>, '/heatmap');

    expect(screen.getByTestId('app-content-grid')).toHaveStyle({
      gridTemplateColumns: '1fr var(--watchlist-panel-w) var(--rail-w)',
    });
    expect(screen.getByTestId('heatmap-drawer')).toBeInTheDocument();
  });

  it('opens Settings as a centered popover without leaving the current page', () => {
    wrap(<div>unused</div>, '/live');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveClass('fixed', 'inset-0', 'items-center', 'justify-center');
    expect(within(dialog).getByText('settings panel body')).toBeInTheDocument();
    expect(screen.getByText('live page')).toBeInTheDocument();
  });

  it('closes the Settings popover with Escape', () => {
    wrap(<div>unused</div>, '/live');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('live page')).toBeInTheDocument();
  });
});
