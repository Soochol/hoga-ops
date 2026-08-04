import { Suspense, lazy, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import TopNav from './nav/TopNav';
import { MarketIndexBar } from './layout/MarketIndexBar';
import { useDrawerAutoCollapse } from './layout/useDrawerAutoCollapse';
import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './nav/items';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';
import { useCaptureQueueSync } from './capture/useCaptureQueue';
import { useScreenerUpdateSync } from './screener/useScreenerUpdateSync';
import SignalAlertToastHost from './signalAlerts/SignalAlertToastHost';
import RestUnavailableToastHost from './live/RestUnavailableToastHost';
import KiwoomFullHouseToastHost from './live/KiwoomFullHouseToastHost';
import SupervisedTaskFailureToastHost from './live/SupervisedTaskFailureToastHost';
import DiskHeadroomToastHost from './live/DiskHeadroomToastHost';
import DrawingClearToastHost from './chart/DrawingClearToastHost';
import DrawingClearConfirmHost from './chart/DrawingClearConfirmHost';
import { ToastViewport } from './ui/toast/ToastViewport';
import { useSignalAlertEvents } from './signalAlerts/useSignalAlertEvents';
import { useStaticDocumentTitle } from './util/useDocumentTitle';
import { ModalShell } from './ui/ModalShell';
import { effectiveTheme, useThemePrefsStore } from './state/themePrefs';

/*
 * 드로어·설정 모달은 **조건부 마운트**라 lazy 로 내린다.
 *
 * 이걸 안 하면 라우트만 lazy 로 바꿔도 초기 번들이 줄지 않는다: App 은 레이아웃
 * 라우트라 항상 로드되고, 여기서 정적 import 하면 heatmap·screener·study-views
 * 모듈 트리가 그대로 정적 그래프에 남아 modulepreload 로 즉시 페치된다
 * (vite.config 의 manualChunks 는 파일만 쪼개고 페치 시점은 안 바꾼다).
 * 실측 2026-07-30: 이 4개가 초기 로드 1303KB 중 heatmap 213KB + study-views 72KB
 * 를 차지했다.
 *
 * fallback 은 `null` 이다 — 로컬 서버라 청크 페치가 한 자리 ms 이고, 드로어는
 * 어차피 열릴 때 애니메이션이 있어 빈 프레임 한 장이 보이지 않는다. 스켈레톤을
 * 새로 그리는 것은 DESIGN.md 밖의 시각 요소를 발명하는 일이라 하지 않는다.
 *
 * WatchlistDrawer 는 정적 유지 — 기본 활성 패널이라 lazy 로 내리면 첫 페인트에
 * 왕복만 추가된다.
 */
const HeatmapDrawer = lazy(() =>
  import('./heatmap/HeatmapDrawer').then((m) => ({ default: m.HeatmapDrawer })),
);
const ScreenerDrawer = lazy(() =>
  import('./screener/ScreenerDrawer').then((m) => ({ default: m.ScreenerDrawer })),
);
const RankingDrawer = lazy(() =>
  import('./rightrail/RankingDrawer').then((m) => ({ default: m.RankingDrawer })),
);
const StudyViewsDrawer = lazy(() =>
  import('./studyViews/StudyViewsDrawer').then((m) => ({ default: m.StudyViewsDrawer })),
);
const SignalAlertsDrawer = lazy(() => import('./signalAlerts/SignalAlertsDrawer'));
const SettingsPanel = lazy(() =>
  import('./pages/Settings').then((m) => ({ default: m.SettingsPanel })),
);

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
  // 좁은 폭에서 주변부(드로어)가 코어에게 자리를 양보한다 — 셸 바닥은 드로어가
  // 닫힌 기준이라, 열린 채로 좁아지면 바닥 위에서도 TopNav 가 잘린다.
  useDrawerAutoCollapse();
  const activePanel = useRightRailStore((s) => s.activePanel);

  // The top row is fixed; the content row owns main + optional right panel +
  // fixed rail. Keeping this as a nested grid prevents panel content from
  // inflating the chart row and returns the retired side-menu width to main.
  const { pathname } = useLocation();
  const contentCols = `1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;
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
      // 반응형 바닥(--app-floor-min-w): 유효 폭이 바닥 미만이면 셸이 계속 눌리는 대신
      // #root 가 가로 스크롤을 얻는다(global.css). 바닥을 정하는 건 페이지 콘텐츠가
      // 아니라 전 라우트가 공유하는 셸 크롬 — TopNav 자연폭 939px + 레일 54px = 993px
      // 실측(2026-07-21, 기본 밀도). rem 토큰이라 밀도 다이얼을 따라간다.
      // w-screen(100vw) → h-full+min-w: 100vw 는 세로 스크롤바 폭을 포함해 바닥 아래에서
      // 셸이 항상 뷰포트보다 넓어진다. 이제 폭은 #root 를 따르고 바닥만 min-width 가 건다.
      className="grid h-full min-h-app-floor min-w-app-floor overflow-hidden"
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
        <RestUnavailableToastHost />
        <KiwoomFullHouseToastHost />
        {/* 운영 경보는 스택 위쪽(가장 오래 남는 자리) — 배경 태스크 사망은 프로세스
            재시작 외에 복구 수단이 없어 사용자가 놓치면 안 된다. 디스크 잠식도
            같은 부류다: 가득 차면 캡처가 조용히 실패하는데 health 는 200 이다. */}
        <SupervisedTaskFailureToastHost />
        <DiskHeadroomToastHost />
        <DrawingClearToastHost />
      </ToastViewport>
      {/* 토스트가 아니라 모달 — 뷰포트 밖에 둔다. 그리기 메뉴와 Alt+C 가 공유하는
          단 하나의 확인 게이트(자세한 사연은 호스트 주석). */}
      <DrawingClearConfirmHost />
      {settingsOpen && (
        <ModalShell
          ariaLabel="Settings"
          width="w-[min(720px,calc(100vw-48px))]"
          height="h-[min(560px,calc(100vh-80px))]"
          onClose={() => setSettingsOpen(false)}
        >
          {/* title 없음 — 섹션 제목·닫기 X는 SettingsPanel 콘텐츠 헤더가 담당(첨부 디자인).
              SettingsPanel이 다이얼로그를 edge-to-edge로 채운다(중첩 카드 제거). */}
          <Suspense fallback={null}>
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </Suspense>
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
      {/* Suspense 는 DOM 요소를 만들지 않으므로 이 열의 자동 배치가 그대로 유지된다
          (위 gridTemplateColumns 주석의 전제). */}
      {activePanel === 'watchlist' && <WatchlistDrawer />}
      {activePanel === 'heatmap' && (
        <Suspense fallback={null}><HeatmapDrawer /></Suspense>
      )}
      {activePanel === 'screener' && (
        <Suspense fallback={null}><ScreenerDrawer /></Suspense>
      )}
      {activePanel === 'ranking' && (
        <Suspense fallback={null}><RankingDrawer /></Suspense>
      )}
      {activePanel === 'savedViews' && (
        <Suspense fallback={null}><StudyViewsDrawer /></Suspense>
      )}
      {activePanel === 'signalAlerts' && (
        <Suspense fallback={null}><SignalAlertsDrawer /></Suspense>
      )}
      <RightRail />
    </div>
  );
}

function StaticDocumentTitle({ title }: { title: string }) {
  useStaticDocumentTitle(title);
  return null;
}
