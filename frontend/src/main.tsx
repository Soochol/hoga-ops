import { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { LivePage } from './live/LivePage';
import { initStudyTabsSync } from './state/studyTabs';
import AppErrorBoundary from './ui/AppErrorBoundary';
// 앱 서체(Pretendard dynamic-subset)를 번들에 내장한다 — ADR-0134 §4 (폰트
// self-host). 이전에는 index.html 이 jsdelivr CDN 을 렌더 블로킹으로 링크해,
// CDN 이 느린 날 첫 페인트 전체가 따라 늦어졌다(유일한 외부 런타임 의존).
// vite 가 이 CSS 를 entry 스타일시트로 추출해 <link> 로 싣으므로 "첫 페인트에
// 올바른 서체" 라는 렌더 블로킹 성질은 prod 빌드에서 그대로 유지된다.
// unicode-range 92분할이라 실제로 화면에 있는 글자 범위의 woff2 만 받는다.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles/global.css';

/*
 * `/live` 만 정적(기본 라우트 — lazy 로 내리면 첫 페인트에 왕복만 추가된다).
 * 나머지는 lazy — 이 파일이 전 페이지를 정적 import 하던 동안 vite.config 의
 * manualChunks 는 **아무 효과가 없었다**: 청크로 쪼개지긴 하지만 정적 그래프에
 * 있으면 전부 modulepreload 로 즉시 페치되므로 `/live` 첫 페인트가 study·screener·
 * capture·inventory·heatmap 코드를 다 기다렸다.
 *
 * App.tsx 의 드로어·설정 모달도 같은 이유로 함께 lazy 여야 한다 — App 은 레이아웃
 * 라우트라 항상 로드되므로, 거기서 정적 import 하면 라우트만 lazy 로 바꿔도 초기
 * 번들이 줄지 않는다(그쪽 주석에 실측 수치).
 */
const StudyPage = lazy(() =>
  import('./studyViews/StudyPage').then((m) => ({ default: m.StudyPage })),
);
const Heatmap = lazy(() => import('./pages/Heatmap').then((m) => ({ default: m.Heatmap })));
const Inventory = lazy(() => import('./pages/Inventory'));
const Screener = lazy(() => import('./pages/Screener').then((m) => ({ default: m.Screener })));
const Capture = lazy(() => import('./pages/Capture'));
const Sentiment = lazy(() => import('./pages/Sentiment'));
const Market = lazy(() => import('./pages/Market'));
// `/settings` **페이지는 없다** — 설정은 앱 전역 드로어 하나이고(`App` 소유), 트리거는
// 전부 `requestSettingsModal()` 로 모인다. 페이지 사본이 있던 시절엔 같은 내용이 두
// 표면으로 열렸다. 옛 북마크는 아래 라우트가 `/live` 로 받는다.


const _disposeStudyTabsSync = initStudyTabsSync();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _disposeStudyTabsSync();
  });
}

// refetchOnWindowFocus/Reconnect default to true — a tab refocus or network
// blip fires every active /live poll at once, and each sidecar refetch can
// launch the heavy peak query on the backend. Disabling both cuts that burst
// at the source (the interval polls still keep data fresh).
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Default gcTime is 5 min. Past-only /live chunks are immutable and now
      // frozen (staleTime Infinity, no poll); a longer gcTime keeps a code's
      // walk-back chunks cached across a switch-away so revisiting within the
      // window re-derives the merged history from cache, not the network.
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

// past-candles 청크·canonical 병합본은 불변(완결 과거일)이므로 전역 30분보다 오래
// 살려 "점심 후 복귀"(gcTime 초과) 시나리오에서도 네트워크 재-워크백 없이 캐시에서
// 병합 히스토리를 복원한다. 훅이 명시하는 staleTime/refetchInterval 은 우선순위가
// 높아 불변(RQ v5: 훅 옵션 > setQueryDefaults > defaultOptions) — gcTime 만 승격된다.
qc.setQueryDefaults(['live', 'past-candles'], { gcTime: 2 * 60 * 60_000 });

// range 지표(mode=hoga/sidecar) 델타의 canonical 병합본도 캔들과 동일 수명(2h)으로
// 승격 — 그래야 웜 복귀 시 캔들만 딥·지표는 얕은 비대칭이 안 생긴다. 실 청크 쿼리
// (['range', …])는 전역 30분 유지(무거운 sidecar 번들 상주 최소화); 장수명은
// identity당 1개인 병합본(['live','range-merged',identity])에만 준다. 이 prefix 는
// /study 의 useStudyRangeCacheEviction(['range'] 축출)과 겹치지 않아 왕복에도 생존.
qc.setQueryDefaults(['live', 'range-merged'], { gcTime: 2 * 60 * 60_000 });

// AppErrorBoundary sits OUTSIDE the providers on purpose: a throw from the
// QueryClientProvider/BrowserRouter subtree — including anything a route
// renders — must still land somewhere that can paint. Inside them, a failure
// during provider setup would escape to the root and blank the page again.
createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route element={<App />}>
            <Route path="/" element={<Navigate to="/live" replace />} />
            <Route path="live" element={<LivePage />} />
            {/* lazy 라우트는 각자 Suspense 로 감싼다 — App(레이아웃) 안쪽이라
                청크를 기다리는 동안에도 nav·레일·하단 바는 그대로 서 있다.
                fallback=null: 로컬 페치가 한 자리 ms 라 빈 프레임이 보이지 않고,
                스켈레톤을 새로 그리는 것은 DESIGN.md 밖의 발명이다. */}
            <Route path="study" element={<Suspense fallback={null}><StudyPage /></Suspense>} />
            <Route path="heatmap" element={<Suspense fallback={null}><Heatmap /></Suspense>} />
            <Route path="inventory" element={<Suspense fallback={null}><Inventory /></Suspense>} />
            <Route path="screener" element={<Suspense fallback={null}><Screener /></Suspense>} />
            <Route path="capture" element={<Suspense fallback={null}><Capture /></Suspense>} />
            <Route path="sentiment" element={<Suspense fallback={null}><Sentiment /></Suspense>} />
            <Route path="market" element={<Suspense fallback={null}><Market /></Suspense>} />
            {/* 옛 `/settings` 페이지 북마크를 받아 준다 — 설정이 드로어가 되면서 갈
                페이지가 없어졌는데, 라우트를 그냥 지우면 빈 화면 + "No routes matched"
                경고라 고장으로 읽힌다(실측). 드로어는 어느 라우트에서든 ⚙ 로 열린다. */}
            <Route path="settings" element={<Navigate to="/live" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </AppErrorBoundary>,
);
