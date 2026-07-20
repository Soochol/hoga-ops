import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import TopNav from './nav/TopNav';
import { MarketIndexBar } from './layout/MarketIndexBar';
import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './nav/items';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { HeatmapDrawer } from './heatmap/HeatmapDrawer';
import { ScreenerDrawer } from './screener/ScreenerDrawer';
import { StudyViewsDrawer } from './studyViews/StudyViewsDrawer';
import SignalAlertsDrawer from './signalAlerts/SignalAlertsDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';
import { useCaptureQueueSync } from './capture/useCaptureQueue';
import { useScreenerUpdateSync } from './screener/useScreenerUpdateSync';
import SignalAlertToastHost from './signalAlerts/SignalAlertToastHost';
import KisRestUnavailableToastHost from './live/KisRestUnavailableToastHost';
import DrawingClearToastHost from './chart/DrawingClearToastHost';
import { ToastViewport } from './ui/toast/ToastViewport';
import { useSignalAlertEvents } from './signalAlerts/useSignalAlertEvents';
import { useStaticDocumentTitle } from './util/useDocumentTitle';
import { ModalShell } from './ui/ModalShell';
import { SettingsPanel } from './pages/Settings';
import { effectiveTheme, useThemePrefsStore } from './state/themePrefs';

const STATIC_ROUTE_TITLES: ReadonlyMap<string, string> = new Map(
  [...WORKSPACE_NAV_ITEMS, ...SYSTEM_NAV_ITEMS]
    .filter((item) => item.to !== '/live')
    .map((item) => [item.to, item.label] as const),
);

export default function App() {
  useEventStream();
  useSignalAlertEvents();
  useInventoryRecaptureOriginsCleanup();
  // Single owner of the capture-queue push subscription (was fanned out across
  // ~5 useCaptureQueue mounts); the read side now only reads the shared cache.
  useCaptureQueueSync();
  // Single owner of the screener-update push subscription; surfaces read the
  // shared ['screener-status'] cache + feedback store.
  useScreenerUpdateSync();
  const activePanel = useRightRailStore((s) => s.activePanel);

  // The top row is fixed; the content row owns main + optional right panel +
  // fixed rail. Keeping this as a nested grid prevents panel content from
  // inflating the chart row and returns the retired side-menu width to main.
  const contentCols = `1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;
  const { pathname } = useLocation();
  const staticTitle = pathname === '/live' ? null : STATIC_ROUTE_TITLES.get(pathname) ?? 'hoga-ops';
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Keep <html data-theme> in sync with the preference + current route. The
  // index.html bootstrap sets the first-paint value; this owns every change
  // after (preference toggle in Settings, or an auto-mode route switch).
  const themePreference = useThemePrefsStore((s) => s.themePreference);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme(themePreference, pathname));
  }, [themePreference, pathname]);

  return (
    <div
      data-testid="app-content-grid"
      className="grid h-screen w-screen overflow-hidden"
      style={{
        // 열 기반 셸(2026-07-15): 우측 패널(드로어+고정 레일)이 화면 상단~하단 full-height
        // 열로 서고, 왼쪽 스택(TopNav/페이지/하단 시장지표 바)이 나머지 1fr 을 세로로 채운다.
        // 상단 헤더는 우측 패널 위 코너를 양보한다(우측 패널이 화면 맨 위까지 올라옴).
        gridTemplateColumns: contentCols,
        // 행도 반드시 명시한다. 비워두면 `grid-auto-rows: auto` 가 되고 그 트랙은 콘텐츠가
        // 원하는 만큼 커져서, `h-screen` 보다 낮은 뷰포트에서 셸이 화면 밖으로 밀린다
        // (뷰포트 260px 에서 트랙 341px). 아이템의 min-h-0 은 *트랙* 최소값을 못 푼다 —
        // 바로 아래 app-main-stack 이 같은 이유로 이미 행을 명시하고 있다(#730 과 동형).
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      {staticTitle !== null && <StaticDocumentTitle title={staticTitle} />}
      <ToastViewport>
        {/* flex-col-reverse: DOM 첫 자식이 최하단. 시그널(최신 prepend)을 먼저 둬
            새 토스트가 맨 아래에서 떠오르게 하고, KIS 경고는 스택 위쪽에 둔다. */}
        <SignalAlertToastHost />
        <KisRestUnavailableToastHost />
        <DrawingClearToastHost />
      </ToastViewport>
      {settingsOpen && (
        <ModalShell
          ariaLabel="Settings"
          width="w-[min(720px,calc(100vw-48px))]"
          height="h-[min(560px,calc(100vh-80px))]"
          onClose={() => setSettingsOpen(false)}
        >
          {/* title 없음 — 섹션 제목·닫기 X는 SettingsPanel 콘텐츠 헤더가 담당(첨부 디자인).
              SettingsPanel이 다이얼로그를 edge-to-edge로 채운다(중첩 카드 제거). */}
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        </ModalShell>
      )}
      {/* 왼쪽 스택(1fr 열): 상단 nav / 페이지 / 하단 시장지표 바 — 모두 main 너비.
          하단 바 행은 auto — 데이터 없으면(MarketIndexBar가 null) 0 으로 접힌다. */}
      <div
        data-testid="app-main-stack"
        className="grid min-h-0 min-w-0 overflow-hidden"
        style={{ gridTemplateRows: 'var(--h-top-nav) minmax(0, 1fr) auto' }}
      >
        <TopNav onOpenSettings={() => setSettingsOpen(true)} />
        <main className="overflow-hidden min-w-0"><Outlet /></main>
        <MarketIndexBar />
      </div>
      {/* 우측 패널: 드로어(열림 시) + 고정 레일 — 열 자동 배치로 왼쪽 스택 오른쪽에
          full-height 로 선다. */}
      {activePanel === 'watchlist' && <WatchlistDrawer />}
      {activePanel === 'heatmap' && <HeatmapDrawer />}
      {activePanel === 'screener' && <ScreenerDrawer />}
      {activePanel === 'savedViews' && <StudyViewsDrawer />}
      {activePanel === 'signalAlerts' && <SignalAlertsDrawer />}
      <RightRail />
    </div>
  );
}

function StaticDocumentTitle({ title }: { title: string }) {
  useStaticDocumentTitle(title);
  return null;
}
