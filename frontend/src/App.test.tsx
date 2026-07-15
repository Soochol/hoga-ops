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
  it('renders a three-row shell (top nav / content / bottom-bar auto) with no side-menu column', () => {
    const { container } = wrap(<div>Heatmap</div>, '/heatmap');
    const shell = container.firstElementChild as HTMLElement;
    const contentGrid = screen.getByTestId('app-content-grid');

    expect(screen.getByRole('navigation', { name: '주요 메뉴' })).toBeInTheDocument();
    // 3행: 하단 시장지표 바 행은 auto — 바가 null 이면 0으로 접힌다.
    expect(shell.style.gridTemplateRows).toBe('var(--h-top-nav) minmax(0, 1fr) auto');
    expect(shell.style.gridTemplateColumns).toBe('');
    expect(contentGrid).toHaveStyle({ gridTemplateColumns: '1fr var(--rail-w)' });
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
