import { lazy } from 'react';
import { Navigate, useLocation } from 'react-router';


/*
 * `/live` 만 정적(기본 라우트 — lazy 로 내리면 첫 페인트에 왕복만 추가된다).
 * 나머지는 lazy — 이 파일이 전 페이지를 정적 import 하던 동안 vite.config 의
 * manualChunks 는 **아무 효과가 없었다**: 청크로 쪼개지긴 하지만 정적 그래프에
 * 있으면 전부 modulepreload 로 즉시 페치되므로 `/live` 첫 페인트가 screener·
 * capture·inventory·heatmap 코드를 다 기다렸다.
 *
 * App.tsx 의 드로어·설정 모달도 같은 이유로 함께 lazy 여야 한다 — App 은 레이아웃
 * 라우트라 항상 로드되므로, 거기서 정적 import 하면 라우트만 lazy 로 바꿔도 초기
 * 번들이 줄지 않는다(그쪽 주석에 실측 수치).
 */
export const LandingPage = lazy(() => import('./home/LandingPage'));

export const Heatmap = lazy(() => import('./pages/Heatmap').then((m) => ({ default: m.Heatmap })));

export const Inventory = lazy(() => import('./pages/Inventory'));

export const Screener = lazy(() => import('./pages/Screener').then((m) => ({ default: m.Screener })));

export const Capture = lazy(() => import('./pages/Capture'));

export const Sentiment = lazy(() => import('./pages/Sentiment'));

export const Breadth = lazy(() => import('./breadth/BreadthPage'));

export const Market = lazy(() => import('./pages/Market'));
export const Whiteboard = lazy(() => import('./pages/Whiteboard'));


// AppErrorBoundary sits OUTSIDE the providers on purpose: a throw from the
// QueryClientProvider/BrowserRouter subtree — including anything a route
// renders — must still land somewhere that can paint. Inside them, a failure
// during provider setup would escape to the root and blank the page again.
/**
 * 옛 `/study` 북마크의 착지점.
 *
 * `<Navigate to="/live" replace />` 로는 **안 된다** — 그건 쿼리를 버리고, `/study` 의
 * 유일한 딥링크 파라미터가 하필 `?view=`(저장뷰)였다. 그대로 실어 보내면 `/live` 의
 * `useSavedRangeDeepLink` 가 같은 파라미터를 읽어 저장뷰가 열린다: 북마크가 가리키던
 * 화면이 새 페이지에서 재현된다.
 *
 * `search` 를 통째로 넘기는 것도 의도다 — 알던 키만 골라 옮기면 나중에 파라미터가
 * 늘 때 이 자리가 조용히 낡는다.
 */
export function StudyBookmarkRedirect() {
  return <Navigate to={{ pathname: '/live', search: useLocation().search }} replace />;
}
