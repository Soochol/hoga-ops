import { Suspense, lazy, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import TopNav from './nav/TopNav';
import { MarketIndexBar } from './layout/MarketIndexBar';
import { useDrawerAutoCollapse } from './layout/useDrawerAutoCollapse';
import { WORKSPACE_NAV_ITEMS } from './nav/items';
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
import { ShortcutHelpHost } from './ui/ShortcutHelpModal';
import { ToastViewport } from './ui/toast/ToastViewport';
import { useSectorTickEvents } from './api/useSectorTickEvents';
import { useSignalAlertEvents } from './signalAlerts/useSignalAlertEvents';
import { useStaticDocumentTitle } from './util/useDocumentTitle';
import { ModalShell } from './ui/ModalShell';
import { WORKSPACE_DRAWER_WIDTH_CLASS } from './live/workspaceDrawer';
import { registerSettingsModalOpener } from './live/settingsModalControls';
import { effectiveTheme, useThemePrefsStore } from './state/themePrefs';
import { useCrossTabSync } from './state/crossTabSync';

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
const SettingsSections = lazy(() => import('./live/SettingsSections'));

// 탭 제목이 nav 라벨 그대로인 라우트 표.
//
// `/settings` 는 빠졌다 — 라우트가 아니라 드로어라 탭 제목을 가질 페이지가 없다.
// `/live`·`/study` 도 빠진다 — **페이지가 제목을 소유한다**(각각 종목명 + 시세,
// 종목명 + 저장뷰 이름). 표에서 빼는 것만으로는 부족하고 아래 `staticTitle` 의
// 삼항에서도 같이 빼야 한다: 표를 못 찾으면 `?? 'hoga-ops'` 로 떨어져 App 이
// 페이지와 **경쟁하는 두 번째 writer** 가 된다.
const PAGE_OWNED_TITLE_ROUTES: ReadonlySet<string> = new Set(['/live', '/study']);
const STATIC_ROUTE_TITLES: ReadonlyMap<string, string> = new Map(
  WORKSPACE_NAV_ITEMS
    .filter((item) => !PAGE_OWNED_TITLE_ROUTES.has(item.to))
    .map((item) => [item.to, item.label] as const),
);

export default function App() {
  useEventStream();
  useSignalAlertEvents();
  // 지수·업종 실시간 오버레이. 하단 지수 바가 전 페이지에 있으므로 루트가 소유자다.
  useSectorTickEvents();
  useInventoryRecaptureOriginsCleanup();
  // Single owner of the capture-queue push subscription (was fanned out across
  // ~5 useCaptureQueue mounts); the read side now only reads the shared cache.
  useCaptureQueueSync();
  // Single owner of the screener-update push subscription; surfaces read the
  // shared ['screener-status'] cache + feedback store.
  useScreenerUpdateSync();
  // 탭 전역 설정(테마 · 거래소 · 보조지표 · LiveSettings)의 단일 구독 지점 — 다른
  // 탭에서 바꾸면 이 탭도 리로드 없이 따라온다. App 이 전 라우트를 감싸는 레이아웃
  // 라우트라(main.tsx 의 `<Route element={<App />}>`) 여기 한 번이면 `/live` 딥링크
  // 탭과 `/study` 까지 덮인다.
  useCrossTabSync();
  // 좁은 폭에서 주변부(드로어)가 코어에게 자리를 양보한다 — 셸 바닥은 드로어가
  // 닫힌 기준이라, 열린 채로 좁아지면 바닥 위에서도 TopNav 가 잘린다.
  useDrawerAutoCollapse();
  const activePanel = useRightRailStore((s) => s.activePanel);

  // The top row is fixed; the content row owns main + optional right panel +
  // fixed rail. Keeping this as a nested grid prevents panel content from
  // inflating the chart row and returns the retired side-menu width to main.
  const { pathname } = useLocation();
  const contentCols = `1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;
  const staticTitle = PAGE_OWNED_TITLE_ROUTES.has(pathname)
    ? null
    : STATIC_ROUTE_TITLES.get(pathname) ?? 'hoga-ops';
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 설정 드로어의 **유일한 소유자**다. 트리거는 앱 곳곳에 흩어져 있지만(전 라우트
  // TopNav ⚙ · `/live`·`/study` 툴바 ⚙ · 차트 창 캔들 빈 상태 · 실시간 불가 배너 ·
  // 종목검색의 「설정에서 갱신」) 전부 `requestSettingsModal()` 로 모인다. 등록 지점을
  // 늘리지 말 것 — 그 채널은 슬롯이 하나고 스택이 없다(모듈 주석 참조).
  useEffect(() => registerSettingsModalOpener(() => setSettingsOpen(true)), []);
  // 설정 본체는 앱 전역이지만 「체결창」 nav 하나만 컨텍스트로 갈린다(/live 워크스페이스
  // 전용 데이터 창). 이제 진입점이 하나라 variant 는 **경로에서만** 파생한다.
  const settingsVariant = pathname.startsWith('/study') ? 'study' : 'live';

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
      {/* 단축키 도움말 — `?` 키(전 라우트) + /live 툴바 [단축키] 버튼이 연다. */}
      <ShortcutHelpHost />
      {settingsOpen && (
        <ModalShell
          ariaLabel="설정"
          side="right"
          width={WORKSPACE_DRAWER_WIDTH_CLASS}
          onClose={() => setSettingsOpen(false)}
        >
          {/* title 없음 — 섹션 제목·닫기 X는 SettingsSections 콘텐츠 헤더가 담당.
              `/live`·`/study` 툴바 ⚙ 와 **같은 크롬**(우측 드로어 760px + nav 240px)이다:
              진입점이 달라도 폭·앵커·nav 가 같아야 「설정은 하나」가 화면에서도 참이다.
              옛 중앙 모달(720×560 하드코딩)은 이 통일로 사라졌다. */}
          <Suspense fallback={null}>
            <SettingsSections variant={settingsVariant} onClose={() => setSettingsOpen(false)} />
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
