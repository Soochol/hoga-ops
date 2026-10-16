import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles/global.css';
import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { LivePage } from './live/LivePage';
import AppErrorBoundary from './ui/AppErrorBoundary';
import DesktopConfigGate from './ui/DesktopConfigGate';
import { LandingPage, Heatmap, Inventory, Screener, Capture, Sentiment, Market, StudyBookmarkRedirect } from './mainRoutes';

// `/settings` **페이지는 없다** — 설정은 앱 전역 드로어 하나이고(`App` 소유), 트리거는
// 전부 `requestSettingsModal()` 로 모인다. 페이지 사본이 있던 시절엔 같은 내용이 두
// 표면으로 열렸다. 옛 북마크는 아래 라우트가 `/live` 로 받는다.


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
// identity당 1개인 병합본(['live','range-merged',identity])에만 준다.
qc.setQueryDefaults(['live', 'range-merged'], { gcTime: 2 * 60 * 60_000 });


// 갱신 루프 덫 — DEV 에서만. 동적 import 라 프로덕션 번들에는 들어가지 않는다
// (`import.meta.env.DEV` 가 상수 false 로 접히며 분기째 제거된다). 감시는 스토어
// `subscribe` 뿐이라 동작을 바꾸지 않는다 — 근거는 `updateLoopWatch.ts` 머리말.
if (import.meta.env.DEV && import.meta.env.MODE !== 'test') {
  void import('./state/updateLoopWatch').then((m) => m.installUpdateLoopWatch());
}


createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <DesktopConfigGate>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Suspense fallback={null}><LandingPage /></Suspense>} />
          <Route element={<App />}>
            <Route path="live" element={<LivePage />} />
            {/* lazy 라우트는 각자 Suspense 로 감싼다 — App(레이아웃) 안쪽이라
                청크를 기다리는 동안에도 nav·레일·하단 바는 그대로 서 있다.
                fallback=null: 로컬 페치가 한 자리 ms 라 빈 프레임이 보이지 않고,
                스켈레톤을 새로 그리는 것은 DESIGN.md 밖의 발명이다. */}
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
            {/* 옛 `/study` 북마크. `?view=` 를 **들고 가야** 한다 — 저장뷰 딥링크가
                거기 살았고 이제 `/live` 가 같은 파라미터를 읽는다(useSavedRangeDeepLink).
                `<Navigate to="/live">` 로는 쿼리가 버려져 북마크가 종목 없는 `/live` 에
                떨어진다. */}
            <Route path="study" element={<StudyBookmarkRedirect />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </DesktopConfigGate>
  </AppErrorBoundary>,
);
